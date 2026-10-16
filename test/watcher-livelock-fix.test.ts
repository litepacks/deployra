import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { GitClient } from '../src/git/git-client.js';
import { WorkmaticEngine } from '../src/jobs/workmatic-engine.js';
import { Logger, logger } from '../src/logging/logger.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { ProjectRepository } from '../src/storage/project-repository.js';
import { SourceWatcher } from '../src/watcher/source-watcher.js';

describe('Deployra Daemon Watcher Live-lock & Log Flooding Fix Suite', () => {
  beforeEach(() => {
    process.env.DEPLOYRA_DB_PATH = ':memory:';
    resetDatabase();
  });

  afterAll(() => {
    closeDatabase();
  });

  describe('Logger Level Hierarchy and Systemd Info Filtering', () => {
    it('suppresses debug logs when level is info', () => {
      const logOutput: string[] = [];
      const testLogger = new Logger('pretty', 'info');
      const spy = vi.spyOn(console, 'log').mockImplementation((msg) => {
        logOutput.push(msg);
      });

      testLogger.debug('This debug log should be suppressed');
      expect(logOutput.length).toBe(0);

      testLogger.info('This info log should appear');
      expect(logOutput.length).toBe(1);
      expect(logOutput[0]).toContain('This info log should appear');

      spy.mockRestore();
    });

    it('allows debug logs when level is explicitly set to debug', () => {
      const logOutput: string[] = [];
      const testLogger = new Logger('pretty', 'debug');
      const spy = vi.spyOn(console, 'log').mockImplementation((msg) => {
        logOutput.push(msg);
      });

      testLogger.debug('This debug log should appear');
      expect(logOutput.length).toBe(1);
      expect(logOutput[0]).toContain('This debug log should appear');

      spy.mockRestore();
    });
  });

  describe('SourceWatcher In-Flight Concurrency & Rate Limiting', () => {
    it('updates timestamp and throttles concurrent check logs', async () => {
      const engine = new WorkmaticEngine();
      const watcher = new SourceWatcher(engine);
      const projRepo = new ProjectRepository();

      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: {
            name: 'throttle-app',
            path: '/tmp/throttle-app',
            watch: { intervalMs: 5000 },
          },
        }),
      );

      let resolveRemoteCheck: (sha: string) => void = () => {};
      const remotePromise = new Promise<string>((resolve) => {
        resolveRemoteCheck = resolve;
      });

      (watcher as any).gitClient.checkRemoteHead = async () => {
        return await remotePromise;
      };

      // 1. Start the in-flight check
      const check1Promise = watcher.checkProject('throttle-app', 'poll');

      // Ensure in-flight check is active
      expect((watcher as any).checkingProjects.has('throttle-app')).toBe(true);

      const debugLogs: string[] = [];
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation((msg) => {
        debugLogs.push(msg);
      });

      // 2. Concurrently attempt 2nd check while 1st is still running
      const res2 = await watcher.checkProject('throttle-app', 'poll');
      expect(res2).toBeNull();

      // Timestamp must be updated to prevent fake stalled status
      const timestampAfterFirstConcurrent = (watcher as any).lastCheckTimestamps.get(
        'throttle-app',
      );
      expect(timestampAfterFirstConcurrent).toBeGreaterThan(0);

      // First concurrent check should produce a log if debug is enabled
      expect(debugLogs.length).toBe(1);
      expect(debugLogs[0]).toContain('already in progress');

      // 3. Immediately attempt 3rd concurrent check (must be rate-limited / suppressed)
      const res3 = await watcher.checkProject('throttle-app', 'poll');
      expect(res3).toBeNull();
      // Should STILL be 1 log because 5 minutes have not passed
      expect(debugLogs.length).toBe(1);

      // Finish first check
      resolveRemoteCheck('sha_test_123');
      await check1Promise;

      debugSpy.mockRestore();
      await watcher.stop();
    });

    it('does not mark in-flight project as stalled in syncProjects', async () => {
      const engine = new WorkmaticEngine();
      const watcher = new SourceWatcher(engine);
      const projRepo = new ProjectRepository();

      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: {
            name: 'stalled-check-app',
            path: '/tmp/stalled-check-app',
            watch: { intervalMs: 5000 },
          },
        }),
      );

      let resolveRemoteCheck: (sha: string) => void = () => {};
      const remotePromise = new Promise<string>((resolve) => {
        resolveRemoteCheck = resolve;
      });

      (watcher as any).gitClient.checkRemoteHead = async () => {
        return await remotePromise;
      };

      // Start in-flight check
      const checkPromise = watcher.checkProject('stalled-check-app', 'poll');

      // Artificially simulate an older lastCheck timestamp (> 30s ago)
      (watcher as any).lastCheckTimestamps.set('stalled-check-app', Date.now() - 40000);

      const warnLogs: string[] = [];
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((msg) => {
        warnLogs.push(msg);
      });

      // Run syncProjects
      await watcher.syncProjects();

      // Because the project is in-flight, it must NOT be marked stalled or revived with 0 delay!
      const stalledWarnings = warnLogs.filter((m) => m.includes('was stalled'));
      expect(stalledWarnings.length).toBe(0);

      // Complete in-flight check
      resolveRemoteCheck('sha_stalled_test');
      await checkPromise;

      warnSpy.mockRestore();
      await watcher.stop();
    });

    it('detects and terminates stuck zombie check exceeding 45 seconds', async () => {
      const engine = new WorkmaticEngine();
      const watcher = new SourceWatcher(engine);
      const projRepo = new ProjectRepository();

      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: {
            name: 'zombie-app',
            path: '/tmp/zombie-app',
            watch: { intervalMs: 5000 },
          },
        }),
      );

      const abortController = new AbortController();
      let aborted = false;
      abortController.signal.addEventListener('abort', () => {
        aborted = true;
      });

      // Simulate a check that has been in-flight for 50 seconds (> 45s timeout)
      (watcher as any).checkingProjects.set('zombie-app', {
        startTime: Date.now() - 50000,
        abortController,
      });

      const errorLogs: string[] = [];
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation((msg) => {
        errorLogs.push(msg);
      });

      // Run syncProjects to trigger zombie watchdog
      await watcher.syncProjects();

      // Child process must have been aborted
      expect(aborted).toBe(true);

      // In-flight entry must have been cleared
      expect((watcher as any).checkingProjects.has('zombie-app')).toBe(false);

      // Error count must have been incremented
      expect((watcher as any).errorCounts.get('zombie-app')).toBe(1);

      // A timer should now be scheduled with exponential backoff
      expect((watcher as any).timers.has('zombie-app')).toBe(true);

      const zombieErrors = errorLogs.filter((m) => m.includes('[ZOMBIE-CHECK]'));
      expect(zombieErrors.length).toBe(1);

      errorSpy.mockRestore();
      await watcher.stop();
    });
  });

  describe('GitClient Mutlak Timeout & AbortSignal', () => {
    it('passes signal to execGit and checkRemoteHead to allow cancellation', async () => {
      const gitClient = new GitClient();
      const controller = new AbortController();

      // Immediately abort
      controller.abort();

      await expect(
        gitClient.checkRemoteHead('/tmp', 'origin', 'main', {
          timeoutMs: 1000,
          signal: controller.signal,
        }),
      ).rejects.toThrow();
    });
  });
});
