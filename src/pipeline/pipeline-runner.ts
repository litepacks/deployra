import fs from 'node:fs';
import path from 'node:path';
import { computeConfigHash, loadConfigFromDir } from '../config/parser.js';
import type { NormalizedDeployraConfig } from '../config/types.js';
import { RollbackManager } from '../deployment/rollback-manager.js';
import { DeployraError } from '../errors/deployra-error.js';
import { GitClient } from '../git/git-client.js';
import type { DeploymentJobPayload } from '../jobs/workmatic-engine.js';
import { logger } from '../logging/logger.js';
import { ReadyCheckerAdapter } from '../readiness/ready-checker-adapter.js';
import { UnitupAdapter } from '../runtime/unitup-adapter.js';
import { safeExec } from '../security/exec.js';
import { DeploymentRepository } from '../storage/deployment-repository.js';
import { ProjectRepository } from '../storage/project-repository.js';
import { StateRepository } from '../storage/state-repository.js';

export class DeploymentPipelineRunner {
  private gitClient = new GitClient();
  private unitupAdapter = new UnitupAdapter();
  private readyAdapter = new ReadyCheckerAdapter();
  private rollbackManager = new RollbackManager();
  private projectRepo = new ProjectRepository();
  private deploymentRepo = new DeploymentRepository();
  private stateRepo = new StateRepository();

  public async runDeployment(payload: DeploymentJobPayload): Promise<void> {
    const { deploymentId, projectName, targetSha, previousSha } = payload;
    const project = this.projectRepo.getProject(projectName);

    if (!project) {
      this.deploymentRepo.updateStatus(
        deploymentId,
        'failed',
        `Project '${projectName}' not found in registry`,
      );
      return;
    }

    let config = project.config;
    const isIsolated = config.deploy.strategy === 'isolated';
    const workingDir = isIsolated ? config.deploy.workspacePath : project.path;
    const isDryRun = Boolean(payload.dryRun);
    let lockAcquired = false;

    this.deploymentRepo.updateStatus(deploymentId, 'running');

    try {
      // Step 1: acquire-lock
      await this.runStep(deploymentId, 'acquire-lock', async () => {
        lockAcquired = this.stateRepo.acquireLock(projectName, deploymentId);
        if (!lockAcquired) {
          throw new DeployraError(`Could not acquire deployment lock for project '${projectName}'`);
        }
      });

      // Step 2: validate-repository
      await this.runStep(deploymentId, 'validate-repository', async () => {
        await this.validateAndPrepareRepository(
          workingDir,
          project.path,
          config,
          isIsolated,
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
        if (!resolvedHead && !targetSha) {
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

      // Step 6+: Execute dynamic command steps (install, build, etc.)
      await this.executeBuildCommands(
        deploymentId,
        projectName,
        workingDir,
        project.path,
        config,
        isIsolated,
        isDryRun,
      );

      // Step 8: service-action
      await this.runStep(deploymentId, 'service-action', async () => {
        await this.performServiceAction(project.path, config, isDryRun);
      });

      // Step 9: ready-check
      await this.runStep(deploymentId, 'ready-check', async () => {
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

      // Step 10: complete
      await this.runStep(deploymentId, 'complete', async () => {
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
      });
    } catch (err: any) {
      await this.handleDeploymentFailure(
        deploymentId,
        projectName,
        targetSha,
        previousSha ?? project.lastSuccessfulSha,
        config,
        lockAcquired,
        err,
      );
    } finally {
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
    isDryRun = false,
  ): Promise<void> {
    if (isDryRun) {
      logger.info(
        `[DRY-RUN] Validating repository structure at '${workingDir}' (no changes will be applied)`,
      );
      return;
    }
    if (isIsolated) {
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

  private async executeBuildCommands(
    deploymentId: string,
    projectName: string,
    workingDir: string,
    projectPath: string,
    config: NormalizedDeployraConfig,
    isIsolated: boolean,
    isDryRun = false,
  ): Promise<void> {
    for (const [stepName, cmdList] of Object.entries(config.deploy.commands)) {
      if (Array.isArray(cmdList) && cmdList.length > 0) {
        await this.runStep(deploymentId, stepName, async () => {
          for (const cmdStr of cmdList) {
            await this.executeCommandWithRetry(cmdStr, workingDir, config.deploy.retry, isDryRun);
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

    // Trigger rollback if previous successful SHA exists, lock was acquired, and rollback enabled
    if (lockAcquired && config.deploy.rollback.enabled && prevSha && prevSha !== targetSha) {
      try {
        this.deploymentRepo.updateStatus(deploymentId, 'rolling_back');
        await this.rollbackManager.rollback({
          projectName,
          projectPath: config.project.path,
          previousSuccessfulSha: prevSha,
          config,
        });
        this.deploymentRepo.updateStatus(deploymentId, 'rolled_back');
      } catch (rollbackErr: any) {
        logger.error(`Rollback failed for deployment #${deploymentId}: ${rollbackErr.message}`, {
          project: projectName,
          deploymentId,
        });
        this.deploymentRepo.updateStatus(deploymentId, 'rollback_failed', rollbackErr.message);
      }
    }
  }

  private async runStep(
    deploymentId: string,
    stepName: string,
    action: () => Promise<void>,
  ): Promise<void> {
    const startTime = Date.now();
    this.deploymentRepo.updateStep(deploymentId, stepName, {
      status: 'running',
      startedAt: startTime,
    });

    try {
      await action();
      const duration = Date.now() - startTime;
      this.deploymentRepo.updateStep(deploymentId, stepName, {
        status: 'success',
        completedAt: Date.now(),
        duration,
        exitCode: 0,
      });
    } catch (err: any) {
      const duration = Date.now() - startTime;
      this.deploymentRepo.updateStep(deploymentId, stepName, {
        status: 'failed',
        completedAt: Date.now(),
        duration,
        exitCode: err.exitCode ?? 1,
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
  ): Promise<void> {
    if (isDryRun) {
      logger.info(`[DRY-RUN] Would execute command: '${cmdStr}' in working directory '${cwd}'`);
      return;
    }
    const parts = cmdStr.split(' ');
    const cmd = parts[0];
    const args = parts.slice(1);
    const maxAttempts = retryConfig.attempts + 1;

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await safeExec(cmd, args, { cwd });
        return;
      } catch (err: any) {
        lastErr = err;
        if (attempt < maxAttempts) {
          logger.warn(
            `Command '${cmdStr}' failed (attempt ${attempt}/${maxAttempts}). Retrying in ${retryConfig.backoffMs}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryConfig.backoffMs));
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
