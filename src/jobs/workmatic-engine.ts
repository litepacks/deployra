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
  triggeredAt: number;
}

export class WorkmaticEngine {
  private client: WorkmaticClient;
  private worker: WorkmaticWorker | null = null;
  private deploymentRepo: DeploymentRepository;
  private runner: DeploymentPipelineRunner | null = null;
  private db: ReturnType<typeof createDatabase>;

  constructor() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
    const dir = path.join(homeDir, '.deployra');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const dbPath = path.join(dir, 'workmatic.db');

    this.db = createDatabase({ filename: dbPath });
    this.client = createClient({ db: this.db });
    this.deploymentRepo = new DeploymentRepository();
  }

  public setPipelineRunner(runner: DeploymentPipelineRunner): void {
    this.runner = runner;
  }

  public async startWorker(): Promise<void> {
    if (this.worker) return;

    this.worker = createWorker({
      db: this.db,
      queue: 'deployra.deploy',
      concurrency: 1,
    });

    this.worker.process(async (job: Job<DeploymentJobPayload>) => {
      const payload = job.payload;
      logger.info(
        `Workmatic processing deployment job for project '${payload.projectName}' (target SHA: ${payload.targetSha})`,
        {
          project: payload.projectName,
          deploymentId: payload.deploymentId,
        },
      );

      if (!this.runner) {
        throw new Error('Pipeline runner is not configured in WorkmaticEngine');
      }

      await this.runner.runDeployment(payload);
    });

    this.worker.start();
    logger.info('Workmatic background job worker started.');

    await this.recoverStaleJobs();
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
    const active = this.deploymentRepo.getActiveDeployments(projectName);
    for (const dep of active) {
      if (dep.status === 'queued') {
        this.deploymentRepo.updateStatus(
          dep.id,
          'cancelled',
          'Cancelled by newer commit deployment',
        );
        logger.info(`Cancelled older queued deployment #${dep.id} for project '${projectName}'`, {
          project: projectName,
          deploymentId: dep.id,
        });
      }
    }
  }

  private async recoverStaleJobs(): Promise<void> {
    const unfinished = this.deploymentRepo.getActiveDeployments();
    for (const dep of unfinished) {
      if (dep.status === 'running' || dep.status === 'queued') {
        logger.warn(
          `Recovering incomplete deployment #${dep.id} (status: ${dep.status}) from startup recovery`,
          {
            project: dep.projectName,
            deploymentId: dep.id,
          },
        );
        this.deploymentRepo.updateStatus(
          dep.id,
          'failed',
          'Daemon restarted during active deployment',
        );
      }
    }
  }

  public async stopWorker(): Promise<void> {
    if (this.worker) {
      await this.worker.stop();
      this.worker = null;
      logger.info('Workmatic worker stopped gracefully.');
    }
  }
}
