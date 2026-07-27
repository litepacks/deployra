import { WorkmaticEngine } from './jobs/workmatic-engine.js';
import { logger } from './logging/logger.js';
import { DeploymentPipelineRunner } from './pipeline/pipeline-runner.js';
import { closeDatabase } from './storage/database.js';
import { StateRepository } from './storage/state-repository.js';
import { SourceWatcher } from './watcher/source-watcher.js';

export class DeployraDaemon {
  private workmaticEngine: WorkmaticEngine;
  private pipelineRunner: DeploymentPipelineRunner;
  private watcher: SourceWatcher;
  private stateRepo: StateRepository;
  private isShuttingDown = false;

  constructor() {
    this.workmaticEngine = new WorkmaticEngine();
    this.pipelineRunner = new DeploymentPipelineRunner();
    this.workmaticEngine.setPipelineRunner(this.pipelineRunner);
    this.watcher = new SourceWatcher(this.workmaticEngine);
    this.stateRepo = new StateRepository();
  }

  public async start(targetProjectName?: string): Promise<void> {
    logger.info('Starting Deployra Deployment Daemon...');

    await this.workmaticEngine.startWorker();
    await this.watcher.start(targetProjectName);

    this.registerSignalHandlers();
    logger.info('Deployra Daemon is up and running.');
  }

  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('Shutting down Deployra Daemon gracefully...');

    try {
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
  }
}
