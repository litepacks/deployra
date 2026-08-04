import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import type { NormalizedDeployraConfig } from '../src/config/types.js';
import { CommandExecutionError, RepositoryError } from '../src/errors/deployra-error.js';
import { GitClient } from '../src/git/git-client.js';
import { WorkmaticEngine } from '../src/jobs/workmatic-engine.js';
import { maskSecrets } from '../src/logging/masker.js';
import {
  ReadyCheckerAdapter,
  type ReadyCheckResult,
} from '../src/readiness/ready-checker-adapter.js';
import { isDaemonRunning } from '../src/runtime/daemon-check.js';
import type { RuntimeManager, RuntimeStatus } from '../src/runtime/runtime-manager.js';
import { UnitupAdapter } from '../src/runtime/unitup-adapter.js';
import { safeExec } from '../src/security/exec.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';
import { StateRepository } from '../src/storage/state-repository.js';
import { SourceWatcher } from '../src/watcher/source-watcher.js';

describe('Contract Tests', () => {
  beforeEach(() => {
    process.env.DEPLOYRA_DB_PATH = ':memory:';
    resetDatabase();
  });

  afterAll(() => {
    closeDatabase();
  });

  describe('RuntimeManager Contract (UnitupAdapter)', () => {
    it('satisfies RuntimeManager interface contract', async () => {
      const adapter: RuntimeManager = new UnitupAdapter();
      expect(typeof adapter.start).toBe('function');
      expect(typeof adapter.stop).toBe('function');
      expect(typeof adapter.restart).toBe('function');
      expect(typeof adapter.status).toBe('function');

      const status: RuntimeStatus = await adapter.status('non_existent_service_xyz_123');
      expect(typeof status.active).toBe('boolean');
    });

    it('evaluates isDaemonRunning boolean status cleanly', async () => {
      const isRunning = await isDaemonRunning();
      expect(typeof isRunning).toBe('boolean');
    });

    it('handles start, restart, reload with options on non-systemd platforms gracefully', async () => {
      const adapter = new UnitupAdapter();
      await expect(
        adapter.start('test-app', { cwd: '/tmp', script: 'index.js' }),
      ).resolves.not.toThrow();
      await expect(
        adapter.restart('test-app', { cwd: '/tmp', script: 'index.js' }),
      ).resolves.not.toThrow();
      await expect(
        adapter.reload('test-app', { cwd: '/tmp', script: 'index.js' }),
      ).resolves.not.toThrow();
    });
  });

  describe('ReadinessChecker Contract (ReadyCheckerAdapter)', () => {
    it('returns valid ReadyCheckResult contract structure when checks pass or empty', async () => {
      const adapter = new ReadyCheckerAdapter();
      const emptyConfig: NormalizedDeployraConfig['deploy']['ready'] = {
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

    it('evaluates file and command check contract structures correctly', async () => {
      const adapter = new ReadyCheckerAdapter();
      const checkConfig: NormalizedDeployraConfig['deploy']['ready'] = {
        timeoutMs: 3000,
        intervalMs: 500,
        mode: 'all',
        checks: [
          { type: 'command', command: 'echo ready_ok', expectedExitCode: 0 },
          { type: 'file', path: '/etc/hosts' },
        ],
      };

      const result = await adapter.wait(checkConfig);
      expect(result.ready).toBe(true);
      expect(result.checks.length).toBe(2);
      expect(result.checks[0].type).toBe('command');
      expect(result.checks[1].type).toBe('file');
      expect(result.checks[0].success).toBe(true);
      expect(result.checks[1].success).toBe(true);
    });
  });

  describe('Config Normalizer Contract', () => {
    it('produces a complete NormalizedDeployraConfig contract from minimal input', () => {
      const minimalRaw = {
        project: { name: 'contract-app', path: '/var/www/contract-app' },
      };

      const normalized: NormalizedDeployraConfig = normalizeAndValidateConfig(minimalRaw);

      // Verify contract shape
      expect(normalized.project.name).toBe('contract-app');
      expect(normalized.source.remote).toBe('origin');
      expect(normalized.source.branch).toBe('main');
      expect(normalized.watch.intervalMs).toBe(30000);
      expect(normalized.deploy.concurrency).toBe(1);
      expect(normalized.deploy.queueMode).toBe('latest');
      expect(normalized.deploy.dirtyWorkspace).toBe('reject');
    });
  });

  describe('Storage Repository Contracts', () => {
    it('satisfies ProjectRepository contract', () => {
      const projRepo = new ProjectRepository();
      const config = normalizeAndValidateConfig({
        project: { name: 'storage-app', path: '/var/www/storage-app' },
      });

      const saved = projRepo.saveProject(config);
      expect(saved.name).toBe('storage-app');

      const retrieved = projRepo.getProject('storage-app');
      expect(retrieved?.name).toBe('storage-app');

      const all = projRepo.getAllProjects();
      expect(all.length).toBe(1);

      const deleted = projRepo.deleteProject('storage-app');
      expect(deleted).toBe(true);
    });

    it('satisfies DeploymentRepository & Stats contract', () => {
      const projRepo = new ProjectRepository();
      const depRepo = new DeploymentRepository();

      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'dep-contract-app', path: '/tmp/dep-contract' },
        }),
      );

      const created = depRepo.createDeployment({
        id: 'dep_contract_1',
        projectName: 'dep-contract-app',
        targetSha: 'sha1234',
        triggerType: 'manual',
      });

      expect(created.id).toBe('dep_contract_1');
      expect(created.status).toBe('queued');

      depRepo.updateStatus('dep_contract_1', 'success');
      const updated = depRepo.getDeployment('dep_contract_1');
      expect(updated?.status).toBe('success');

      const stats = depRepo.getStats('dep-contract-app');
      expect(stats.total).toBe(1);
      expect(stats.success).toBe(1);
    });

    it('satisfies StateRepository Lock contract', () => {
      const stateRepo = new StateRepository();

      const acquired = stateRepo.acquireLock('lock-proj', 'dep-1');
      expect(acquired).toBe(true);

      const isLocked = stateRepo.isLocked('lock-proj');
      expect(isLocked).toBe(true);

      const released = stateRepo.releaseLock('lock-proj', 'dep-1');
      expect(released).toBe(true);
    });
  });

  describe('Workmatic Job Queue Contract', () => {
    it('enqueues deployment job and fulfills contract', async () => {
      const engine = new WorkmaticEngine();
      await engine.startWorker();

      const jobId = await engine.enqueueDeployJob({
        deploymentId: 'dep_job_1',
        projectName: 'wm-app',
        targetSha: 'sha_wm_1',
        triggerType: 'poll',
        triggeredAt: Date.now(),
      });

      expect(typeof jobId).toBe('string');
      await engine.stopWorker();
    });
  });

  describe('Security & Execution Contracts', () => {
    it('safeExec returns stdout/stderr contract on success and throws CommandExecutionError on failure', async () => {
      const res = await safeExec('echo', ['hello_contract']);
      expect(res.stdout.trim()).toBe('hello_contract');
      expect(res.exitCode).toBe(0);

      await expect(safeExec('node', ['-e', 'process.exit(2)'])).rejects.toThrow(
        CommandExecutionError,
      );
    });

    it('maskSecrets contract redacts sensitive values correctly', () => {
      const text = 'Authorization: Bearer secret_token_12345';
      const masked = maskSecrets(text);
      expect(masked).toContain('[REDACTED');
      expect(masked).not.toContain('secret_token_12345');
    });
  });

  describe('GitClient Contract', () => {
    it('throws RepositoryError when validating non-existent repository path', async () => {
      const client = new GitClient();
      await expect(
        client.validateRepository('/non/existent/path/deployra', 'origin'),
      ).rejects.toThrow(RepositoryError);
    });
  });

  describe('SourceWatcher Auto-Discovery Contract', () => {
    it('monitors all registered projects when started without a target project name', async () => {
      const engine = new WorkmaticEngine();
      const watcher = new SourceWatcher(engine);
      const projRepo = new ProjectRepository();

      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'app-alpha', path: '/tmp/app-alpha' },
        }),
      );
      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'app-beta', path: '/tmp/app-beta' },
        }),
      );

      await watcher.start();

      expect((watcher as any).timers.has('app-alpha')).toBe(true);
      expect((watcher as any).timers.has('app-beta')).toBe(true);

      await watcher.stop();
    });

    it('monitors ONLY the specified target project when targetProjectName is provided', async () => {
      const engine = new WorkmaticEngine();
      const watcher = new SourceWatcher(engine);
      const projRepo = new ProjectRepository();

      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'app-alpha', path: '/tmp/app-alpha' },
        }),
      );
      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'app-beta', path: '/tmp/app-beta' },
        }),
      );

      await watcher.start('app-alpha');

      expect((watcher as any).timers.has('app-alpha')).toBe(true);
      expect((watcher as any).timers.has('app-beta')).toBe(false);

      await watcher.stop();
    });

    it('handles dynamic project additions and deletions during syncProjects', async () => {
      const engine = new WorkmaticEngine();
      const watcher = new SourceWatcher(engine);
      const projRepo = new ProjectRepository();

      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'app-alpha', path: '/tmp/app-alpha' },
        }),
      );
      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'app-beta', path: '/tmp/app-beta' },
        }),
      );

      await watcher.start();

      // Add app-gamma, delete app-beta
      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'app-gamma', path: '/tmp/app-gamma' },
        }),
      );
      projRepo.deleteProject('app-beta');

      await watcher.syncProjects();

      expect((watcher as any).timers.has('app-alpha')).toBe(true);
      expect((watcher as any).timers.has('app-gamma')).toBe(true);
      expect((watcher as any).timers.has('app-beta')).toBe(false);

      await watcher.stop();
    });

    it('skips duplicate deployment creation when a deployment for the same commit SHA is already active', async () => {
      const engine = new WorkmaticEngine();
      const watcher = new SourceWatcher(engine);
      const projRepo = new ProjectRepository();
      const depRepo = new DeploymentRepository();

      const config = normalizeAndValidateConfig({
        project: { name: 'dup-sha-app', path: '/tmp/dup-sha-app' },
      });
      projRepo.saveProject(config);

      depRepo.createDeployment({
        id: 'dep_active_123',
        projectName: 'dup-sha-app',
        targetSha: '973f5de',
        status: 'running',
        triggerType: 'poll',
      });

      // Mock checkRemoteHead to return the same active SHA '973f5de'
      (watcher as any).gitClient.checkRemoteHead = async () => '973f5de';

      const result = await watcher.checkProject('dup-sha-app', 'poll');
      expect(result).toBeNull();
    });

    it('watchCommand passes trimmed target when specified, and undefined when omitted', async () => {
      const { watchCommand } = await import('../src/cli/commands/watch.js');
      const { DeployraDaemon } = await import('../src/daemon.js');

      const captured: (string | undefined)[] = [];
      const originalStart = DeployraDaemon.prototype.start;
      DeployraDaemon.prototype.start = async function (targetProjectName?: string) {
        captured.push(targetProjectName);
      };

      try {
        await watchCommand();
        await watchCommand('  my-specific-app  ');

        expect(captured).toEqual([undefined, 'my-specific-app']);
      } finally {
        DeployraDaemon.prototype.start = originalStart;
      }
    });
  });
});
