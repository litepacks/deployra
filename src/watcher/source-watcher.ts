import { nanoid } from 'nanoid';
import { GitClient } from '../git/git-client.js';
import type { WorkmaticEngine } from '../jobs/workmatic-engine.js';
import { logger } from '../logging/logger.js';
import { DeploymentRepository } from '../storage/deployment-repository.js';
import { ProjectRepository, type StoredProject } from '../storage/project-repository.js';

export class SourceWatcher {
  private gitClient = new GitClient();
  private projectRepo = new ProjectRepository();
  private deploymentRepo = new DeploymentRepository();
  private workmaticEngine: WorkmaticEngine;

  private timers = new Map<string, NodeJS.Timeout>();
  private errorCounts = new Map<string, number>();

  constructor(workmaticEngine: WorkmaticEngine) {
    this.workmaticEngine = workmaticEngine;
  }

  public async start(targetProjectName?: string): Promise<void> {
    const projects = targetProjectName
      ? ([this.projectRepo.getProject(targetProjectName)].filter(Boolean) as StoredProject[])
      : this.projectRepo.getAllProjects();

    if (projects.length === 0) {
      logger.warn(
        targetProjectName
          ? `Project '${targetProjectName}' not found in registry.`
          : 'No projects found in Deployra registry to watch.',
      );
      return;
    }

    for (const proj of projects) {
      logger.info(
        `Started monitoring project '${proj.name}' (${proj.remote}/${proj.branch}) every ${proj.config.watch.intervalMs}ms`,
        { project: proj.name },
      );
      this.scheduleNextCheck(proj.name, 0);
    }
  }

  public async stop(): Promise<void> {
    for (const [name, timer] of this.timers.entries()) {
      clearTimeout(timer);
      logger.info(`Stopped watcher for project '${name}'`, { project: name });
    }
    this.timers.clear();
    this.errorCounts.clear();
  }

  public async checkProject(
    projectName: string,
    triggerType: 'poll' | 'manual' | 'webhook' = 'poll',
  ): Promise<string | null> {
    const proj = this.projectRepo.getProject(projectName);
    if (!proj) {
      logger.error(`Cannot check project '${projectName}': not found`);
      return null;
    }

    try {
      const remoteSha = await this.gitClient.checkRemoteHead(proj.path, proj.remote, proj.branch);
      this.errorCounts.set(projectName, 0); // Reset error count on success

      if (!remoteSha) {
        logger.warn(`Could not retrieve remote HEAD SHA for project '${projectName}'`, {
          project: projectName,
        });
        return null;
      }

      this.projectRepo.updateLastSeenSha(projectName, remoteSha);

      // Prevent re-deploying same commit SHA unless manual trigger
      if (
        triggerType === 'poll' &&
        remoteSha === proj.lastSeenSha &&
        remoteSha === proj.lastSuccessfulSha
      ) {
        logger.debug(`No change detected for project '${projectName}' (SHA: ${remoteSha})`, {
          project: projectName,
        });
        return null;
      }

      logger.info(
        `New commit detected for '${projectName}': ${remoteSha} (previous: ${proj.lastSuccessfulSha || 'none'})`,
        {
          project: projectName,
        },
      );

      // Handle Queue modes: latest, fifo, reject
      const queueMode = proj.config.deploy.queueMode;
      const activeDeps = this.deploymentRepo.getActiveDeployments(projectName);

      if (activeDeps.length > 0) {
        if (queueMode === 'reject') {
          logger.warn(
            `Rejecting new deployment for project '${projectName}' because another deployment is active (queueMode: reject)`,
            {
              project: projectName,
            },
          );
          return null;
        } else if (queueMode === 'latest') {
          await this.workmaticEngine.cancelPendingJobsForProject(projectName);
        }
      }

      // Create deployment record
      const deploymentId = `dep_${nanoid(10)}`;
      this.deploymentRepo.createDeployment({
        id: deploymentId,
        projectName: proj.name,
        previousSha: proj.lastSuccessfulSha,
        targetSha: remoteSha,
        status: 'queued',
        triggerType,
      });

      // Enqueue job via Workmatic
      await this.workmaticEngine.enqueueDeployJob({
        deploymentId,
        projectName: proj.name,
        previousSha: proj.lastSuccessfulSha,
        targetSha: remoteSha,
        triggerType,
        triggeredAt: Date.now(),
      });

      return deploymentId;
    } catch (err: any) {
      const count = (this.errorCounts.get(projectName) || 0) + 1;
      this.errorCounts.set(projectName, count);

      logger.error(
        `Watcher network/check error for '${projectName}' (consecutive errors: ${count}): ${err.message}`,
        {
          project: projectName,
        },
      );
      throw err;
    }
  }

  private scheduleNextCheck(projectName: string, errorCount = 0): void {
    const proj = this.projectRepo.getProject(projectName);
    if (!proj) return;

    let baseInterval = proj.config.watch.intervalMs;

    // Apply exponential backoff with jitter on consecutive errors
    if (errorCount > 0) {
      const backoffMultiplier = Math.min(2 ** errorCount, 16);
      const jitter = Math.random() * 1000;
      baseInterval = baseInterval * backoffMultiplier + jitter;
    }

    const timer = setTimeout(async () => {
      let currentErrorCount = this.errorCounts.get(projectName) || 0;
      try {
        await this.checkProject(projectName, 'poll');
        currentErrorCount = 0;
      } catch {
        currentErrorCount = (this.errorCounts.get(projectName) || 0) + 1;
      } finally {
        this.scheduleNextCheck(projectName, currentErrorCount);
      }
    }, baseInterval);

    this.timers.set(projectName, timer);
  }
}
