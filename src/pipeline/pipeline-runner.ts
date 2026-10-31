import fs from 'node:fs';
import path from 'node:path';
import { computeConfigHash, loadConfigFromDir } from '../config/parser.js';
import type { NormalizedDeployraConfig } from '../config/types.js';
import {
  buildCommandEnv,
  resolveDeploymentEnv,
  resolveServiceEnv,
} from '../deployment/deploy-env.js';
import { RollbackManager } from '../deployment/rollback-manager.js';
import {
  createDeploymentProgress,
  type DeploymentProgress,
  isServiceAffected,
  isZeroDowntimeEnabled,
} from '../deployment/strategy.js';
import { resolveSyncExcludes, syncIsolatedWorkspace } from '../deployment/workspace-sync.js';
import { DeployraError, PreflightError } from '../errors/deployra-error.js';
import { GitClient } from '../git/git-client.js';
import type { DeploymentJobPayload } from '../jobs/workmatic-engine.js';
import { logger } from '../logging/logger.js';
import { NotificationService } from '../notifications/notification-service.js';
import { ReadyCheckerAdapter } from '../readiness/ready-checker-adapter.js';
import { parseCommandString, UnitupAdapter } from '../runtime/unitup-adapter.js';
import { checkDiskSpace } from '../security/disk-check.js';
import { safeExec } from '../security/exec.js';
import { checkZeroDowntimePort } from '../security/port-check.js';
import { DeploymentRepository } from '../storage/deployment-repository.js';
import { ProjectRepository } from '../storage/project-repository.js';
import { StateRepository } from '../storage/state-repository.js';

export const MAX_STEP_OUTPUT_CHARS = 250_000;
export const LOCK_HEARTBEAT_MS = 30_000;

export function truncateStepOutput(output: string, maxChars = MAX_STEP_OUTPUT_CHARS): string {
  if (!output || output.length <= maxChars) {
    return output;
  }
  const notice = `\n[... output truncated to last ${Math.round(maxChars / 1000)}KB ...]\n`;
  const sliceLen = Math.max(0, maxChars - notice.length);
  return notice + output.slice(-sliceLen);
}

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
    // critical: the deployment has started changing the live service and must not be
    // superseded halfway; explicit cancellation is still allowed.
    { controller: AbortController; projectName: string; critical: boolean }
  >();

  public getCriticalDeploymentIds(projectName: string): string[] {
    return Array.from(this.activeAbortControllers.entries())
      .filter(([, entry]) => entry.projectName === projectName && entry.critical)
      .map(([id]) => id);
  }

  private markCritical(deploymentId: string): void {
    const entry = this.activeAbortControllers.get(deploymentId);
    if (entry) entry.critical = true;
  }

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
        if (entry.critical) {
          logger.info(
            `Deployment #${depId} for project '${projectName}' is already changing the live service; letting it finish before the newer deployment runs.`,
            { project: projectName, deploymentId: depId },
          );
          continue;
        }
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
      critical: false,
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
    let lockHeartbeat: NodeJS.Timeout | undefined;
    const progress = createDeploymentProgress();

    const initialStatus = this.deploymentRepo.getDeploymentStatus(deploymentId);
    if (initialStatus === 'cancelled') {
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

        lockHeartbeat = setInterval(() => {
          try {
            this.stateRepo.refreshLock(projectName, deploymentId);
          } catch {
            // Best effort; a missed heartbeat only shortens the stale window
          }
        }, LOCK_HEARTBEAT_MS);
        lockHeartbeat.unref?.();

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

        // Pre-flight zero-downtime port check
        if (!isDryRun) {
          await this.runPortPreflight(config, projectName, deploymentId);
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
          progress.workspaceMutated = true;
          await this.gitClient.resetHard(workingDir, targetSha);
        }
      });

      // Step 5.5: refresh-config
      await this.runStep(deploymentId, 'refresh-config', async () => {
        if (!isDryRun) {
          const updatedConfig = this.reloadConfigFromWorkingDir(workingDir, config);
          if (updatedConfig) {
            const changed = updatedConfig.configHash !== config.configHash;
            config = updatedConfig;
            // The committed config may change port or strategy: re-validate against it
            if (changed) {
              await this.runPortPreflight(config, projectName, deploymentId);
            }
          }
        }
      });

      if (config.deploy.service.stopBeforeBuild && !isDryRun && !isRelease) {
        if (isZeroDowntimeEnabled(config)) {
          logger.warn(
            `Ignoring deploy.service.stopBeforeBuild for '${config.deploy.service.name}': stopping the supervisor would cause downtime in zero-downtime mode.`,
            { project: projectName, deploymentId },
          );
        } else {
          logger.info(`Stopping service '${config.deploy.service.name}' before build steps...`);
          this.markCritical(deploymentId);
          progress.serviceStopped = true;
          try {
            await this.unitupAdapter.stop(config.deploy.service.name);
          } catch {
            // Ignore if service was not running
          }
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
        progress,
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

          this.markCritical(deploymentId);
          fs.symlinkSync(releaseDir, tmpLink, 'dir');
          fs.renameSync(tmpLink, currentLink);
          progress.releaseActivated = true;

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
        if (!isDryRun) {
          this.markCritical(deploymentId);
          progress.serviceActionStarted = true;
        }
        const serviceCwd = isRelease ? currentLink : project.path;
        return await this.performServiceAction(serviceCwd, config, isDryRun, payload);
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

        const startedAt = this.deploymentRepo.getDeploymentStartedAt(deploymentId);
        const durationMs = startedAt ? Date.now() - startedAt : undefined;
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
      const currentStatus = this.deploymentRepo.getDeploymentStatus(deploymentId);
      const isCancelled = currentStatus === 'cancelled' || abortController.signal.aborted;

      this.abortDeployment(deploymentId, err.message || 'Deployment failed');

      if (isCancelled) {
        if (currentStatus !== 'cancelled') {
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
        // Cancelled after the service was touched (e.g. stopped for install): restore it
        if (!isDryRun && lockAcquired && isServiceAffected(progress)) {
          await this.restoreAfterCancellation(
            deploymentId,
            projectName,
            previousSha ?? project.lastSuccessfulSha,
            config,
            progress,
          );
        }
        if (isRelease) {
          this.cleanupOrphanRelease(releaseDir, currentLink, deploymentId, projectName);
        }
      } else {
        await this.handleDeploymentFailure(
          deploymentId,
          projectName,
          targetSha,
          previousSha ?? project.lastSuccessfulSha,
          config,
          lockAcquired,
          err,
          progress,
        );
      }
    } finally {
      if (lockHeartbeat) clearInterval(lockHeartbeat);
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

  private async runPortPreflight(
    config: NormalizedDeployraConfig,
    projectName: string,
    deploymentId: string,
  ): Promise<void> {
    if (!(config.deploy.preflight?.portCheck ?? true)) return;
    const publicPort = config.deploy.port || config.deploy.service.port;
    if (!isZeroDowntimeEnabled(config) || !publicPort) return;

    const portResult = await checkZeroDowntimePort(config.deploy.service.name, publicPort);
    if (!portResult.ok && portResult.error) {
      throw new PreflightError(portResult.error);
    }
    if (portResult.warning) {
      logger.warn(`[PRE-FLIGHT] ${portResult.warning}`, {
        project: projectName,
        deploymentId,
      });
    }

    const cmd = config.deploy.service.command || '';
    const script = config.deploy.service.script || '';
    const combined = `${cmd} ${script}`;
    const portRegex = new RegExp(`\\bPORT\\s*=\\s*${publicPort}\\b|--port[=\\s]+${publicPort}\\b`);
    if (portRegex.test(combined)) {
      logger.warn(
        `[PRE-FLIGHT] Service command appears to set a hardcoded port (${publicPort}). In zero-downtime mode, the application MUST listen on dynamically assigned process.env.PORT!`,
        { project: projectName, service: config.deploy.service.name, port: publicPort },
      );
    }
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
    progress?: DeploymentProgress,
  ): Promise<void> {
    const executionEnv = resolveDeploymentEnv(workingDir, config);
    // A zero-downtime supervisor keeps serving the old generation from memory; stopping it
    // here would take the site down and break supervisor ownership of the public port.
    const shouldStopForInstall = !isDryRun && !isRelease && !isZeroDowntimeEnabled(config);

    for (const [stepName, cmdList] of Object.entries(config.deploy.commands)) {
      if (Array.isArray(cmdList) && cmdList.length > 0) {
        await this.runStep(deploymentId, stepName, async () => {
          if (signal?.aborted) {
            throw new DeployraError(`Deployment was aborted before step '${stepName}'`);
          }

          if (stepName === 'install' && shouldStopForInstall) {
            // Stop service before install to release file handles on node_modules
            this.markCritical(deploymentId);
            if (progress) progress.serviceStopped = true;
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
              await syncIsolatedWorkspace(
                workingDir,
                projectPath,
                resolveSyncExcludes([...config.deploy.syncExclude, config.deploy.envFile]),
              );
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
    payload?: DeploymentJobPayload,
  ): Promise<string | undefined> {
    const isZeroDowntime = isZeroDowntimeEnabled(config);
    const action = config.deploy.service.action;
    const svcName = config.deploy.service.name;
    const serviceEnv = resolveServiceEnv(config, projectPath);

    if (isZeroDowntime) {
      if (isDryRun) {
        logger.info(
          `[DRY-RUN] Would execute zero-downtime deployment for '${svcName}' (publicPort: ${config.deploy.port || config.deploy.service.port || 'default'}, cwd: ${projectPath})`,
          { service: svcName, zeroDowntime: true },
        );
        return `[DRY-RUN] Simulated zero-downtime deploy for '${svcName}'`;
      }

      // Determine readyPath from config.deploy.ready
      let readyPath: string | undefined;
      const httpCheck = config.deploy.ready.checks.find(
        (c) => c.type === 'http' || c.type === 'https',
      );
      if (httpCheck && 'url' in httpCheck) {
        try {
          const parsedUrl = new URL(httpCheck.url);
          readyPath = parsedUrl.pathname + parsedUrl.search;
        } catch {
          readyPath = httpCheck.url.startsWith('/') ? httpCheck.url : undefined;
        }
      }

      const canaryEnabled = Boolean(
        payload?.canary !== undefined ? payload.canary : config.deploy.canary.enabled,
      );
      const canaryWeight =
        payload?.canaryWeight !== undefined ? payload.canaryWeight : config.deploy.canary.weight;

      const zdResult = await this.unitupAdapter.deployZeroDowntime(svcName, {
        cwd: projectPath,
        script: config.deploy.service.script,
        command: config.deploy.service.command,
        publicPort: config.deploy.port || config.deploy.service.port,
        readyPath,
        readinessTimeout: config.deploy.ready?.timeoutMs,
        drainTimeout: config.deploy.drainTimeoutMs,
        canary: canaryEnabled,
        canaryWeight,
        ...serviceEnv,
      });

      const outMsg = zdResult.isCanary
        ? `Canary generation #${zdResult.currentGeneration} deployed with weight ${zdResult.canaryWeight} (active: #${zdResult.previousGeneration || 'none'}, downtime: 0ms)`
        : `Generation #${zdResult.currentGeneration} activated (previous: #${zdResult.previousGeneration || 'none'}, downtime: ${zdResult.downtimeMs}ms)`;

      logger.info(`[ZERO-DOWNTIME] ${outMsg}`, {
        service: svcName,
        generation: zdResult.currentGeneration,
        previousGeneration: zdResult.previousGeneration,
        downtimeMs: zdResult.downtimeMs,
      });

      return outMsg;
    }

    const svcOpts = {
      cwd: projectPath,
      script: config.deploy.service.script,
      command: config.deploy.service.command,
      memoryMax: config.deploy.service.memoryMax,
      memoryHigh: config.deploy.service.memoryHigh,
      cpuQuota: config.deploy.service.cpuQuota,
      restartSec: config.deploy.service.restartSec,
      ...serviceEnv,
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
    progress: DeploymentProgress = createDeploymentProgress(),
  ): Promise<void> {
    logger.error(`Deployment #${deploymentId} failed at step: ${err.message}`, {
      project: projectName,
      deploymentId,
    });

    this.deploymentRepo.updateStatus(deploymentId, 'failed', err.message);

    const isZeroDowntime = isZeroDowntimeEnabled(config);
    const serviceAffected = isServiceAffected(progress);

    // Roll back only what this deployment changed: nothing before the workspace reset
    // (e.g. a pre-flight failure) and no generation switch unless the service action ran.
    const canRollback =
      lockAcquired &&
      config.deploy.rollback.enabled &&
      (progress.workspaceMutated || serviceAffected) &&
      ((prevSha && prevSha !== targetSha) ||
        config.deploy.strategy === 'release' ||
        (isZeroDowntime && progress.serviceActionStarted));

    const startedAt = this.deploymentRepo.getDeploymentStartedAt(deploymentId);
    const durationMs = startedAt ? Date.now() - startedAt : undefined;

    if (canRollback) {
      try {
        this.deploymentRepo.updateStatus(deploymentId, 'rolling_back');
        await this.rollbackManager.rollback({
          projectName,
          projectPath: config.project.path,
          previousSuccessfulSha: prevSha,
          deploymentId,
          config,
          serviceAffected,
          revertGeneration: progress.serviceActionStarted,
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

    if (config.deploy.strategy === 'release') {
      const releasesDir = path.join(config.deploy.workspacePath, 'releases');
      const releaseDir = path.join(releasesDir, deploymentId);
      const currentLink = path.join(config.deploy.workspacePath, 'current');
      this.cleanupOrphanRelease(releaseDir, currentLink, deploymentId, projectName);
    }
  }

  private async restoreAfterCancellation(
    deploymentId: string,
    projectName: string,
    prevSha: string | undefined,
    config: NormalizedDeployraConfig,
    progress: DeploymentProgress,
  ): Promise<void> {
    if (!config.deploy.rollback.enabled) {
      logger.warn(
        `Deployment #${deploymentId} was cancelled after touching service '${config.deploy.service.name}' and rollback is disabled; the service may need a manual restart.`,
        { project: projectName, deploymentId },
      );
      return;
    }
    try {
      await this.rollbackManager.rollback({
        projectName,
        projectPath: config.project.path,
        previousSuccessfulSha: prevSha,
        deploymentId,
        config,
        serviceAffected: true,
        revertGeneration: progress.serviceActionStarted,
      });
    } catch (rollbackErr: any) {
      logger.error(
        `Could not restore service after cancelling deployment #${deploymentId}: ${rollbackErr.message}`,
        { project: projectName, deploymentId },
      );
    }
  }

  private cleanupOrphanRelease(
    releaseDir: string,
    currentLink: string,
    deploymentId: string,
    projectName: string,
  ): void {
    if (!fs.existsSync(releaseDir)) return;
    try {
      let isCurrentTarget = false;
      if (fs.existsSync(currentLink)) {
        try {
          const realTarget = fs.realpathSync(currentLink);
          const realRelease = fs.realpathSync(releaseDir);
          isCurrentTarget = realTarget === realRelease;
        } catch {
          isCurrentTarget = false;
        }
      }
      if (!isCurrentTarget) {
        fs.rmSync(releaseDir, { recursive: true, force: true });
        logger.info(
          `Cleaned up failed/cancelled release directory '${deploymentId}' for project '${projectName}'`,
          { project: projectName, deploymentId },
        );
      }
    } catch (err: any) {
      logger.warn(`Could not clean up release directory '${releaseDir}': ${err.message}`);
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

    const currentStatus = this.deploymentRepo.getDeploymentStatus(deploymentId);
    if (currentStatus === 'cancelled') {
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
        output: typeof stepOutput === 'string' ? truncateStepOutput(stepOutput) : undefined,
      });
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const errorOutput = err.stderr || (typeof err.output === 'string' ? err.output : undefined);
      this.deploymentRepo.updateStep(deploymentId, stepName, {
        status: 'failed',
        completedAt: Date.now(),
        duration,
        exitCode: err.exitCode ?? 1,
        output: errorOutput ? truncateStepOutput(errorOutput) : undefined,
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
          env: buildCommandEnv(env ?? {}),
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
}
