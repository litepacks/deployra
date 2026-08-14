import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import {
  computeDeploymentSteps,
  DeploymentRepository,
} from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';
import { StateRepository } from '../src/storage/state-repository.js';

describe('Storage & Repository Tests', () => {
  beforeEach(() => {
    // Set temporary memory database
    process.env.DEPLOYRA_DB_PATH = ':memory:';
    resetDatabase();
  });

  afterAll(() => {
    closeDatabase();
  });

  it('stores and retrieves project configurations correctly', () => {
    const projRepo = new ProjectRepository();
    const config = normalizeAndValidateConfig({
      project: { name: 'test-app', path: '/tmp/test-app' },
    });

    projRepo.saveProject(config);
    const fetched = projRepo.getProject('test-app');

    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe('test-app');
    expect(fetched?.path).toBe('/tmp/test-app');
    expect(fetched?.configVersion).toBe(1);
    expect(fetched?.configHash).toMatch(/^cfg_[a-f0-9]{12}$/);

    // Save modified config for same project
    const modifiedConfig = normalizeAndValidateConfig({
      project: { name: 'test-app', path: '/tmp/test-app' },
      deploy: { commands: { build: ['echo "new build command"'] } },
    });
    projRepo.saveProject(modifiedConfig);
    const updated = projRepo.getProject('test-app');

    expect(updated?.configVersion).toBe(2);
    expect(updated?.configHash).not.toBe(fetched?.configHash);
  });

  it('automatically cleans up legacy URL-like project entries from database', () => {
    const projRepo = new ProjectRepository();
    const config = normalizeAndValidateConfig({
      project: {
        name: 'https://github.com/user/legacy-url-repo.git',
        path: '/tmp/legacy-url-repo',
      },
    });
    projRepo.saveProject(config);

    const all = projRepo.getAllProjects();
    expect(all.some((p) => p.name.startsWith('http'))).toBe(false);
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('legacy-url-repo');
  });

  it('manages project deployment locks cleanly', () => {
    const stateRepo = new StateRepository();

    const locked1 = stateRepo.acquireLock('my-project', 'dep_1');
    expect(locked1).toBe(true);

    const locked2 = stateRepo.acquireLock('my-project', 'dep_2');
    expect(locked2).toBe(false);

    stateRepo.releaseLock('my-project', 'dep_1');
    const locked3 = stateRepo.acquireLock('my-project', 'dep_2');
    expect(locked3).toBe(true);
  });

  it('tracks deployment records and step execution state', () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'test-app', path: '/tmp/test-app' },
      }),
    );

    const dep = depRepo.createDeployment({
      id: 'dep_test_123',
      projectName: 'test-app',
      targetSha: 'abc1234',
      triggerType: 'manual',
    });

    expect(dep.status).toBe('queued');
    expect(dep.steps.length).toBe(11);

    depRepo.updateStatus('dep_test_123', 'running');
    depRepo.updateStep('dep_test_123', 'acquire-lock', {
      status: 'failed',
      error: 'Could not acquire deployment lock for project',
    });
    let updated = depRepo.getDeployment('dep_test_123');
    const lockStepFailed = updated?.steps.find((s) => s.stepName === 'acquire-lock');
    expect(lockStepFailed?.status).toBe('failed');
    expect(lockStepFailed?.error).toBe('Could not acquire deployment lock for project');

    depRepo.updateStep('dep_test_123', 'acquire-lock', {
      status: 'success',
      duration: 1,
    });
    updated = depRepo.getDeployment('dep_test_123');
    const lockStepSuccess = updated?.steps.find((s) => s.stepName === 'acquire-lock');
    expect(lockStepSuccess?.status).toBe('success');
    expect(lockStepSuccess?.error).toBeUndefined();
  });

  it('calculates deployment statistics correctly', () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'stats-app', path: '/tmp/stats-app' },
      }),
    );

    depRepo.createDeployment({
      id: 'dep_s1',
      projectName: 'stats-app',
      targetSha: 'sha1',
      triggerType: 'manual',
    });
    depRepo.updateStatus('dep_s1', 'success');

    const stats = depRepo.getStats('stats-app');
    expect(stats.total).toBe(1);
    expect(stats.success).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('computes dynamic deployment steps according to commands configuration', () => {
    const customSteps = computeDeploymentSteps({
      install: ['npm ci'],
      migrate: ['npm run db:migrate'],
      build: ['npm run build:css'],
    });

    expect(customSteps).toEqual([
      'acquire-lock',
      'validate-repository',
      'fetch',
      'resolve-target',
      'prepare',
      'install',
      'migrate',
      'build',
      'service-action',
      'ready-check',
      'complete',
      'release-lock',
    ]);

    const buildOnlySteps = computeDeploymentSteps({
      build: ['npm run build'],
    });

    expect(buildOnlySteps).toEqual([
      'acquire-lock',
      'validate-repository',
      'fetch',
      'resolve-target',
      'prepare',
      'build',
      'service-action',
      'ready-check',
      'complete',
      'release-lock',
    ]);
  });

  it('automatically clears stale locks when previous deployment is completed or failed', () => {
    const stateRepo = new StateRepository();
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'stale-lock-app', path: '/tmp/stale-lock-app' },
      }),
    );

    depRepo.createDeployment({
      id: 'dep_finished_1',
      projectName: 'stale-lock-app',
      targetSha: 'sha_1',
      triggerType: 'manual',
    });

    stateRepo.acquireLock('stale-lock-app', 'dep_finished_1');
    depRepo.updateStatus('dep_finished_1', 'success');

    // Acquire lock for new deployment while previous lock held by finished deployment
    const lockAcquired = stateRepo.acquireLock('stale-lock-app', 'dep_new_2');
    expect(lockAcquired).toBe(true);
  });
});
