import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
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
});
