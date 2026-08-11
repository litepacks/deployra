import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { WorkmaticEngine } from '../src/jobs/workmatic-engine.js';
import { DeploymentPipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';
import { SourceWatcher } from '../src/watcher/source-watcher.js';

describe('Dry-Run Simulation Mode', () => {
  beforeEach(() => {
    process.env.DEPLOYRA_DB_PATH = ':memory:';
    resetDatabase();
  });

  afterAll(() => {
    closeDatabase();
  });

  it('persists dryRun boolean flag in DeploymentRepository', () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'dry-app', path: '/tmp/dry-app' },
      }),
    );

    const record = depRepo.createDeployment({
      id: 'dep_dry_1',
      projectName: 'dry-app',
      targetSha: 'abc1234',
      triggerType: 'manual',
      dryRun: true,
    });

    expect(record.id).toBe('dep_dry_1');
    expect(record.dryRun).toBe(true);

    const fetched = depRepo.getDeployment('dep_dry_1');
    expect(fetched?.dryRun).toBe(true);
  });

  it('executes pipeline steps successfully in dry-run mode without modifying production state or invoking shell commands', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const runner = new DeploymentPipelineRunner();

    const config = normalizeAndValidateConfig({
      project: { name: 'dry-pipe-app', path: '/tmp/dry-pipe-app' },
      deploy: {
        commands: {
          install: ['npm ci'],
          build: ['npm run build'],
        },
        service: {
          name: 'dry-pipe-app',
          action: 'restart',
          command: 'npm start',
        },
        ready: {
          checks: [{ type: 'command', command: 'echo ok' }],
        },
      },
    });

    projRepo.saveProject(config);

    depRepo.createDeployment({
      id: 'dep_dry_pipe_1',
      projectName: 'dry-pipe-app',
      targetSha: 'new_sha_999',
      triggerType: 'manual',
      dryRun: true,
    });

    await runner.runDeployment({
      deploymentId: 'dep_dry_pipe_1',
      projectName: 'dry-pipe-app',
      targetSha: 'new_sha_999',
      previousSha: 'old_sha_000',
      triggerType: 'manual',
      dryRun: true,
      triggeredAt: Date.now(),
    });

    const completed = depRepo.getDeployment('dep_dry_pipe_1');
    expect(completed?.status).toBe('success');
    expect(completed?.dryRun).toBe(true);

    // Verify all steps completed successfully
    const failedSteps = completed?.steps.filter((s) => s.status === 'failed');
    expect(failedSteps).toEqual([]);

    // Verify production lastSuccessfulSha was NOT updated to targetSha
    const proj = projRepo.getProject('dry-pipe-app');
    expect(proj?.lastSuccessfulSha).toBeUndefined();
  });

  it('passes dryRun flag through SourceWatcher checkProject', async () => {
    const engine = new WorkmaticEngine();
    const watcher = new SourceWatcher(engine);
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'watcher-dry-app', path: '/tmp/watcher-dry-app' },
      }),
    );

    // Mock checkRemoteHead
    (watcher as any).gitClient.checkRemoteHead = async () => 'sha_watcher_dry_1';

    const depId = await watcher.checkProject('watcher-dry-app', 'manual', true);
    expect(depId).toBeTruthy();

    const dep = depRepo.getDeployment(depId!);
    expect(dep?.dryRun).toBe(true);
  });
});
