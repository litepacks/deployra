import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { DEFAULT_JOB_LEASE_MS, WorkmaticEngine } from '../src/jobs/workmatic-engine.js';
import type { DeploymentPipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Workmatic job lease & duplicate delivery', () => {
  let engine: WorkmaticEngine | null = null;

  beforeEach(() => {
    process.env.DEPLOYRA_DB_PATH = ':memory:';
    process.env.WORKMATIC_DB_PATH = ':memory:';
    resetDatabase();
  });

  afterEach(async () => {
    await engine?.stopWorker();
    engine = null;
  });

  afterAll(() => {
    closeDatabase();
  });

  const queueDeployment = async (projectName: string, id: string) => {
    new ProjectRepository().saveProject(
      normalizeAndValidateConfig({ project: { name: projectName, path: `/tmp/${projectName}` } }),
    );
    new DeploymentRepository().createDeployment({
      id,
      projectName,
      targetSha: `sha_${id}`,
      status: 'queued',
      triggerType: 'manual',
    });
    await engine!.enqueueDeployJob({
      deploymentId: id,
      projectName,
      targetSha: `sha_${id}`,
      triggerType: 'manual',
      triggeredAt: Date.now(),
    });
  };

  it('defaults to a lease longer than any realistic deployment', () => {
    expect(DEFAULT_JOB_LEASE_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it('runs a deployment once even when it outlives the lease, without starving other projects', async () => {
    // concurrency 2 + a lease far shorter than the deployment reproduces the old starvation:
    // re-claimed copies of the long job used to fill every slot behind the project chain.
    engine = new WorkmaticEngine({ dbPath: ':memory:', concurrency: 2, leaseMs: 200 });
    const repo = new DeploymentRepository();
    const runs: string[] = [];
    engine.setPipelineRunner({
      runDeployment: async (payload: { deploymentId: string }) => {
        runs.push(payload.deploymentId);
        repo.updateStatus(payload.deploymentId, 'running');
        await sleep(payload.deploymentId === 'dep_long' ? 2500 : 50);
        repo.updateStatus(payload.deploymentId, 'success');
      },
    } as unknown as DeploymentPipelineRunner);

    await engine.startWorker();
    await queueDeployment('long-app', 'dep_long');
    await sleep(700); // several lease expiries while dep_long runs
    await queueDeployment('other-app', 'dep_other');
    await sleep(2800);

    expect(runs.filter((id) => id === 'dep_long')).toHaveLength(1);
    expect(runs).toContain('dep_other');
    expect(repo.getDeployment('dep_other')?.status).toBe('success');
  }, 10_000);

  it('never re-runs a deployment that is no longer queued', async () => {
    engine = new WorkmaticEngine({ dbPath: ':memory:', concurrency: 1 });
    const runs: string[] = [];
    engine.setPipelineRunner({
      runDeployment: async (payload: { deploymentId: string }) => {
        runs.push(payload.deploymentId);
      },
    } as unknown as DeploymentPipelineRunner);

    await engine.startWorker();
    await queueDeployment('done-app', 'dep_done');
    new DeploymentRepository().updateStatus('dep_done', 'failed', 'Daemon restarted');
    await sleep(1500);

    expect(runs).toHaveLength(0);
  }, 10_000);
});
