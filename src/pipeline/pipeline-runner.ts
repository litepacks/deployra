import fs from 'node:fs';
import path from 'node:path';
import { computeConfigHash, loadConfigFromDir, parseEnvFile } from '../config/parser.js';
import type { NormalizedDeployraConfig } from '../config/types.js';
import { RollbackManager } from '../deployment/rollback-manager.js';
import { DeployraError, PreflightError } from '../errors/deployra-error.js';
import { GitClient } from '../git/git-client.js';
import type { DeploymentJobPayload } from '../jobs/workmatic-engine.js';
import { logger } from '../logging/logger.js';
import { registerSecrets } from '../logging/masker.js';
import { NotificationService } from '../notifications/notification-service.js';
import { ReadyCheckerAdapter } from '../readiness/ready-checker-adapter.js';
import { parseCommandString, UnitupAdapter } from '../runtime/unitup-adapter.js';
import { checkDiskSpace } from '../security/disk-check.js';
import { safeExec } from '../security/exec.js';
import { DeploymentRepository } from '../storage/deployment-repository.js';
import { ProjectRepository } from '../storage/project-repository.js';
import { StateRepository } from '../storage/state-repository.js';

export class DeploymentPipelineRunner {
  private gitClient = new GitClient();
  private unitupAdapter = new UnitupAdapter();
  private readyAdapter = new ReadyCheckerAdapter();
  private rollbackManager = new RollbackManager();
  private notificationService = new NotificationService();
  private projectRepo = new ProjectRepository();
  private deploymentRepo = new DeploymentRepository();
  private stateRepo = new StateRepository();
  private activeAbortControllers = new Map<
    string,
    { controller: AbortController; projectName: string }
  >();

  public abortDeployment(deploymentId: string, reason = 'Deployment cancelled'): boolean {
    const entry = this.activeAbortControllers.get(deploymentId);
    if (entry) {
      entry.controller.abort(new Error(reason));
      this.activeAbortControllers.delete(deploymentId);
      logger.info(`Aborted running deployment #${deploymentId}: ${reason}`, { deploymentId });
      return true;
    }
    return false;
  }

  public abortAllDeploymentsForProject(
    projectName: string,
    reason = 'Newer deployment started',
  ): void {
    for (const [depId, entry] of Array.from(this.activeAbortControllers.entries())) {
      if (entry.projectName === projectName) {
        entry.controller.abort(new Error(reason));
        this.activeAbortControllers.delete(depId);
        logger.info(`Aborted active deployment #${depId} for project '${projectName}': ${reason}`, {
          project: projectName,
          deploymentId: depId,
        });
      }
    }
  }

  public async runDeployment(payload: DeploymentJobPayload): Promise<void> {
    const { deploymentId, projectName, previousSha } = payload;
    let targetSha = payload.targetSha;
    const project = this.projectRepo.getProject(projectName);

    if (!project) {
      this.deploymentRepo.updateStatus(
        deploymentId,
        'failed',
        `Project '${projectName}' not found in registry`,
      );
      return;
    }

    const abortController = new AbortController();
    this.activeAbortControllers.set(deploymentId, {
      controller: abortController,
      projectName,
    });

    let config = project.config;
    const isIsolated = config.deploy.strategy === 'isolated';
    const isRelease = config.deploy.strategy === 'release';
    const releaseRoot = config.deploy.workspacePath;
    const releasesDir = path.join(releaseRoot, 'releases');
    const releaseDir = path.join(releasesDir, deploymentId);
    const currentLink = path.join(releaseRoot, 'current');
    const workingDir = isRelease
      ? releaseDir
      : isIsolated
        ? config.deploy.workspacePath
        : project.path;
    const isDryRun = Boolean(payload.dryRun);
    let lockAcquired = false;

    const initialDep = this.deploymentRepo.getDeployment(deploymentId);
    if (initialDep?.status === 'cancelled') {
      logger.info(`Deployment #${deploymentId} was cancelled before starting.`, {
        project: projectName,
        deploymentId,
      });
      return;
    }

    this.deploymentRepo.updateStatus(deploymentId, 'running');

    try {
      // Step 1: acquire-lock
      await this.runStep(deploymentId, 'acquire-lock', async () => {
        const maxWaitMs = 3000;
        const pollIntervalMs = 100;
        const startWait = Date.now();

        while (Date.now() - startWait <= maxWaitMs) {
          lockAcquired = this.stateRepo.acquireLock(projectName, deploymentId);
          if (lockAcquired) break;
          await new Promise<void>((res) => {
            const timer = setTimeout(() => {
              clearTimeout(timer);
              res();
            }, pollIntervalMs);
          });
        }

        if (!lockAcquired) {
          throw new DeployraError(`Could not acquire deployment lock for project '${projectName}'`);
        }

        // Pre-flight disk space check
        if (!isDryRun && config.deploy.preflight?.diskCheck) {
          const diskCheck = checkDiskSpace(workingDir, {
            minFreeMb: config.deploy.preflight.minDiskFreeMb,
            maxUsagePercent: config.deploy.preflight.maxDiskUsagePercent,
          });
          if (diskCheck.warning) {
            logger.warn(`[PRE-FLIGHT] ${diskCheck.warning}`, {
              project: projectName,
              deploymentId,
            });
          }
          if (!diskCheck.ok && diskCheck.error) {
            throw new PreflightError(`Pre-flight disk check failed: ${diskCheck.error}`);
          }
        }
      });

      // Step 2: validate-repository
      await this.runStep(deploymentId, 'validate-repository', async () => {
        await this.validateAndPrepareRepository(
          workingDir,
          project.path,
          config,
          isIsolated,
          isRelease,
          isDryRun,
        );
      });

      // Step 3: fetch
      await this.runStep(deploymentId, 'fetch', async () => {
        if (isDryRun) {
          logger.info(
            `[DRY-RUN] Simulated fetch for remote '${config.source.remote}' branch '${config.source.branch}'`,
            { project: projectName, deploymentId },
          );
        } else {
          await this.gitClient.fetchBranch(workingDir, config.source.remote, config.source.branch);
        }
      });

      // Step 4: resolve-target
      await this.runStep(deploymentId, 'resolve-target', async () => {
        if (isDryRun && targetSha) {
          logger.info(`[DRY-RUN] Target SHA resolved: ${targetSha}`, {
            project: projectName,
            deploymentId,
          });
          return;
        }
        const resolvedHead = await this.gitClient.checkRemoteHead(
          workingDir,
          config.source.remote,
          config.source.branch,
        );
        if (resolvedHead) {
          targetSha = resolvedHead;
        } else if (!targetSha) {
          throw new DeployraError(
            `Target SHA could not be resolved for branch '${config.source.branch}'`,
          );
        }
      });

      // Step 5: prepare
      await this.runStep(deploymentId, 'prepare', async () => {
        if (isDryRun) {
          logger.info(
            `[DRY-RUN] Would reset repository workspace at '${workingDir}' to target SHA '${targetSha}'`,
            { project: projectName, deploymentId },
          );
        } else {
          await this.gitClient.resetHard(workingDir, targetSha);
        }
      });

      // Step 5.5: refresh-config
      await this.runStep(deploymentId, 'refresh-config', async () => {
        if (!isDryRun) {
          const updatedConfig = this.reloadConfigFromWorkingDir(workingDir, config);
          if (updatedConfig) {
            config = updatedConfig;
          }
        }
      });

      if (config.deploy.service.stopBeforeBuild && !isDryRun && !isRelease) {
        logger.info(`Stopping service '${config.deploy.service.name}' before build steps...`);
        try {
          await this.unitupAdapter.stop(config.deploy.service.name);
        } catch {
          // Ignore if service was not running
        }
      }

      // Step 6+: Execute dynamic command steps (install, build, etc.)
      await this.executeBuildCommands(
        deploymentId,
        projectName,
        workingDir,
        project.path,
        config,
        isIsolated,
        isRelease,
        isDryRun,
        abortController.signal,
      );

      // Step 7.5: activate-release (only for strategy === 'release')
      if (isRelease) {
        await this.runStep(deploymentId, 'activate-release', async () => {
          if (abortController.signal.aborted) {
            throw new DeployraError('Deployment was aborted before activate-release');
          }
          if (isDryRun) {
            logger.info(`[DRY-RUN] Would atomically symlink '${currentLink}' -> '${releaseDir}'`, {
              project: projectName,
              deploymentId,
            });
            return;
          }

          const tmpLink = path.join(releaseRoot, `current.tmp.${deploymentId}`);
          try {
            if (fs.existsSync(tmpLink) || fs.lstatSync(tmpLink).isSymbolicLink()) {
              fs.unlinkSync(tmpLink);
            }
          } catch {
            // ignore if not exists
          }

          fs.symlinkSync(releaseDir, tmpLink, 'dir');
          fs.renameSync(tmpLink, currentLink);

          logger.info(`Activated release '${deploymentId}' at '${currentLink}'`, {
            project: projectName,
            deploymentId,
            releaseDir,
          });
        });
      }

      // Step 8: service-action
      await this.runStep(deploymentId, 'service-action', async () => {
        if (abortController.signal.aborted) {
          throw new DeployraError('Deployment was aborted before service-action');
        }
        const serviceCwd = isRelease ? currentLink : project.path;
        await this.performServiceAction(serviceCwd, config, isDryRun);
      });

      // Step 9: ready-check
      await this.runStep(deploymentId, 'ready-check', async () => {
        if (abortController.signal.aborted) {
          throw new DeployraError('Deployment was aborted before ready-check');
        }
        if (config.deploy.ready.checks.length > 0) {
          if (isDryRun) {
            logger.info(
              `[DRY-RUN] Simulated ${config.deploy.ready.checks.length} readiness check(s)`,
              { project: projectName, deploymentId },
            );
            this.deploymentRepo.updateReadyCheckResult(deploymentId, {
              dryRun: true,
              simulated: true,
              checksCount: config.deploy.ready.checks.length,
            });
          } else {
            const res = await this.readyAdapter.wait(config.deploy.ready);
            this.deploymentRepo.updateReadyCheckResult(deploymentId, res);
          }
        }
      });

      // Step 9.5: cleanup-releases (only for strategy === 'release')
      if (isRelease) {
        await this.runStep(deploymentId, 'cleanup-releases', async () => {
          if (abortController.signal.aborted) {
            return;
          }
          if (isDryRun) {
            logger.info(
              `[DRY-RUN] Would prune old releases keeping last ${config.deploy.releasesToKeep}`,
              {
                project: projectName,
                deploymentId,
              },
            );
            return;
          }

          const releasesToKeep = Math.max(1, config.deploy.releasesToKeep ?? 5);
          if (!fs.existsSync(releasesDir)) return;

          const entries: Array<{ name: string; path: string; mtime: number }> = [];
          for (const d of fs.readdirSync(releasesDir, { withFileTypes: true })) {
            if (d.isDirectory()) {
              const fullPath = path.join(releasesDir, d.name);
              entries.push({
                name: d.name,
                path: fullPath,
                mtime: fs.statSync(fullPath).mtimeMs,
              });
            }
          }
          entries.sort((a, b) => b.mtime - a.mtime);

          let activeTarget: string | null = null;
          try {
            if (fs.existsSync(currentLink)) {
              activeTarget = fs.realpathSync(currentLink);
            }
          } catch {
            // ignore
          }

          for (let i = releasesToKeep; i < entries.length; i++) {
            const rel = entries[i];
            if (rel && rel.path !== activeTarget) {
              try {
                fs.rmSync(rel.path, { recursive: true, force: true });
                logger.info(`Pruned old release directory: ${rel.name}`, {
                  project: projectName,
                  release: rel.name,
                });
              } catch (rmErr: any) {
                logger.warn(`Failed to prune release directory ${rel.name}: ${rmErr.message}`);
              }
            }
          }
        });
      }

      // Step 10: complete
      await this.runStep(deploymentId, 'complete', async () => {
        if (abortController.signal.aborted) {
          throw new DeployraError('Deployment was aborted before complete');
        }
        if (!isDryRun) {
          this.projectRepo.updateLastSuccessfulSha(projectName, targetSha);
        } else {
          logger.info(
            `[DRY-RUN] Skipping production lastSuccessfulSha update for project '${projectName}'`,
            { project: projectName, deploymentId },
          );
        }
        this.deploymentRepo.updateStatus(deploymentId, 'success');
        logger.info(
          `${isDryRun ? '[DRY-RUN] ' : ''}Deployment #${deploymentId} successfully completed for project '${projectName}'!`,
          { project: projectName, deploymentId, dryRun: isDryRun },
        );

        const depRecord = this.deploymentRepo.getDeployment(deploymentId);
        const durationMs = depRecord?.startedAt ? Date.now() - depRecord.startedAt : undefined;
        await this.notificationService.sendDeploymentNotification(config, {
          projectName,
          deploymentId,
          status: 'success',
          targetSha: targetSha || 'unknown',
          previousSha,
          durationMs,
          triggerType: payload.triggerType,
          dryRun: isDryRun,
        });
      });
    } catch (err: any) {
      const currentDep = this.deploymentRepo.getDeployment(deploymentId);
      const isCancelled =
        currentDep?.status === 'cancelled' ||
        abortController.signal.aborted ||
        Boolean(err.message?.toLowerCase().includes('cancelled'));

      this.abortDeployment(deploymentId, err.message || 'Deployment failed');

      if (isCancelled) {
        if (currentDep?.status !== 'cancelled') {
          this.deploymentRepo.updateStatus(
            deploymentId,
            'cancelled',
            err.message || 'Deployment cancelled',
          );
        }
        logger.info(`Deployment #${deploymentId} was cancelled for project '${projectName}'.`, {
          project: projectName,
          deploymentId,
        });
      } else {
        await this.handleDeploymentFailure(
          deploymentId,
          projectName,
          targetSha,
          previousSha ?? project.lastSuccessfulSha,
          config,
          lockAcquired,
          err,
        );
      }
    } finally {
      this.activeAbortControllers.delete(deploymentId);
      // Step 11: release-lock (Always executed)
      try {
        await this.runStep(deploymentId, 'release-lock', async () => {
          if (lockAcquired) {
            this.stateRepo.releaseLock(projectName, deploymentId);
          }
        });
      } catch {
        // Ignore release lock cleanup errors
      }
    }
  }

  private async validateAndPrepareRepository(
    workingDir: string,
    projectPath: string,
    config: NormalizedDeployraConfig,
    isIsolated: boolean,
    isRelease = false,
    isDryRun = false,
  ): Promise<void> {
    if (isDryRun) {
      logger.info(
        `[DRY-RUN] Validating repository structure at '${workingDir}' (no changes will be applied)`,
      );
      return;
    }
    if (isIsolated || isRelease) {
      if (!fs.existsSync(workingDir)) {
        fs.mkdirSync(workingDir, { recursive: true });
      }
      if (!fs.existsSync(path.join(workingDir, '.git'))) {
        const remoteUrlResult = await safeExec('git', ['remote', 'get-url', config.source.remote], {
          cwd: projectPath,
        });
        const remoteUrl = remoteUrlResult.stdout.trim();

        await safeExec('git', ['init'], { cwd: workingDir });
        await safeExec('git', ['remote', 'add', config.source.remote, remoteUrl], {
          cwd: workingDir,
        });
      }
    }

    await this.gitClient.validateRepository(workingDir, config.source.remote);

    const dirty = await this.gitClient.isDirty(workingDir);
    if (dirty) {
      if (config.deploy.dirtyWorkspace === 'reject') {
        throw new DeployraError(
          `Dirty target repository workspace at '${workingDir}'. Commit or stash changes before deploying, or set deploy.dirtyWorkspace to 'reset'.`,
        );
      } else if (config.deploy.dirtyWorkspace === 'reset') {
        await this.gitClient.resetHard(workingDir, 'HEAD');
        await this.gitClient.cleanUntracked(workingDir);
      } else if (config.deploy.dirtyWorkspace === 'stash') {
        await this.gitClient.stashChanges(workingDir);
      }
    }
  }

  private resolveDeploymentEnv(
    workingDir: string,
    config: NormalizedDeployraConfig,
  ): Record<string, string> {
    let fileEnv: Record<string, string> = {};

    if (config.deploy.envFile) {
      let envFilePath = config.deploy.envFile;
      if (!path.isAbsolute(envFilePath)) {
        const candidateInWorking = path.resolve(workingDir, envFilePath);
        const candidateInProject = path.resolve(config.project.path, envFilePath);
        envFilePath = fs.existsSync(candidateInWorking) ? candidateInWorking : candidateInProject;
      }
      fileEnv = parseEnvFile(envFilePath);
    }

    const merged = { ...fileEnv, ...config.deploy.env };
    // Automatically register all values into secret masker so they are NEVER logged in cleartext
    registerSecrets(merged);
    return merged;
  }

  private async executeBuildCommands(
    deploymentId: string,
    projectName: string,
    workingDir: string,
    projectPath: string,
    config: NormalizedDeployraConfig,
    isIsolated: boolean,
    isRelease = false,
    isDryRun = false,
    signal?: AbortSignal,
  ): Promise<void> {
    const executionEnv = this.resolveDeploymentEnv(workingDir, config);

    for (const [stepName, cmdList] of Object.entries(config.deploy.commands)) {
      if (Array.isArray(cmdList) && cmdList.length > 0) {
        await this.runStep(deploymentId, stepName, async () => {
          if (signal?.aborted) {
            throw new DeployraError(`Deployment was aborted before step '${stepName}'`);
          }

          if (stepName === 'install' && !isDryRun && !isRelease) {
            // Stop service before install to release file handles on node_modules
            try {
              await this.unitupAdapter.stop(config.deploy.service.name);
            } catch {
              // Service may already be stopped — safe to ignore
            }
          }

          const stepOutputs: string[] = [];
          for (const cmdStr of cmdList) {
            if (signal?.aborted) {
              throw new DeployraError(`Deployment was aborted before command: '${cmdStr}'`);
            }
            const cmdOut = await this.executeCommandWithRetry(
              cmdStr,
              workingDir,
              config.deploy.retry,
              isDryRun,
              config.deploy.timeoutMs,
              signal,
              executionEnv,
            );
            if (cmdOut) {
              stepOutputs.push(`$ ${cmdStr}\n${cmdOut}`);
            }
          }

          if (stepName === 'build' && isIsolated) {
            if (isDryRun) {
              logger.info(
                `[DRY-RUN] Would sync built artifacts from isolated workspace '${workingDir}' to target '${projectPath}'`,
                { project: projectName, deploymentId },
              );
            } else {
              logger.info(
                `Syncing built artifacts from isolated workspace '${workingDir}' to target '${projectPath}'`,
                { project: projectName, deploymentId },
              );
              await this.syncIsolatedWorkspace(workingDir, projectPath);
            }
          }

          return stepOutputs.join('\n\n');
        });
      }
    }
  }

  private async performServiceAction(
    projectPath: string,
    config: NormalizedDeployraConfig,
    isDryRun = false,
  ): Promise<void> {
    const action = config.deploy.service.action;
    const svcName = config.deploy.service.name;
    const svcOpts = {
      cwd: projectPath,
      script: config.deploy.service.script,
      command: config.deploy.service.command,
      memoryMax: config.deploy.service.memoryMax,
      memoryHigh: config.deploy.service.memoryHigh,
      cpuQuota: config.deploy.service.cpuQuota,
      restartSec: config.deploy.service.restartSec,
    };

    if (isDryRun) {
      logger.info(
        `[DRY-RUN] Would execute service action '${action}' on systemd service '${svcName}' (cwd: ${projectPath})`,
        { service: svcName, action, opts: svcOpts },
      );
      return;
    }

    if (action === 'start') {
      await this.unitupAdapter.start(svcName, svcOpts);
    } else if (action === 'restart') {
      await this.unitupAdapter.restart(svcName, svcOpts);
    } else if (action === 'reload') {
      await this.unitupAdapter.reload(svcName, svcOpts);
    }
  }

  private async handleDeploymentFailure(
    deploymentId: string,
    projectName: string,
    targetSha: string,
    prevSha: string | undefined,
    config: NormalizedDeployraConfig,
    lockAcquired: boolean,
    err: any,
  ): Promise<void> {
    logger.error(`Deployment #${deploymentId} failed at step: ${err.message}`, {
      project: projectName,
      deploymentId,
    });

    this.deploymentRepo.updateStatus(deploymentId, 'failed', err.message);

    // Trigger rollback if previous successful SHA exists or if release strategy is active, lock was acquired, and rollback enabled
    const canRollback =
      lockAcquired &&
      config.deploy.rollback.enabled &&
      ((prevSha && prevSha !== targetSha) || config.deploy.strategy === 'release');

    const depRecord = this.deploymentRepo.getDeployment(deploymentId);
    const durationMs = depRecord?.startedAt ? Date.now() - depRecord.startedAt : undefined;

    if (canRollback) {
      try {
        this.deploymentRepo.updateStatus(deploymentId, 'rolling_back');
        await this.rollbackManager.rollback({
          projectName,
          projectPath: config.project.path,
          previousSuccessfulSha: prevSha,
          deploymentId,
          config,
        });
        this.deploymentRepo.updateStatus(deploymentId, 'rolled_back');
        await this.notificationService.sendDeploymentNotification(config, {
          projectName,
          deploymentId,
          status: 'rolled_back',
          targetSha: targetSha || 'unknown',
          previousSha: prevSha,
          durationMs,
          error: err.message,
        });
      } catch (rollbackErr: any) {
        logger.error(`Rollback failed for deployment #${deploymentId}: ${rollbackErr.message}`, {
          project: projectName,
          deploymentId,
        });
        this.deploymentRepo.updateStatus(deploymentId, 'rollback_failed', rollbackErr.message);
        await this.notificationService.sendDeploymentNotification(config, {
          projectName,
          deploymentId,
          status: 'failed',
          targetSha: targetSha || 'unknown',
          previousSha: prevSha,
          durationMs,
          error: `Deployment and rollback failed: ${err.message} (Rollback: ${rollbackErr.message})`,
        });
      }
    } else {
      await this.notificationService.sendDeploymentNotification(config, {
        projectName,
        deploymentId,
        status: 'failed',
        targetSha: targetSha || 'unknown',
        previousSha: prevSha,
        durationMs,
        error: err.message,
      });
    }
  }

  private async runStep(
    deploymentId: string,
    stepName: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    const startTime = Date.now();
    this.deploymentRepo.updateStep(deploymentId, stepName, {
      status: 'running',
      startedAt: startTime,
    });

    const currentDep = this.deploymentRepo.getDeployment(deploymentId);
    if (currentDep?.status === 'cancelled') {
      throw new DeployraError(`Deployment #${deploymentId} was cancelled`);
    }

    try {
      const stepOutput = await action();
      const duration = Date.now() - startTime;
      this.deploymentRepo.updateStep(deploymentId, stepName, {
        status: 'success',
        completedAt: Date.now(),
        duration,
        exitCode: 0,
        output: typeof stepOutput === 'string' ? stepOutput : undefined,
      });
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const errorOutput = err.stderr || (typeof err.output === 'string' ? err.output : undefined);
      this.deploymentRepo.updateStep(deploymentId, stepName, {
        status: 'failed',
        completedAt: Date.now(),
        duration,
        exitCode: err.exitCode ?? 1,
        output: errorOutput,
        error: err.message,
      });
      throw err;
    }
  }

  private async executeCommandWithRetry(
    cmdStr: string,
    cwd: string,
    retryConfig: { attempts: number; backoffMs: number },
    isDryRun = false,
    timeoutMs?: number,
    signal?: AbortSignal,
    env?: Record<string, string>,
  ): Promise<string> {
    if (isDryRun) {
      logger.info(`[DRY-RUN] Would execute command: '${cmdStr}' in working directory '${cwd}'`);
      return `[DRY-RUN] Simulated execution: ${cmdStr}`;
    }
    const parsed = parseCommandString(cmdStr);
    const cmd = parsed.command;
    const args = parsed.args || [];
    const maxAttempts = retryConfig.attempts + 1;

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) {
        throw new DeployraError(`Command '${cmdStr}' aborted`);
      }
      try {
        const res = await safeExec(cmd, args, {
          cwd,
          timeoutMs,
          signal,
          env: {
            CI: 'true',
            FORCE_COLOR: '0',
            ...env,
          },
        });
        return [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
      } catch (err: any) {
        lastErr = err;

        if (signal?.aborted) {
          throw err;
        }

        if (attempt < maxAttempts) {
          logger.warn(
            `Command '${cmdStr}' failed (attempt ${attempt}/${maxAttempts}). Retrying in ${retryConfig.backoffMs}ms...`,
          );
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              clearTimeout(timer);
              resolve();
            }, retryConfig.backoffMs);
          });
        }
      }
    }
    throw lastErr;
  }

  private reloadConfigFromWorkingDir(
    workingDir: string,
    currentConfig: NormalizedDeployraConfig,
  ): NormalizedDeployraConfig | null {
    try {
      const freshConfig = loadConfigFromDir(workingDir);
      if (freshConfig) {
        const freshHash = computeConfigHash(freshConfig);
        if (freshHash !== currentConfig.configHash) {
          const savedProj = this.projectRepo.saveProject(freshConfig);
          logger.info(
            `Detected updated Deployra configuration at commit (version v${savedProj.configVersion}, hash ${savedProj.configHash}). Updating active pipeline settings.`,
            {
              project: currentConfig.project.name,
              configVersion: savedProj.configVersion,
              configHash: savedProj.configHash,
            },
          );
          return savedProj.config;
        }
        return freshConfig;
      }
    } catch (err: any) {
      logger.warn(
        `Could not reload configuration from working directory '${workingDir}': ${err.message}`,
      );
      throw new DeployraError(
        `Failed to load updated deployra config at target commit: ${err.message}`,
      );
    }
    return null;
  }

  private async syncIsolatedWorkspace(sourceDir: string, targetDir: string): Promise<void> {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    try {
      await safeExec('rsync', [
        '-av',
        '--delete',
        '--exclude=.git',
        `${sourceDir}/`,
        `${targetDir}/`,
      ]);
    } catch {
      fs.cpSync(sourceDir, targetDir, {
        recursive: true,
        force: true,
        filter: (src) => !src.includes('/.git'),
      });
    }
  }
}
