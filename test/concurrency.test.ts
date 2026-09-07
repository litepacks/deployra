import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { DeployraDaemon } from '../src/daemon.js';
import { WorkmaticEngine } from '../src/jobs/workmatic-engine.js';
import type { DeploymentPipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';

describe('Multi-Project Concurrency & Serialization', () => {
  let tempDir: string;
  let workmaticDbPath: string;
  const originalEnvConcurrency = process.env.DEPLOYRA_CONCURRENCY;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-concurrency-test-'));
    process.env.DEPLOYRA_DB_PATH = path.join(tempDir, 'test-deployra.db');
    workmaticDbPath = path.join(tempDir, 'test-workmatic.db');
    process.env.WORKMATIC_DB_PATH = workmaticDbPath;
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (originalEnvConcurrency !== undefined) {
      process.env.DEPLOYRA_CONCURRENCY = originalEnvConcurrency;
    } else {
      delete process.env.DEPLOYRA_CONCURRENCY;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('configures WorkmaticEngine concurrency from defaults, options, and environment variables', () => {
    delete process.env.DEPLOYRA_CONCURRENCY;
    const defaultEngine = new WorkmaticEngine({ dbPath: workmaticDbPath });
    expect(defaultEngine.getConcurrency()).toBe(4);

    const customEngine = new WorkmaticEngine({ concurrency: 8, dbPath: workmaticDbPath });
    expect(customEngine.getConcurrency()).toBe(8);

    process.env.DEPLOYRA_CONCURRENCY = '12';
    const envEngine = new WorkmaticEngine({ dbPath: workmaticDbPath });
    expect(envEngine.getConcurrency()).toBe(12);

    const daemon = new DeployraDaemon({ concurrency: 6 });
    expect(daemon.getConcurrency()).toBe(6);
  });

  it('executes deployments for different projects in parallel without blocking', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const engine = new WorkmaticEngine({ concurrency: 4, dbPath: workmaticDbPath });

    const executionLog: Array<{ project: string; event: 'start' | 'end'; time: number }> = [];

    const mockRunner = {
      runDeployment: async (payload: { projectName: string; deploymentId: string }) => {
        executionLog.push({ project: payload.projectName, event: 'start', time: Date.now() });
        // Simulate a build task taking 100ms
        await new Promise((resolve) => setTimeout(resolve, 100));
        executionLog.push({ project: payload.projectName, event: 'end', time: Date.now() });
        depRepo.updateStatus(payload.deploymentId, 'success');
      },
    } as unknown as DeploymentPipelineRunner;

    engine.setPipelineRunner(mockRunner);
    await engine.startWorker();

    try {
      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'proj-alpha', path: path.join(tempDir, 'alpha') },
        }),
      );
      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'proj-beta', path: path.join(tempDir, 'beta') },
        }),
      );

      depRepo.createDeployment({
        id: 'dep_alpha_1',
        projectName: 'proj-alpha',
        targetSha: 'sha_alpha_1',
        status: 'queued',
        triggerType: 'poll',
      });
      depRepo.createDeployment({
        id: 'dep_beta_1',
        projectName: 'proj-beta',
        targetSha: 'sha_beta_1',
        status: 'queued',
        triggerType: 'poll',
      });

      const startTime = Date.now();
      await Promise.all([
        engine.enqueueDeployJob({
          deploymentId: 'dep_alpha_1',
          projectName: 'proj-alpha',
          targetSha: 'sha_alpha_1',
          triggerType: 'poll',
          triggeredAt: Date.now(),
        }),
        engine.enqueueDeployJob({
          deploymentId: 'dep_beta_1',
          projectName: 'proj-beta',
          targetSha: 'sha_beta_1',
          triggerType: 'poll',
          triggeredAt: Date.now(),
        }),
      ]);

      // Wait for both deployments to finish
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const d1 = depRepo.getDeployment('dep_alpha_1');
        const d2 = depRepo.getDeployment('dep_beta_1');
        if (d1?.status === 'success' && d2?.status === 'success') {
          break;
        }
      }

      const totalElapsed = Date.now() - startTime;
      expect(depRepo.getDeployment('dep_alpha_1')?.status).toBe('success');
      expect(depRepo.getDeployment('dep_beta_1')?.status).toBe('success');

      // Both projects were running concurrently:
      // If sequential, total execution time would be >= 200ms. Since concurrent, both started before either finished.
      const alphaStart = executionLog.find(
        (e) => e.project === 'proj-alpha' && e.event === 'start',
      );
      const betaStart = executionLog.find((e) => e.project === 'proj-beta' && e.event === 'start');
      const alphaEnd = executionLog.find((e) => e.project === 'proj-alpha' && e.event === 'end');
      const betaEnd = executionLog.find((e) => e.project === 'proj-beta' && e.event === 'end');

      expect(alphaStart).toBeDefined();
      expect(betaStart).toBeDefined();
      expect(alphaEnd).toBeDefined();
      expect(betaEnd).toBeDefined();

      // Both jobs started before both completed (overlapping execution)
      expect(alphaStart!.time).toBeLessThan(betaEnd!.time);
      expect(betaStart!.time).toBeLessThan(alphaEnd!.time);
      expect(totalElapsed).toBeLessThan(1000);
    } finally {
      await engine.stopWorker();
    }
  });

  it('serializes deployments for the same project sequentially without lock conflicts', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const engine = new WorkmaticEngine({ concurrency: 4, dbPath: workmaticDbPath });

    const executionOrder: string[] = [];

    const mockRunner = {
      runDeployment: async (payload: { projectName: string; deploymentId: string }) => {
        executionOrder.push(`${payload.deploymentId}_start`);
        await new Promise((resolve) => setTimeout(resolve, 80));
        executionOrder.push(`${payload.deploymentId}_end`);
        depRepo.updateStatus(payload.deploymentId, 'success');
      },
    } as unknown as DeploymentPipelineRunner;

    engine.setPipelineRunner(mockRunner);
    await engine.startWorker();

    try {
      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'single-app', path: path.join(tempDir, 'single') },
        }),
      );

      depRepo.createDeployment({
        id: 'dep_seq_1',
        projectName: 'single-app',
        targetSha: 'sha_seq_1',
        status: 'queued',
        triggerType: 'poll',
      });
      depRepo.createDeployment({
        id: 'dep_seq_2',
        projectName: 'single-app',
        targetSha: 'sha_seq_2',
        status: 'queued',
        triggerType: 'poll',
      });

      await engine.enqueueDeployJob({
        deploymentId: 'dep_seq_1',
        projectName: 'single-app',
        targetSha: 'sha_seq_1',
        triggerType: 'poll',
        triggeredAt: Date.now(),
      });
      await engine.enqueueDeployJob({
        deploymentId: 'dep_seq_2',
        projectName: 'single-app',
        targetSha: 'sha_seq_2',
        triggerType: 'poll',
        triggeredAt: Date.now(),
      });

      // Wait for both to finish
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const d1 = depRepo.getDeployment('dep_seq_1');
        const d2 = depRepo.getDeployment('dep_seq_2');
        if (d1?.status === 'success' && d2?.status === 'success') {
          break;
        }
      }

      expect(depRepo.getDeployment('dep_seq_1')?.status).toBe('success');
      expect(depRepo.getDeployment('dep_seq_2')?.status).toBe('success');

      // The execution MUST be strictly serialized: dep_seq_1 finishes before dep_seq_2 starts
      expect(executionOrder).toEqual([
        'dep_seq_1_start',
        'dep_seq_1_end',
        'dep_seq_2_start',
        'dep_seq_2_end',
      ]);
    } finally {
      await engine.stopWorker();
    }
  });

  it('skips cancelled deployment job when dequeued from project wait chain', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const engine = new WorkmaticEngine({ concurrency: 4, dbPath: workmaticDbPath });

    const executedDeployments: string[] = [];

    const mockRunner = {
      runDeployment: async (payload: { projectName: string; deploymentId: string }) => {
        executedDeployments.push(payload.deploymentId);
        await new Promise((resolve) => setTimeout(resolve, 80));
        depRepo.updateStatus(payload.deploymentId, 'success');
      },
    } as unknown as DeploymentPipelineRunner;

    engine.setPipelineRunner(mockRunner);
    await engine.startWorker();

    try {
      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'cancel-app', path: path.join(tempDir, 'cancel') },
        }),
      );

      depRepo.createDeployment({
        id: 'dep_run_1',
        projectName: 'cancel-app',
        targetSha: 'sha_1',
        status: 'queued',
        triggerType: 'poll',
      });
      depRepo.createDeployment({
        id: 'dep_cancel_2',
        projectName: 'cancel-app',
        targetSha: 'sha_2',
        status: 'queued',
        triggerType: 'poll',
      });

      await engine.enqueueDeployJob({
        deploymentId: 'dep_run_1',
        projectName: 'cancel-app',
        targetSha: 'sha_1',
        triggerType: 'poll',
        triggeredAt: Date.now(),
      });
      await engine.enqueueDeployJob({
        deploymentId: 'dep_cancel_2',
        projectName: 'cancel-app',
        targetSha: 'sha_2',
        triggerType: 'poll',
        triggeredAt: Date.now(),
      });

      // Cancel dep_cancel_2 while dep_run_1 is still running
      depRepo.updateStatus(
        'dep_cancel_2',
        'cancelled',
        'Cancelled by newer commit or user intervention',
      );

      // Wait for dep_run_1 to finish
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const d1 = depRepo.getDeployment('dep_run_1');
        if (d1?.status === 'success') {
          break;
        }
      }

      // Allow a brief moment for engine queue to process dep_cancel_2
      await new Promise((r) => setTimeout(r, 100));

      expect(depRepo.getDeployment('dep_run_1')?.status).toBe('success');
      expect(depRepo.getDeployment('dep_cancel_2')?.status).toBe('cancelled');
      // dep_cancel_2 was skipped and never invoked runDeployment!
      expect(executedDeployments).toEqual(['dep_run_1']);
    } finally {
      await engine.stopWorker();
    }
  });
});
