import { GitClient } from './git/git-client.js';
import { WorkmaticEngine } from './jobs/workmatic-engine.js';
import { logger } from './logging/logger.js';
import { DeploymentPipelineRunner } from './pipeline/pipeline-runner.js';
import { ServiceHealer } from './repair/service-healer.js';
import { UnitupAdapter } from './runtime/unitup-adapter.js';
import { assertNonRootUser } from './security/path-validator.js';
import { WebhookServer } from './server/webhook-server.js';
import { closeDatabase, vacuumDatabase } from './storage/database.js';
import { DeploymentRepository } from './storage/deployment-repository.js';
import { ProjectRepository } from './storage/project-repository.js';
import { StateRepository } from './storage/state-repository.js';
import { SourceWatcher } from './watcher/source-watcher.js';

/** Queued deployments not picked up within this window (with free worker slots) are failed. */
export const STALE_QUEUED_MS = 15 * 60 * 1000;

export interface DaemonOptions {
  concurrency?: number;
  webhookPort?: number;
  webhookHost?: string;
  enableWebhook?: boolean;
  watchdogIntervalMs?: number;
}

export class DeployraDaemon {
  private workmaticEngine: WorkmaticEngine;
  private pipelineRunner: DeploymentPipelineRunner;
  private watcher: SourceWatcher;
  private stateRepo: StateRepository;
  private projectRepo: ProjectRepository;
  private deploymentRepo: DeploymentRepository;
  private unitupAdapter: UnitupAdapter;
  private gitClient: GitClient;
  private webhookServer?: WebhookServer;
  private daemonOptions?: DaemonOptions;
  private selfRepairTimer?: NodeJS.Timeout;
  private isShuttingDown = false;
  private isRepairCycleRunning = false;
  private serviceHealer: ServiceHealer;

  constructor(options?: DaemonOptions) {
    this.daemonOptions = options;
    this.workmaticEngine = new WorkmaticEngine(options);
    this.pipelineRunner = new DeploymentPipelineRunner();
    this.workmaticEngine.setPipelineRunner(this.pipelineRunner);
    this.watcher = new SourceWatcher(this.workmaticEngine);
    this.stateRepo = new StateRepository();
    this.projectRepo = new ProjectRepository();
    this.deploymentRepo = new DeploymentRepository();
    this.unitupAdapter = new UnitupAdapter();
    this.gitClient = new GitClient();
    this.serviceHealer = new ServiceHealer({
      unitupAdapter: this.unitupAdapter,
      deploymentRepo: this.deploymentRepo,
    });
  }

  public getConcurrency(): number {
    return this.workmaticEngine.getConcurrency();
  }

  public getWebhookPort(): number | undefined {
    return this.webhookServer?.getPort();
  }

  public async start(targetProjectName?: string, dryRun = false): Promise<void> {
    try {
      assertNonRootUser();

      logger.info(
        `${dryRun ? '[DRY-RUN MODE] ' : ''}Starting Deployra Deployment Daemon (concurrency: ${this.workmaticEngine.getConcurrency()})...`,
      );

      this.registerSignalHandlers();

      // Clear any orphaned SQLite locks and clean up previous unfinished jobs on startup
      this.stateRepo.clearAllLocks();
      this.repairStartupProjectsGitLocks();

      await this.workmaticEngine.startWorker();
      await this.watcher.start(targetProjectName, dryRun);

      const shouldEnableWebhook =
        this.daemonOptions?.enableWebhook ?? process.env.DEPLOYRA_ENABLE_WEBHOOK !== 'false';

      if (shouldEnableWebhook) {
        const port =
          this.daemonOptions?.webhookPort ??
          (process.env.DEPLOYRA_WEBHOOK_PORT
            ? Number.parseInt(process.env.DEPLOYRA_WEBHOOK_PORT, 10)
            : 3939);

        this.webhookServer = new WebhookServer({
          port,
          host: this.daemonOptions?.webhookHost || process.env.DEPLOYRA_WEBHOOK_HOST || '0.0.0.0',
          sourceWatcher: this.watcher,
          dryRun,
        });
        await this.webhookServer.start();
      }

      // Start background Self-Repair Watchdog (every 30s)
      this.startSelfRepairWatchdog(dryRun);

      logger.info(`${dryRun ? '[DRY-RUN MODE] ' : ''}Deployra Daemon is up and running.`);
    } catch (err: any) {
      logger.error(`Fatal error starting Deployra Daemon: ${err.message}`, { error: err });
      throw err;
    }
  }

  private repairStartupProjectsGitLocks(): void {
    try {
      const all = this.projectRepo.getAllProjects();
      for (const p of all) {
        this.gitClient.repairStaleLocks(p.path);
        if (p.config?.deploy?.workspacePath) {
          this.gitClient.repairStaleLocks(p.config.deploy.workspacePath);
        }
      }
    } catch {
      // Ignore initial scan errors
    }
  }

  private startSelfRepairWatchdog(dryRun = false): void {
    const intervalMs = this.daemonOptions?.watchdogIntervalMs ?? 30000;
    this.selfRepairTimer = setInterval(async () => {
      // Recovery can wait on ready checks longer than the interval: never overlap cycles
      if (this.isShuttingDown || this.isRepairCycleRunning) return;
      this.isRepairCycleRunning = true;
      try {
        await this.runSelfRepairCycle(dryRun);
      } catch (err: any) {
        logger.error(`Error in self-repair watchdog cycle: ${err.message}`);
      } finally {
        this.isRepairCycleRunning = false;
      }
    }, intervalMs);
  }

  public async runSelfRepairCycle(dryRun = false): Promise<void> {
    // 1. Prune stale SQLite locks
    const activeRunningIds = this.workmaticEngine.getActiveRunningDeploymentIds();
    const pruned = this.stateRepo.pruneStaleLocks(activeRunningIds, 300000);
    if (pruned > 0) {
      logger.info(`[SELF-REPAIR] Pruned ${pruned} stale project lock(s)`);
    }

    // 2. Fail deployments no live worker owns (a still-running build is never touched)
    const staleDeps = this.deploymentRepo.cleanupStaleJobs(15 * 60 * 1000, activeRunningIds);
    if (staleDeps > 0) {
      logger.warn(`[SELF-REPAIR] Cleaned up ${staleDeps} orphaned running deployment(s)`);
    }

    // 2b. Queued deployments the worker never picked up although it had free slots
    if (activeRunningIds.size < this.workmaticEngine.getConcurrency()) {
      const lostQueued = this.deploymentRepo.failStaleQueuedDeployments(
        STALE_QUEUED_MS,
        activeRunningIds,
      );
      if (lostQueued > 0) {
        logger.warn(
          `[SELF-REPAIR] Failed ${lostQueued} deployment(s) stuck in queue; the watcher will retry them.`,
        );
      }
    }

    // 3. Auto-retention prune (keep max 100 per project or 30 days) and compact database
    try {
      this.deploymentRepo.pruneDeployments({ keepCount: 100, maxAgeDays: 30 });
      vacuumDatabase();
    } catch {
      // ignore background auto-prune error
    }

    // 4. Recover services that crashed or stopped responding (backoff, limit, alert)
    if (!dryRun) {
      for (const proj of this.projectRepo.getAllProjects()) {
        if (this.isShuttingDown) break;
        try {
          await this.serviceHealer.check(proj);
        } catch (svcErr: any) {
          logger.warn(
            `[SELF-REPAIR] Service check failed for project '${proj.name}': ${svcErr.message}`,
          );
        }
      }
    }
  }

  private signalHandlers: Array<{
    event: NodeJS.Signals | 'uncaughtException' | 'unhandledRejection';
    handler: (...args: any[]) => void;
  }> = [];

  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    if (this.selfRepairTimer) {
      clearInterval(this.selfRepairTimer);
      this.selfRepairTimer = undefined;
    }

    this.unregisterSignalHandlers();

    logger.info('Shutting down Deployra Daemon gracefully...');

    try {
      if (this.webhookServer) {
        await this.webhookServer.stop();
        this.webhookServer = undefined;
      }
      await this.watcher.stop();
      await this.workmaticEngine.stopWorker();
      this.stateRepo.clearAllLocks();
      closeDatabase();
      logger.info('Deployra Daemon shutdown complete.');
    } catch (err: any) {
      logger.error(`Error during daemon shutdown: ${err.message}`);
    }
  }

  private registerSignalHandlers(): void {
    const handleShutdown = async (signal: string) => {
      logger.info(`Received signal ${signal}. Initiating shutdown sequence...`);
      await this.shutdown();
      process.exit(0);
    };

    const sigintHandler = () => handleShutdown('SIGINT');
    const sigtermHandler = () => handleShutdown('SIGTERM');

    const uncaughtHandler = async (err: Error) => {
      logger.error(`Uncaught Exception in Deployra Daemon: ${err.message}`, {
        stack: err.stack,
      });
      try {
        await this.shutdown();
      } finally {
        process.exit(1);
      }
    };

    const unhandledRejectionHandler = (reason: any) => {
      logger.error(`Unhandled Rejection in Deployra Daemon: ${reason?.message || reason}`, {
        reason,
      });
    };

    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);
    process.on('uncaughtException', uncaughtHandler);
    process.on('unhandledRejection', unhandledRejectionHandler);

    this.signalHandlers = [
      { event: 'SIGINT', handler: sigintHandler },
      { event: 'SIGTERM', handler: sigtermHandler },
      { event: 'uncaughtException', handler: uncaughtHandler },
      { event: 'unhandledRejection', handler: unhandledRejectionHandler },
    ];
  }

  private unregisterSignalHandlers(): void {
    for (const { event, handler } of this.signalHandlers) {
      try {
        process.off(event as any, handler);
      } catch {
        // ignore
      }
    }
    this.signalHandlers = [];
  }
}
