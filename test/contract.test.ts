import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { UnitupAdapter } from '../src/runtime/unitup-adapter.js';
import type { RuntimeManager, RuntimeStatus } from '../src/runtime/runtime-manager.js';
import {
  ReadyCheckerAdapter,
  type ReadyCheckResult,
} from '../src/readiness/ready-checker-adapter.js';
import { ProjectRepository } from '../src/storage/project-repository.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { StateRepository } from '../src/storage/state-repository.js';
import { resetDatabase, closeDatabase } from '../src/storage/database.js';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import type { NormalizedGitshipConfig } from '../src/config/types.js';

describe('Contract Tests', () => {
  beforeEach(() => {
    process.env.GITSHIP_DB_PATH = ':memory:';
    resetDatabase();
  });

  afterAll(() => {
    closeDatabase();
  });

  describe('RuntimeManager Contract (UnitupAdapter)', () => {
    it('satisfies RuntimeManager interface contract', async () => {
      const manager: RuntimeManager = new UnitupAdapter();

      expect(typeof manager.start).toBe('function');
      expect(typeof manager.stop).toBe('function');
      expect(typeof manager.restart).toBe('function');
      expect(typeof manager.reload).toBe('function');
      expect(typeof manager.status).toBe('function');

      const status: RuntimeStatus = await manager.status('test-service');
      expect(status).toHaveProperty('service');
      expect(status).toHaveProperty('active');
      expect(typeof status.service).toBe('string');
      expect(typeof status.active).toBe('boolean');
    });
  });

  describe('ReadinessChecker Contract (ReadyCheckerAdapter)', () => {
    it('returns valid ReadyCheckResult contract structure when checks pass or empty', async () => {
      const adapter = new ReadyCheckerAdapter();
      const emptyConfig: NormalizedGitshipConfig['deploy']['ready'] = {
        timeoutMs: 5000,
        intervalMs: 1000,
        mode: 'all',
        checks: [],
      };

      const result: ReadyCheckResult = await adapter.wait(emptyConfig);
      expect(result).toHaveProperty('ready');
      expect(result).toHaveProperty('attempts');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('checks');
      expect(result.ready).toBe(true);
      expect(Array.isArray(result.checks)).toBe(true);
    });
  });

  describe('Config Normalizer Contract', () => {
    it('produces a complete NormalizedGitshipConfig contract from minimal input', () => {
      const minimalRaw = {
        project: { name: 'contract-app', path: '/var/www/contract-app' },
      };

      const normalized: NormalizedGitshipConfig = normalizeAndValidateConfig(minimalRaw);

      // Verify contract shape
      expect(normalized.project.name).toBe('contract-app');
      expect(normalized.project.path).toBe('/var/www/contract-app');
      expect(normalized.source.remote).toBe('origin');
      expect(normalized.source.branch).toBe('main');
      expect(typeof normalized.watch.intervalMs).toBe('number');
      expect(typeof normalized.deploy.timeoutMs).toBe('number');
      expect(typeof normalized.deploy.concurrency).toBe('number');
      expect(normalized.deploy.queueMode).toBe('latest');
      expect(normalized.deploy.dirtyWorkspace).toBe('reject');
      expect(normalized.deploy.service.name).toBe('contract-app');
      expect(normalized.deploy.service.action).toBe('restart');
      expect(normalized.deploy.rollback.enabled).toBe(true);
    });
  });

  describe('Storage Repositories Contract', () => {
    it('satisfies ProjectRepository contract', () => {
      const projRepo = new ProjectRepository();
      const config = normalizeAndValidateConfig({
        project: { name: 'c-app', path: '/tmp/c-app' },
      });

      const saved = projRepo.saveProject(config);
      expect(saved.name).toBe('c-app');

      const fetched = projRepo.getProject('c-app');
      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe('c-app');

      projRepo.updateLastSuccessfulSha('c-app', 'sha_success_123');
      projRepo.updateLastSeenSha('c-app', 'sha_seen_123');

      const updated = projRepo.getProject('c-app');
      expect(updated?.lastSeenSha).toBe('sha_seen_123');
      expect(updated?.lastSuccessfulSha).toBe('sha_success_123');

      const deleted = projRepo.deleteProject('c-app');
      expect(deleted).toBe(true);
      expect(projRepo.getProject('c-app')).toBeNull();
    });

    it('satisfies DeploymentRepository & Stats contract', () => {
      const projRepo = new ProjectRepository();
      const depRepo = new DeploymentRepository();

      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'c-app-2', path: '/tmp/c-app-2' },
        }),
      );

      const dep = depRepo.createDeployment({
        id: 'dep_c1',
        projectName: 'c-app-2',
        targetSha: 'sha_999',
        triggerType: 'manual',
      });

      expect(dep.id).toBe('dep_c1');
      expect(dep.status).toBe('queued');
      expect(dep.steps.length).toBeGreaterThan(0);

      depRepo.updateStatus('dep_c1', 'running');
      depRepo.updateStep('dep_c1', 'acquire-lock', { status: 'success', duration: 10 });
      depRepo.updateStatus('dep_c1', 'success');

      const stats = depRepo.getStats('c-app-2');
      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('success');
      expect(stats).toHaveProperty('failed');
      expect(stats).toHaveProperty('avgDurationMs');
      expect(stats.total).toBe(1);
      expect(stats.success).toBe(1);
    });

    it('satisfies StateRepository Lock contract', () => {
      const stateRepo = new StateRepository();

      const acquired = stateRepo.acquireLock('lock-proj', 'dep_100');
      expect(acquired).toBe(true);
      expect(stateRepo.isLocked('lock-proj')).toBe(true);

      const info = stateRepo.getLockInfo('lock-proj');
      expect(info?.lockedBy).toBe('dep_100');

      const released = stateRepo.releaseLock('lock-proj', 'dep_100');
      expect(released).toBe(true);
      expect(stateRepo.isLocked('lock-proj')).toBe(false);
    });
  });
});
