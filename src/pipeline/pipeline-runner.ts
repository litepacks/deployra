import fs from 'node:fs';
import path from 'node:path';
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

    const config = project.config;
    const isIsolated = config.deploy.strategy === 'isolated';
    const workingDir = isIsolated ? config.deploy.workspacePath : project.path;
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
        await this.validateAndPrepareRepository(workingDir, project.path, config, isIsolated);
      });

      // Step 3: fetch
      await this.runStep(deploymentId, 'fetch', async () => {
        await this.gitClient.fetchBranch(workingDir, config.source.remote, config.source.branch);
      });

      // Step 4: resolve-target
      await this.runStep(deploymentId, 'resolve-target', async () => {
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
        await this.gitClient.resetHard(workingDir, targetSha);
      });

      // Step 6+: Execute dynamic command steps (install, build, etc.)
      await this.executeBuildCommands(
        deploymentId,
        projectName,
        workingDir,
        project.path,
        config,
        isIsolated,
      );

      // Step 8: service-action
      await this.runStep(deploymentId, 'service-action', async () => {
        await this.performServiceAction(project.path, config);
      });

      // Step 9: ready-check
      await this.runStep(deploymentId, 'ready-check', async () => {
        if (config.deploy.ready.checks.length > 0) {
          const res = await this.readyAdapter.wait(config.deploy.ready);
          this.deploymentRepo.updateReadyCheckResult(deploymentId, res);
        }
      });

      // Step 10: complete
      await this.runStep(deploymentId, 'complete', async () => {
        this.projectRepo.updateLastSuccessfulSha(projectName, targetSha);
        this.deploymentRepo.updateStatus(deploymentId, 'success');
        logger.info(
          `Deployment #${deploymentId} successfully completed for project '${projectName}'!`,
          { project: projectName, deploymentId },
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
  ): Promise<void> {
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
  ): Promise<void> {
    for (const [stepName, cmdList] of Object.entries(config.deploy.commands)) {
      if (Array.isArray(cmdList) && cmdList.length > 0) {
        await this.runStep(deploymentId, stepName, async () => {
          for (const cmdStr of cmdList) {
            await this.executeCommandWithRetry(cmdStr, workingDir, config.deploy.retry);
          }

          if (stepName === 'build' && isIsolated) {
            logger.info(
              `Syncing built artifacts from isolated workspace '${workingDir}' to target '${projectPath}'`,
              { project: projectName, deploymentId },
            );
            await this.syncIsolatedWorkspace(workingDir, projectPath);
          }
        });
      }
    }
  }

  private async performServiceAction(
    projectPath: string,
    config: NormalizedDeployraConfig,
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
  ): Promise<void> {
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
