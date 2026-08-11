import { nanoid } from 'nanoid';
import { computeConfigHash, loadConfigFromDir } from '../config/parser.js';
import { isUrlLike } from '../config/schema.js';
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
  private checkingProjects = new Set<string>();

  private syncTimer?: NodeJS.Timeout;
  private targetProjectName?: string;
  private isDryRun = false;

  constructor(workmaticEngine: WorkmaticEngine) {
    this.workmaticEngine = workmaticEngine;
  }

  public async start(targetProjectName?: string, dryRun = false): Promise<void> {
    this.targetProjectName = targetProjectName;
    this.isDryRun = dryRun;
    await this.syncProjects();

    // Periodically re-sync registry every 5 seconds to pick up new/removed projects dynamically
    this.syncTimer = setInterval(() => {
      this.syncProjects().catch((err) => {
        logger.error(`Error auto-syncing projects in watcher: ${err.message}`);
      });
    }, 5000);
  }

  public async stop(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
    for (const [name, timer] of this.timers.entries()) {
      clearTimeout(timer);
      logger.info(`Stopped watcher for project '${name}'`, { project: name });
    }
    this.timers.clear();
    this.errorCounts.clear();
    this.checkingProjects.clear();
  }

  public async syncProjects(): Promise<void> {
    const allProjects = this.targetProjectName
      ? ([this.projectRepo.getProject(this.targetProjectName)].filter(Boolean) as StoredProject[])
      : this.projectRepo.getAllProjects();

    const currentProjectNames = new Set(allProjects.map((p) => p.name));

    // Remove watchers for deleted projects
    for (const [name, timer] of Array.from(this.timers.entries())) {
      if (!currentProjectNames.has(name)) {
        clearTimeout(timer);
        this.timers.delete(name);
        this.errorCounts.delete(name);
        this.checkingProjects.delete(name);
        logger.info(`Stopped monitoring removed project '${name}'`, { project: name });
      }
    }

    // Add watchers for newly registered projects
    let index = 0;
    for (const proj of allProjects) {
      if (!this.timers.has(proj.name)) {
        if (isUrlLike(proj.name)) {
          logger.warn(
            `Project name '${proj.name}' appears to be a Git repository URL. Consider using a clean identifier (e.g. 'my-app') for project.name in deployra.config.yaml.`,
            { project: proj.name },
          );
        }
        logger.info(
          `Started monitoring project '${proj.name}' (${proj.remote}/${proj.branch}) every ${proj.config.watch.intervalMs}ms`,
          { project: proj.name },
        );
        // Stagger initial check (e.g. 0ms, 250ms, 500ms...) to avoid thundering herd on startup
        const initialDelay = index * 250;
        this.scheduleNextCheck(proj.name, 0, initialDelay);
        index++;
      }
    }
  }

  public async checkProject(
    projectName: string,
    triggerType: 'poll' | 'manual' | 'webhook' = 'poll',
    dryRun = false,
  ): Promise<string | null> {
    if (this.checkingProjects.has(projectName)) {
      logger.debug(
        `Check for project '${projectName}' is already in progress. Skipping concurrent check.`,
      );
      return null;
    }

    let proj = this.projectRepo.getProject(projectName);
    if (!proj) {
      logger.error(`Cannot check project '${projectName}': not found`);
      return null;
    }

    this.checkingProjects.add(projectName);

    try {
      // Refresh config from disk if updated
      try {
        const diskConfig = loadConfigFromDir(proj.path);
        if (diskConfig) {
          const diskHash = computeConfigHash(diskConfig);
          if (diskHash !== proj.configHash) {
            proj = this.projectRepo.saveProject(diskConfig);
            logger.info(
              `Detected config change on disk for project '${projectName}' (version v${proj.configVersion}, hash ${proj.configHash})`,
              { project: projectName },
            );
          }
        }
      } catch {
        // Ignore disk config read errors on polling check
      }

      const remoteSha = await this.gitClient.checkRemoteHead(proj.path, proj.remote, proj.branch);
      this.errorCounts.set(projectName, 0); // Reset error count on success

      if (!remoteSha) {
        logger.warn(`Could not retrieve remote HEAD SHA for project '${projectName}'`, {
          project: projectName,
        });
        return null;
      }

      // Helper for SHA comparison (handles full 40-char SHA vs short 7-char SHA)
      const isSameSha = (sha1?: string, sha2?: string) => {
        if (!sha1 || !sha2) return false;
        return sha1 === sha2 || sha1.startsWith(sha2) || sha2.startsWith(sha1);
      };

      const activeDeps = this.deploymentRepo.getActiveDeployments(projectName);

      // Prevent re-deploying same commit SHA on polling if unchanged or already active
      if (triggerType === 'poll') {
        if (isSameSha(remoteSha, proj.lastSeenSha)) {
          logger.debug(`No change detected for project '${projectName}' (SHA: ${remoteSha})`, {
            project: projectName,
          });
          return null;
        }

        const latestDep = this.deploymentRepo.getLatestDeployment(projectName);
        if (latestDep && isSameSha(latestDep.targetSha, remoteSha)) {
          logger.info(
            `Latest deployment #${latestDep.id} for project '${projectName}' already targeted commit SHA ${remoteSha} (status: ${latestDep.status}). Skipping duplicate polling trigger.`,
            { project: projectName, deploymentId: latestDep.id },
          );
          this.projectRepo.updateLastSeenSha(projectName, remoteSha);
          return null;
        }

        const existingSameShaDep = activeDeps.find((dep) => isSameSha(dep.targetSha, remoteSha));
        if (existingSameShaDep) {
          logger.info(
            `Deployment #${existingSameShaDep.id} for project '${projectName}' (target SHA: ${remoteSha}) is already ${existingSameShaDep.status}. Skipping duplicate deployment creation.`,
            { project: projectName, deploymentId: existingSameShaDep.id },
          );
          return null;
        }
      }

      this.projectRepo.updateLastSeenSha(projectName, remoteSha);

      logger.info(
        `${dryRun ? '[DRY-RUN] ' : ''}New commit detected for '${projectName}': ${remoteSha} (previous: ${proj.lastSuccessfulSha || 'none'})`,
        {
          project: projectName,
        },
      );

      // Handle Queue modes: latest, fifo, reject
      const queueMode = proj.config.deploy.queueMode;

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
        dryRun,
      });

      // Enqueue job via Workmatic
      await this.workmaticEngine.enqueueDeployJob({
        deploymentId,
        projectName: proj.name,
        previousSha: proj.lastSuccessfulSha,
        targetSha: remoteSha,
        triggerType,
        dryRun,
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
    } finally {
      this.checkingProjects.delete(projectName);
    }
  }

  private scheduleNextCheck(projectName: string, errorCount = 0, initialDelayMs?: number): void {
    const proj = this.projectRepo.getProject(projectName);
    if (!proj) return;

    let baseInterval = initialDelayMs !== undefined ? initialDelayMs : proj.config.watch.intervalMs;

    // Apply small desynchronization jitter (+0..500ms) to prevent lockstep timer alignment across projects
    if (initialDelayMs === undefined && errorCount === 0) {
      baseInterval += Math.floor(Math.random() * 500);
    }

    // Apply exponential backoff with jitter on consecutive errors
    if (errorCount > 0) {
      const backoffMultiplier = Math.min(2 ** errorCount, 16);
      const jitter = Math.random() * 1000;
      baseInterval = baseInterval * backoffMultiplier + jitter;
    }

    const timer = setTimeout(async () => {
      let currentErrorCount = this.errorCounts.get(projectName) || 0;
      try {
        await this.checkProject(projectName, 'poll', this.isDryRun);
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
