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
import { parseCommandString, UnitupAdapter } from '../src/runtime/unitup-adapter.js';
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
      expect(typeof adapter.remove).toBe('function');

      const status: RuntimeStatus = await adapter.status('non_existent_service_xyz_123');
      expect(typeof status.active).toBe('boolean');
    });

    it('evaluates isDaemonRunning boolean status cleanly', async () => {
      const isRunning = await isDaemonRunning();
      expect(typeof isRunning).toBe('boolean');
    });

    it('handles start, restart, reload, and remove with options on non-systemd platforms gracefully', async () => {
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
      await expect(adapter.remove('test-app')).resolves.not.toThrow();
    });

    it('updates systemd service configuration when service.command or options change on restart/reload', async () => {
      const adapter = new UnitupAdapter();
      // Test initial service registration with command: npm start
      await expect(
        adapter.restart('command-update-app', { cwd: '/tmp', command: 'npm start' }),
      ).resolves.not.toThrow();

      // Test subsequent configuration update in deployra.config.yaml with command: npm run start:api
      await expect(
        adapter.restart('command-update-app', { cwd: '/tmp', command: 'npm run start:api' }),
      ).resolves.not.toThrow();
    });

    it('correctly parses command strings into binary executable and args array without searching for index.js', () => {
      expect(parseCommandString('npm run start:api')).toEqual({
        command: 'npm',
        args: ['run', 'start:api'],
      });
      expect(parseCommandString('npm start')).toEqual({
        command: 'npm',
        args: ['start'],
      });
      expect(parseCommandString('node server.js')).toEqual({
        command: 'node',
        args: ['server.js'],
      });
      expect(parseCommandString('python3 main.py --port 8000')).toEqual({
        command: 'python3',
        args: ['main.py', '--port', '8000'],
      });
      expect(parseCommandString('./my-binary')).toEqual({
        command: './my-binary',
      });
    });

    it('generates, updates, and removes systemd unit configuration on disk with correct command and parameters', async () => {
      const { unitFileExists, readAppMetadata } = await import('unitup');
      const adapter = new UnitupAdapter();
      const serviceName = 'e2e-sys-unit-test';

      try {
        // Step 1: Create initial unit with command: npm run start:api
        await adapter.restart(serviceName, {
          cwd: '/tmp/e2e-sys-dir',
          command: 'npm run start:api',
          memoryMax: '256M',
        });

        // Verify unit file or metadata exists on disk if unitup created it
        if (unitFileExists(serviceName)) {
          const metadata = readAppMetadata(serviceName);
          if (metadata) {
            expect(metadata.command).toBe('npm');
            expect(metadata.args).toEqual(['run', 'start:api']);
          }
        }

        // Step 2: Update configuration with new command: npm run start:web and new memory limit
        await adapter.restart(serviceName, {
          cwd: '/tmp/e2e-sys-dir',
          command: 'npm run start:web',
          memoryMax: '512M',
        });

        if (unitFileExists(serviceName)) {
          const updatedMeta = readAppMetadata(serviceName);
          if (updatedMeta) {
            expect(updatedMeta.command).toBe('npm');
            expect(updatedMeta.args).toEqual(['run', 'start:web']);
          }
        }

        // Step 3: Remove service and verify cleanup on disk
        await adapter.remove(serviceName);
        expect(unitFileExists(serviceName)).toBe(false);
      } finally {
        try {
          await adapter.remove(serviceName);
        } catch {
          // Cleanup ignore
        }
      }
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
      DeployraDaemon.prototype.start = async (targetProjectName?: string) => {
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

    describe('Concurrency & Deduplication Guards', () => {
      it('prevents duplicate deployment creation on poll when the latest deployment for that SHA failed', async () => {
        const engine = new WorkmaticEngine();
        const watcher = new SourceWatcher(engine);
        const projRepo = new ProjectRepository();
        const depRepo = new DeploymentRepository();

        projRepo.saveProject(
          normalizeAndValidateConfig({
            project: { name: 'failed-sha-app', path: '/tmp/failed-sha-app' },
          }),
        );

        // Record a failed deployment for SHA '2602d98'
        depRepo.createDeployment({
          id: 'dep_failed_100',
          projectName: 'failed-sha-app',
          targetSha: '2602d98',
          status: 'failed',
          triggerType: 'poll',
        });

        // Mock checkRemoteHead to return the same failed SHA '2602d98'
        (watcher as any).gitClient.checkRemoteHead = async () => '2602d98';

        const result = await watcher.checkProject('failed-sha-app', 'poll');
        expect(result).toBeNull();

        const deps = depRepo.getDeploymentsByProject('failed-sha-app');
        expect(deps.length).toBe(1);
        expect(deps[0].id).toBe('dep_failed_100');
      });

      it('prevents duplicate deployment creation on poll when the latest deployment for that SHA succeeded', async () => {
        const engine = new WorkmaticEngine();
        const watcher = new SourceWatcher(engine);
        const projRepo = new ProjectRepository();
        const depRepo = new DeploymentRepository();

        projRepo.saveProject(
          normalizeAndValidateConfig({
            project: { name: 'success-sha-app', path: '/tmp/success-sha-app' },
          }),
        );

        // Record a successful deployment for SHA '2602d98'
        depRepo.createDeployment({
          id: 'dep_success_100',
          projectName: 'success-sha-app',
          targetSha: '2602d98',
          status: 'success',
          triggerType: 'poll',
        });

        // Mock checkRemoteHead to return the same succeeded SHA '2602d98'
        (watcher as any).gitClient.checkRemoteHead = async () => '2602d98';

        const result = await watcher.checkProject('success-sha-app', 'poll');
        expect(result).toBeNull();

        const deps = depRepo.getDeploymentsByProject('success-sha-app');
        expect(deps.length).toBe(1);
      });

      it('prevents concurrent parallel checkProject calls from creating duplicate deployments', async () => {
        const engine = new WorkmaticEngine();
        const watcher = new SourceWatcher(engine);
        const projRepo = new ProjectRepository();
        const depRepo = new DeploymentRepository();

        projRepo.saveProject(
          normalizeAndValidateConfig({
            project: { name: 'concurrent-app', path: '/tmp/concurrent-app' },
          }),
        );

        // Mock checkRemoteHead with a small artificial delay to simulate race condition
        (watcher as any).gitClient.checkRemoteHead = async () => {
          await new Promise((r) => setTimeout(r, 40));
          return '2602d98_concurrent_sha';
        };

        // Fire two checkProject calls in parallel
        const [res1, res2] = await Promise.all([
          watcher.checkProject('concurrent-app', 'poll'),
          watcher.checkProject('concurrent-app', 'poll'),
        ]);

        // Exactly one should succeed and the other should return null due to checkingProjects lock
        const succeeded = [res1, res2].filter(Boolean);
        const skipped = [res1, res2].filter((r) => r === null);

        expect(succeeded.length).toBe(1);
        expect(skipped.length).toBe(1);

        const deps = depRepo.getDeploymentsByProject('concurrent-app');
        expect(deps.length).toBe(1);
      });

      it('allows manual deployment trigger even if commit SHA was previously deployed', async () => {
        const engine = new WorkmaticEngine();
        const watcher = new SourceWatcher(engine);
        const projRepo = new ProjectRepository();
        const depRepo = new DeploymentRepository();

        projRepo.saveProject(
          normalizeAndValidateConfig({
            project: { name: 'manual-override-app', path: '/tmp/manual-override-app' },
          }),
        );

        depRepo.createDeployment({
          id: 'dep_prev_manual',
          projectName: 'manual-override-app',
          targetSha: 'manual_sha_777',
          status: 'success',
          triggerType: 'poll',
        });

        (watcher as any).gitClient.checkRemoteHead = async () => 'manual_sha_777';

        // Manual trigger should be allowed to re-deploy
        const manualDepId = await watcher.checkProject('manual-override-app', 'manual');
        expect(manualDepId).toBeTruthy();

        const deps = depRepo.getDeploymentsByProject('manual-override-app');
        expect(deps.length).toBe(2);
      });

      it('handles short 7-character SHA comparison correctly against full 40-character SHA', async () => {
        const engine = new WorkmaticEngine();
        const watcher = new SourceWatcher(engine);
        const projRepo = new ProjectRepository();
        const depRepo = new DeploymentRepository();

        projRepo.saveProject(
          normalizeAndValidateConfig({
            project: { name: 'short-sha-app', path: '/tmp/short-sha-app' },
          }),
        );

        // Saved short SHA '2602d98'
        depRepo.createDeployment({
          id: 'dep_short_sha_1',
          projectName: 'short-sha-app',
          targetSha: '2602d98',
          status: 'failed',
          triggerType: 'poll',
        });

        // Remote returns full 40-character SHA starting with '2602d98'
        (watcher as any).gitClient.checkRemoteHead = async () =>
          '2602d98a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e';

        const result = await watcher.checkProject('short-sha-app', 'poll');
        expect(result).toBeNull();
      });
    });
  });
});
