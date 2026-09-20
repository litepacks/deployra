import fs from 'node:fs';
import path from 'node:path';
import {
  createClient,
  createDatabase,
  createWorker,
  type Job,
  type WorkmaticClient,
  type WorkmaticWorker,
} from 'workmatic';
import { logger } from '../logging/logger.js';
import type { DeploymentPipelineRunner } from '../pipeline/pipeline-runner.js';
import { DeploymentRepository } from '../storage/deployment-repository.js';

export interface DeploymentJobPayload {
  deploymentId: string;
  projectName: string;
  previousSha?: string;
  targetSha: string;
  triggerType: 'poll' | 'manual' | 'webhook';
  dryRun?: boolean;
  canary?: boolean;
  canaryWeight?: number | string;
  triggeredAt: number;
}

export interface WorkmaticEngineOptions {
  concurrency?: number;
  dbPath?: string;
}

export class WorkmaticEngine {
  private client: WorkmaticClient;
  private worker: WorkmaticWorker | null = null;
  private deploymentRepo: DeploymentRepository;
  private runner: DeploymentPipelineRunner | null = null;
  private db: ReturnType<typeof createDatabase>;
  private concurrency: number;
  private projectExecutionChains = new Map<string, Promise<void>>();

  constructor(options?: WorkmaticEngineOptions) {
    const customDb =
      options?.dbPath ||
      process.env.WORKMATIC_DB_PATH ||
      (process.env.DEPLOYRA_DB_PATH === ':memory:' ? ':memory:' : undefined);

    let dbPath = customDb;
    if (!dbPath) {
      const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
      const dir = path.join(homeDir, '.deployra');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      dbPath = path.join(dir, 'workmatic.db');
    }

    const parsedEnvConcurrency = process.env.DEPLOYRA_CONCURRENCY
      ? Number.parseInt(process.env.DEPLOYRA_CONCURRENCY, 10)
      : undefined;
    const resolvedConcurrency = options?.concurrency ?? parsedEnvConcurrency ?? 4;
    this.concurrency = Math.max(1, Number.isFinite(resolvedConcurrency) ? resolvedConcurrency : 4);

    this.db = createDatabase({ filename: dbPath });
    this.client = createClient({ db: this.db, queue: 'deployra.deploy' });
    this.deploymentRepo = new DeploymentRepository();
  }

  private runningDeployments = new Set<string>();

  public getActiveRunningDeploymentIds(): Set<string> {
    return new Set(this.runningDeployments);
  }

  public getConcurrency(): number {
    return this.concurrency;
  }

  public setPipelineRunner(runner: DeploymentPipelineRunner): void {
    this.runner = runner;
  }

  public async startWorker(): Promise<void> {
    if (this.worker) return;

    const cleaned = this.deploymentRepo.cleanupUnfinishedJobsOnStartup();
    if (cleaned > 0) {
      logger.info(
        `Cleaned up ${cleaned} stale/interrupted deployment job(s) from previous process run.`,
      );
    }

    this.worker = createWorker({
      db: this.db,
      queue: 'deployra.deploy',
      concurrency: this.concurrency,
      timeoutMs: 0,
    });

    this.worker.process(async (job: Job<DeploymentJobPayload>) => {
      const payload = job.payload;
      this.runningDeployments.add(payload.deploymentId);
      logger.info(
        `Workmatic processing deployment job for project '${payload.projectName}' (target SHA: ${payload.targetSha})`,
        {
          project: payload.projectName,
          deploymentId: payload.deploymentId,
        },
      );

      if (!this.runner) {
        logger.error('Pipeline runner is not configured in WorkmaticEngine');
        this.runningDeployments.delete(payload.deploymentId);
        return;
      }

      await this.runForProject(payload.projectName, async () => {
        // Check if deployment was cancelled while waiting in the project queue
        const status = this.deploymentRepo.getDeploymentStatus(payload.deploymentId);
        if (status === 'cancelled') {
          logger.info(
            `Skipping cancelled deployment job #${payload.deploymentId} for project '${payload.projectName}'`,
            {
              project: payload.projectName,
              deploymentId: payload.deploymentId,
            },
          );
          return;
        }

        try {
          await this.runner!.runDeployment(payload);
        } catch (err: any) {
          logger.error(
            `Unhandled error executing deployment pipeline for '${payload.projectName}': ${err.message}`,
            {
              project: payload.projectName,
              deploymentId: payload.deploymentId,
              error: err,
            },
          );
        } finally {
          this.runningDeployments.delete(payload.deploymentId);
        }
      });
    });

    this.worker.start();
    logger.info(`Workmatic background job worker started (concurrency: ${this.concurrency}).`);
  }

  private async runForProject<T>(projectName: string, fn: () => Promise<T>): Promise<T> {
    const previousPromise = this.projectExecutionChains.get(projectName) || Promise.resolve();
    let resolveCurrent!: () => void;
    const currentPromise = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    this.projectExecutionChains.set(projectName, currentPromise);

    try {
      await previousPromise;
    } catch {
      // Ignore errors from earlier deployment tasks in the project chain
    }

    try {
      return await fn();
    } finally {
      resolveCurrent();
      if (this.projectExecutionChains.get(projectName) === currentPromise) {
        this.projectExecutionChains.delete(projectName);
      }
    }
  }

  public async enqueueDeployJob(payload: DeploymentJobPayload): Promise<string> {
    const result = await this.client.add(payload, {
      maxAttempts: 1, // Pipeline runner handles step-level retries
    });

    logger.info(`Enqueued deployment job ${result.id} for project '${payload.projectName}'`, {
      project: payload.projectName,
      deploymentId: payload.deploymentId,
    });

    return String(result.id);
  }

  public async cancelPendingJobsForProject(projectName: string): Promise<void> {
    if (this.runner) {
      this.runner.abortAllDeploymentsForProject(
        projectName,
        'Cancelled by newer commit deployment',
      );
    }
    const cancelled = this.deploymentRepo.cancelPendingDeployments(
      projectName,
      'Cancelled by newer commit deployment',
    );
    for (const dep of cancelled) {
      logger.info(
        `Cancelled older ${dep.status} deployment #${dep.id} for project '${projectName}'`,
        {
          project: projectName,
          deploymentId: dep.id,
        },
      );
    }
  }

  public async stopWorker(): Promise<void> {
    if (this.worker) {
      await this.worker.stop();
      this.worker = null;
      this.projectExecutionChains.clear();
      logger.info('Workmatic worker stopped gracefully.');
    }
  }
}
