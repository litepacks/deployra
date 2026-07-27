import { GitClient } from '../git/git-client.js';
import { UnitupAdapter } from '../runtime/unitup-adapter.js';
import { ReadyCheckerAdapter } from '../readiness/ready-checker-adapter.js';
import { RollbackManager } from '../deployment/rollback-manager.js';
import { ProjectRepository } from '../storage/project-repository.js';
import { DeploymentRepository } from '../storage/deployment-repository.js';
import { StateRepository } from '../storage/state-repository.js';
import { safeExec } from '../security/exec.js';
import { logger } from '../logging/logger.js';
import { GitshipError } from '../errors/gitship-error.js';
import type { DeploymentJobPayload } from '../jobs/workmatic-engine.js';

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
    const projectPath = project.path;
    let lockAcquired = false;

    this.deploymentRepo.updateStatus(deploymentId, 'running');

    try {
      // Step 1: acquire-lock
      await this.runStep(deploymentId, 'acquire-lock', async () => {
        lockAcquired = this.stateRepo.acquireLock(projectName, deploymentId);
        if (!lockAcquired) {
          throw new GitshipError(`Could not acquire deployment lock for project '${projectName}'`);
        }
      });

      // Step 2: validate-repository
      await this.runStep(deploymentId, 'validate-repository', async () => {
        await this.gitClient.validateRepository(projectPath, config.source.remote);

        const dirty = await this.gitClient.isDirty(projectPath);
        if (dirty) {
          if (config.deploy.dirtyWorkspace === 'reject') {
            throw new GitshipError(
              `Repository at '${projectPath}' has uncommitted changes (dirtyWorkspace: reject)`,
            );
          } else if (config.deploy.dirtyWorkspace === 'reset') {
            await this.gitClient.resetHard(projectPath, 'HEAD');
            await this.gitClient.cleanUntracked(projectPath);
          } else if (config.deploy.dirtyWorkspace === 'stash') {
            await this.gitClient.stashChanges(projectPath);
          }
        }
      });

      // Step 3: fetch
      await this.runStep(deploymentId, 'fetch', async () => {
        await this.gitClient.fetchBranch(projectPath, config.source.remote, config.source.branch);
      });

      // Step 4: resolve-target
      await this.runStep(deploymentId, 'resolve-target', async () => {
        const resolvedHead = await this.gitClient.checkRemoteHead(
          projectPath,
          config.source.remote,
          config.source.branch,
        );
        if (!resolvedHead && !targetSha) {
          throw new GitshipError(
            `Target SHA could not be resolved for branch '${config.source.branch}'`,
          );
        }
      });

      // Step 5: prepare
      await this.runStep(deploymentId, 'prepare', async () => {
        await this.gitClient.resetHard(projectPath, targetSha);
      });

      // Step 6: install (with command retry if configured)
      await this.runStep(deploymentId, 'install', async () => {
        for (const cmdStr of config.deploy.commands.install) {
          await this.executeCommandWithRetry(cmdStr, projectPath, config.deploy.retry);
        }
      });

      // Step 7: build
      await this.runStep(deploymentId, 'build', async () => {
        for (const cmdStr of config.deploy.commands.build) {
          await this.executeCommandWithRetry(cmdStr, projectPath, config.deploy.retry);
        }
      });

      // Step 8: service-action
      await this.runStep(deploymentId, 'service-action', async () => {
        const action = config.deploy.service.action;
        const svcName = config.deploy.service.name;

        if (action === 'start') {
          await this.unitupAdapter.start(svcName);
        } else if (action === 'restart') {
          await this.unitupAdapter.restart(svcName);
        } else if (action === 'reload') {
          await this.unitupAdapter.reload(svcName);
        }
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
          {
            project: projectName,
            deploymentId,
          },
        );
      });
    } catch (err: any) {
      logger.error(`Deployment #${deploymentId} failed at step: ${err.message}`, {
        project: projectName,
        deploymentId,
      });

      this.deploymentRepo.updateStatus(deploymentId, 'failed', err.message);

      // Trigger rollback if previous successful SHA exists and rollback enabled
      const prevSha = previousSha || project.lastSuccessfulSha;
      if (config.deploy.rollback.enabled && prevSha && prevSha !== targetSha) {
        try {
          this.deploymentRepo.updateStatus(deploymentId, 'rolling_back');
          await this.rollbackManager.rollback({
            projectName,
            projectPath,
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
}
