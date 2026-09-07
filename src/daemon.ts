import { WorkmaticEngine } from './jobs/workmatic-engine.js';
import { logger } from './logging/logger.js';
import { DeploymentPipelineRunner } from './pipeline/pipeline-runner.js';
import { assertNonRootUser } from './security/path-validator.js';
import { WebhookServer } from './server/webhook-server.js';
import { closeDatabase } from './storage/database.js';
import { StateRepository } from './storage/state-repository.js';
import { SourceWatcher } from './watcher/source-watcher.js';

export interface DaemonOptions {
  concurrency?: number;
  webhookPort?: number;
  webhookHost?: string;
  enableWebhook?: boolean;
}

export class DeployraDaemon {
  private workmaticEngine: WorkmaticEngine;
  private pipelineRunner: DeploymentPipelineRunner;
  private watcher: SourceWatcher;
  private stateRepo: StateRepository;
  private webhookServer?: WebhookServer;
  private daemonOptions?: DaemonOptions;
  private isShuttingDown = false;

  constructor(options?: DaemonOptions) {
    this.daemonOptions = options;
    this.workmaticEngine = new WorkmaticEngine(options);
    this.pipelineRunner = new DeploymentPipelineRunner();
    this.workmaticEngine.setPipelineRunner(this.pipelineRunner);
    this.watcher = new SourceWatcher(this.workmaticEngine);
    this.stateRepo = new StateRepository();
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

      logger.info(`${dryRun ? '[DRY-RUN MODE] ' : ''}Deployra Daemon is up and running.`);
    } catch (err: any) {
      logger.error(`Fatal error starting Deployra Daemon: ${err.message}`, { error: err });
      throw err;
    }
  }

  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

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

    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));

    process.on('uncaughtException', async (err: Error) => {
      logger.error(`Uncaught Exception in Deployra Daemon: ${err.message}`, {
        stack: err.stack,
      });
      try {
        await this.shutdown();
      } finally {
        process.exit(1);
      }
    });

    process.on('unhandledRejection', (reason: any) => {
      logger.error(`Unhandled Rejection in Deployra Daemon: ${reason?.message || reason}`, {
        reason,
      });
    });
  }
}
