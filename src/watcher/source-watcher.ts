import { nanoid } from 'nanoid';
import { computeConfigHash, loadConfigFromDir } from '../config/parser.js';
import { isUrlLike } from '../config/schema.js';
import { GitClient } from '../git/git-client.js';
import type { WorkmaticEngine } from '../jobs/workmatic-engine.js';
import { logger } from '../logging/logger.js';
import { computeDeploymentSteps, DeploymentRepository } from '../storage/deployment-repository.js';
import { ProjectRepository, type StoredProject } from '../storage/project-repository.js';

export class SourceWatcher {
  private gitClient = new GitClient();
  private projectRepo = new ProjectRepository();
  private deploymentRepo = new DeploymentRepository();
  private workmaticEngine: WorkmaticEngine;

  private timers = new Map<string, NodeJS.Timeout>();
  private errorCounts = new Map<string, number>();
  private checkingProjects = new Set<string>();
  private lastCheckTimestamps = new Map<string, number>();

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

    // Periodically re-sync registry every 5 seconds to pick up new/removed projects dynamically & heal stalled timers
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
    this.lastCheckTimestamps.clear();
  }

  public async syncProjects(): Promise<void> {
    const allProjects = this.targetProjectName
      ? ([this.projectRepo.getProject(this.targetProjectName)].filter(Boolean) as StoredProject[])
      : this.projectRepo.getAllProjects();

    const currentProjectNames = new Set(allProjects.map((p) => p.name));
    const now = Date.now();

    // Remove watchers for deleted projects
    for (const [name, timer] of Array.from(this.timers.entries())) {
      if (!currentProjectNames.has(name)) {
        clearTimeout(timer);
        this.timers.delete(name);
        this.errorCounts.delete(name);
        this.checkingProjects.delete(name);
        this.lastCheckTimestamps.delete(name);
        logger.info(`Stopped monitoring removed project '${name}'`, { project: name });
      }
    }

    // Add or repair watchers for registered projects
    let index = 0;
    for (const proj of allProjects) {
      const existingTimer = this.timers.get(proj.name);
      const lastCheck = this.lastCheckTimestamps.get(proj.name) || 0;
      const expectedInterval = proj.config.watch.intervalMs || 10000;
      const isStalled = lastCheck > 0 && now - lastCheck > Math.max(expectedInterval * 4, 30000);

      if (!existingTimer || isStalled) {
        if (isStalled) {
          logger.warn(
            `[SELF-REPAIR] Watcher for project '${proj.name}' was stalled (${Math.round((now - lastCheck) / 1000)}s since last check). Reviving timer...`,
            { project: proj.name },
          );
          if (existingTimer) {
            clearTimeout(existingTimer);
            this.timers.delete(proj.name);
          }
        }

        if (!existingTimer && !isStalled) {
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
        }

        const initialDelay = isStalled ? 0 : index * 250;
        this.scheduleNextCheck(proj.name, 0, initialDelay);
        index++;
      }
    }
  }

  private countRecentFailedAttempts(projectName: string, targetSha: string): number {
    const recent = this.deploymentRepo.getDeploymentsByProject(projectName, 10);
    return recent.filter(
      (d) =>
        (d.targetSha === targetSha ||
          d.targetSha.startsWith(targetSha) ||
          targetSha.startsWith(d.targetSha)) &&
        ['failed', 'rolled_back', 'rollback_failed'].includes(d.status),
    ).length;
  }

  public async checkProject(
    projectName: string,
    triggerType: 'poll' | 'manual' | 'webhook' = 'poll',
    dryRun = false,
    explicitTargetSha?: string,
    canaryOptions?: { canary?: boolean; canaryWeight?: number | string },
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
    this.lastCheckTimestamps.set(projectName, Date.now());

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

      const remoteSha =
        explicitTargetSha ||
        (await this.gitClient.checkRemoteHead(proj.path, proj.remote, proj.branch));
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

      // Deduplication & Self-Repair logic on polling
      if (triggerType === 'poll') {
        const existingSameShaDep = activeDeps.find((dep) => isSameSha(dep.targetSha, remoteSha));
        if (existingSameShaDep) {
          logger.info(
            `Deployment #${existingSameShaDep.id} for project '${projectName}' (target SHA: ${remoteSha}) is already ${existingSameShaDep.status}. Skipping duplicate deployment creation.`,
            { project: projectName, deploymentId: existingSameShaDep.id },
          );
          return null;
        }

        const latestDep = this.deploymentRepo.getLatestDeployment(projectName);
        if (latestDep && isSameSha(latestDep.targetSha, remoteSha)) {
          if (latestDep.status === 'success') {
            if (proj.lastSeenSha !== remoteSha) {
              this.projectRepo.updateLastSeenSha(projectName, remoteSha);
            }
            logger.debug(`No change detected for project '${projectName}' (SHA: ${remoteSha})`, {
              project: projectName,
            });
            return null;
          }

          // If latest deployment failed/rolled back, attempt self-repair retry after cooldown (up to 3 retries)
          if (
            ['failed', 'rolled_back', 'rollback_failed', 'cancelled'].includes(latestDep.status)
          ) {
            const depCompletedAt = latestDep.completedAt || latestDep.createdAt;
            const cooldownMs = 60000; // 60s cooldown between retries of failed commit
            const failedCount = this.countRecentFailedAttempts(projectName, remoteSha);

            if (failedCount >= 3) {
              // Max auto-retries reached for this failed commit
              if (proj.lastSeenSha !== remoteSha) {
                this.projectRepo.updateLastSeenSha(projectName, remoteSha);
              }
              return null;
            }

            if (Date.now() - depCompletedAt < cooldownMs) {
              return null;
            }

            logger.warn(
              `[SELF-REPAIR] Latest deployment #${latestDep.id} for project '${projectName}' (${remoteSha}) was ${latestDep.status}. Auto-retrying deployment (attempt ${failedCount + 1}/3)...`,
              { project: projectName, targetSha: remoteSha },
            );
          }
        } else if (
          isSameSha(remoteSha, proj.lastSeenSha) &&
          isSameSha(remoteSha, proj.lastSuccessfulSha)
        ) {
          logger.debug(`No change detected for project '${projectName}' (SHA: ${remoteSha})`, {
            project: projectName,
          });
          return null;
        }
      }

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

      this.projectRepo.updateLastSeenSha(projectName, remoteSha);

      // Create deployment record
      const deploymentId = `dep_${nanoid(10)}`;
      const dynamicSteps = computeDeploymentSteps(
        proj.config.deploy.commands,
        proj.config.deploy.strategy,
      );

      this.deploymentRepo.createDeployment({
        id: deploymentId,
        projectName: proj.name,
        previousSha: proj.lastSuccessfulSha,
        targetSha: remoteSha,
        status: 'queued',
        triggerType,
        dryRun,
        steps: dynamicSteps,
      });

      // Enqueue job via Workmatic
      await this.workmaticEngine.enqueueDeployJob({
        deploymentId,
        projectName: proj.name,
        previousSha: proj.lastSuccessfulSha,
        targetSha: remoteSha,
        triggerType,
        dryRun,
        canary: canaryOptions?.canary,
        canaryWeight: canaryOptions?.canaryWeight,
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
    let proj: StoredProject | null = null;
    try {
      proj = this.projectRepo.getProject(projectName);
    } catch {
      // If DB read fails, retry with small delay
    }

    if (!proj) {
      this.timers.delete(projectName);
      return;
    }

    let baseInterval = initialDelayMs !== undefined ? initialDelayMs : proj.config.watch.intervalMs;

    // Apply small desynchronization jitter (+0..500ms) to prevent lockstep timer alignment across projects
    if (initialDelayMs === undefined && errorCount === 0) {
      baseInterval += Math.floor(Math.random() * 500);
    }

    // Apply exponential backoff with jitter on consecutive errors, capped at 60s max
    if (errorCount > 0) {
      const backoffMultiplier = Math.min(2 ** errorCount, 8);
      const jitter = Math.random() * 500;
      baseInterval = Math.min(baseInterval * backoffMultiplier + jitter, 60000);
    }

    const timer = setTimeout(async () => {
      this.timers.delete(projectName);
      let currentErrorCount = 0;
      try {
        await this.checkProject(projectName, 'poll', this.isDryRun);
        currentErrorCount = 0;
      } catch {
        currentErrorCount = this.errorCounts.get(projectName) || 1;
      } finally {
        try {
          this.scheduleNextCheck(projectName, currentErrorCount);
        } catch (err: any) {
          logger.error(`Error scheduling next check for '${projectName}': ${err.message}`);
        }
      }
    }, baseInterval);

    this.timers.set(projectName, timer);
  }
}
