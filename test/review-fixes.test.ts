import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { resolveServiceEnv } from '../src/deployment/deploy-env.js';
import { RollbackManager } from '../src/deployment/rollback-manager.js';
import {
  isSyncExcluded,
  resolveSyncExcludes,
  syncIsolatedWorkspace,
} from '../src/deployment/workspace-sync.js';
import { PreflightError } from '../src/errors/deployra-error.js';
import { WorkmaticEngine } from '../src/jobs/workmatic-engine.js';
import { DeploymentPipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { safeExec } from '../src/security/exec.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';
import { StateRepository } from '../src/storage/state-repository.js';
import { SourceWatcher } from '../src/watcher/source-watcher.js';

describe('Package review fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    process.env.DEPLOYRA_DB_PATH = ':memory:';
    process.env.WORKMATIC_DB_PATH = ':memory:';
    resetDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-review-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  afterAll(() => {
    closeDatabase();
  });

  const zeroDowntimeProject = (name: string, commands: Record<string, string[]>) => {
    const projectPath = path.join(tmpDir, name);
    fs.mkdirSync(projectPath, { recursive: true });
    new ProjectRepository().saveProject(
      normalizeAndValidateConfig({
        project: { name, path: projectPath },
        deploy: {
          strategy: 'zero-downtime',
          retry: { attempts: 0, backoff: '1s' },
          rollback: { enabled: true },
          commands,
        },
      }),
    );
    new DeploymentRepository().createDeployment({
      id: `dep_${name}`,
      projectName: name,
      targetSha: 'sha_new_111',
      previousSha: 'sha_prev_000',
      status: 'queued',
      triggerType: 'manual',
    });
    return projectPath;
  };

  const stubRunner = (runner: DeploymentPipelineRunner) => {
    const r = runner as any;
    r.gitClient.validateRepository = async () => {};
    r.gitClient.isDirty = async () => false;
    r.gitClient.fetchBranch = async () => {};
    r.gitClient.checkRemoteHead = async () => 'sha_new_111';
    r.gitClient.resetHard = async () => {};
    r.reloadConfigFromWorkingDir = () => null;
    r.notificationService.sendDeploymentNotification = async () => {};
    const stop = vi.fn(async () => {});
    r.unitupAdapter.stop = stop;
    const deployZeroDowntime = vi.fn(async () => ({
      service: 'svc',
      previousGeneration: 1,
      currentGeneration: 2,
      downtimeMs: 0,
      status: 'success',
    }));
    r.unitupAdapter.deployZeroDowntime = deployZeroDowntime;
    const rollback = vi.fn(async () => {});
    r.rollbackManager.rollback = rollback;
    return { stop, deployZeroDowntime, rollback };
  };

  const run = (runner: DeploymentPipelineRunner, name: string) =>
    runner.runDeployment({
      deploymentId: `dep_${name}`,
      projectName: name,
      targetSha: 'sha_new_111',
      previousSha: 'sha_prev_000',
      triggerType: 'manual',
      triggeredAt: Date.now(),
    });

  describe('zero-downtime pipeline', () => {
    it('does not stop the supervisor before install', async () => {
      zeroDowntimeProject('zd-install', { install: ['true'], build: [] });
      const runner = new DeploymentPipelineRunner();
      const { stop, deployZeroDowntime } = stubRunner(runner);

      await run(runner, 'zd-install');

      expect(new DeploymentRepository().getDeployment('dep_zd-install')?.status).toBe('success');
      expect(stop).not.toHaveBeenCalled();
      expect(deployZeroDowntime).toHaveBeenCalledOnce();
    });

    it('does not roll back when pre-flight fails before anything changed', async () => {
      zeroDowntimeProject('zd-preflight', { install: [], build: [] });
      const runner = new DeploymentPipelineRunner();
      const { rollback } = stubRunner(runner);
      (runner as any).runPortPreflight = async () => {
        throw new PreflightError('Public port 8228 is already occupied');
      };

      await run(runner, 'zd-preflight');

      expect(new DeploymentRepository().getDeployment('dep_zd-preflight')?.status).toBe('failed');
      expect(rollback).not.toHaveBeenCalled();
    });

    it('restores files without switching generations when the build fails', async () => {
      zeroDowntimeProject('zd-build', { install: [], build: ['false'] });
      const runner = new DeploymentPipelineRunner();
      const { rollback, deployZeroDowntime } = stubRunner(runner);

      await run(runner, 'zd-build');

      expect(deployZeroDowntime).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledOnce();
      expect(rollback.mock.calls[0]?.[0]).toMatchObject({
        previousSuccessfulSha: 'sha_prev_000',
        serviceAffected: false,
        revertGeneration: false,
      });
    });
  });

  describe('rollback manager', () => {
    it('leaves the active generation alone when the service was not affected', async () => {
      const manager = new RollbackManager();
      const rollbackZeroDowntime = vi.fn(async () => ({}));
      (manager as any).unitupAdapter.rollbackZeroDowntime = rollbackZeroDowntime;

      await manager.rollback({
        projectName: 'zd-app',
        projectPath: tmpDir,
        config: normalizeAndValidateConfig({
          project: { name: 'zd-app', path: tmpDir },
          deploy: { strategy: 'zero-downtime' },
        }),
        serviceAffected: false,
        revertGeneration: false,
      });

      expect(rollbackZeroDowntime).not.toHaveBeenCalled();
    });
  });

  describe('superseding deployments (queueMode: latest)', () => {
    it('does not abort or cancel a deployment that is already changing the live service', () => {
      const runner = new DeploymentPipelineRunner();
      const critical = new AbortController();
      const early = new AbortController();
      const controllers = (runner as any).activeAbortControllers as Map<string, any>;
      controllers.set('dep_critical', { controller: critical, projectName: 'p', critical: true });
      controllers.set('dep_early', { controller: early, projectName: 'p', critical: false });

      runner.abortAllDeploymentsForProject('p', 'newer commit');

      expect(critical.signal.aborted).toBe(false);
      expect(early.signal.aborted).toBe(true);
      expect(runner.getCriticalDeploymentIds('p')).toEqual(['dep_critical']);
    });

    it('cancelPendingDeployments skips excluded deployment ids', () => {
      const repo = new DeploymentRepository();
      new ProjectRepository().saveProject(
        normalizeAndValidateConfig({ project: { name: 'q', path: tmpDir } }),
      );
      for (const id of ['dep_q1', 'dep_q2']) {
        repo.createDeployment({
          id,
          projectName: 'q',
          targetSha: id,
          status: 'running',
          triggerType: 'manual',
        });
      }

      const cancelled = repo.cancelPendingDeployments('q', 'newer', ['dep_q1']);

      expect(cancelled.map((d) => d.id)).toEqual(['dep_q2']);
      expect(repo.getDeployment('dep_q1')?.status).toBe('running');
    });
  });

  describe('project lock heartbeat', () => {
    it('refreshLock extends a held lock only for its holder', () => {
      const repo = new StateRepository();
      expect(repo.acquireLock('locked-proj', 'dep_a')).toBe(true);
      const before = repo.getLockInfo('locked-proj')!.lockedAt;
      vi.spyOn(Date, 'now').mockReturnValue(before + 60_000);

      expect(repo.refreshLock('locked-proj', 'dep_b')).toBe(false);
      expect(repo.refreshLock('locked-proj', 'dep_a')).toBe(true);
      expect(repo.getLockInfo('locked-proj')!.lockedAt).toBe(before + 60_000);
    });
  });

  describe('webhook redelivery', () => {
    it('does not queue a second deployment for a commit that is already deploying', async () => {
      new ProjectRepository().saveProject(
        normalizeAndValidateConfig({ project: { name: 'hook-app', path: tmpDir } }),
      );
      const sha = 'b'.repeat(40);
      new DeploymentRepository().createDeployment({
        id: 'dep_hook_1',
        projectName: 'hook-app',
        targetSha: sha,
        status: 'running',
        triggerType: 'webhook',
      });
      const watcher = new SourceWatcher(new WorkmaticEngine({ dbPath: ':memory:' }));

      const result = await watcher.checkProject('hook-app', 'webhook', false, sha);

      expect(result).toBeNull();
    });
  });

  describe('isolated workspace sync', () => {
    it('matches exclude patterns by segment or by root-relative path', () => {
      const excludes = resolveSyncExcludes(['public/uploads/', '.env.production']);
      expect(isSyncExcluded('.git/HEAD', excludes)).toBe(true);
      expect(isSyncExcluded('.env.local', excludes)).toBe(true);
      expect(isSyncExcluded('public/uploads/a.png', excludes)).toBe(true);
      expect(isSyncExcluded('.github/workflows/ci.yml', excludes)).toBe(false);
      expect(isSyncExcluded('.gitignore', excludes)).toBe(false);
      expect(isSyncExcluded('src/uploads/a.ts', excludes)).toBe(false);
    });

    it('keeps env files and excluded runtime data in the target directory', async () => {
      const source = path.join(tmpDir, 'workspace');
      const target = path.join(tmpDir, 'live');
      fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(source, 'dist', 'app.js'), 'new');
      fs.mkdirSync(path.join(target, 'data'), { recursive: true });
      fs.writeFileSync(path.join(target, '.env'), 'SECRET=1');
      fs.writeFileSync(path.join(target, 'data', 'app.sqlite'), 'db');

      await syncIsolatedWorkspace(source, target, resolveSyncExcludes(['data/']));

      expect(fs.readFileSync(path.join(target, 'dist', 'app.js'), 'utf8')).toBe('new');
      expect(fs.existsSync(path.join(target, '.env'))).toBe(true);
      expect(fs.existsSync(path.join(target, 'data', 'app.sqlite'))).toBe(true);
    });
  });

  describe('service environment', () => {
    it('passes inline env and the absolute envFile path to the service', () => {
      fs.writeFileSync(path.join(tmpDir, '.env.production'), 'API_KEY=x');
      const config = normalizeAndValidateConfig({
        project: { name: 'env-app', path: tmpDir },
        deploy: { envFile: '.env.production', env: { NODE_ENV: 'production' } },
      });

      expect(resolveServiceEnv(config, tmpDir)).toEqual({
        env: { NODE_ENV: 'production' },
        envFile: path.join(tmpDir, '.env.production'),
      });
    });
  });

  describe('safeExec output buffering', () => {
    it('keeps the tail of oversized output where failures are reported', async () => {
      const res = await safeExec(
        process.execPath,
        ['-e', "process.stdout.write('a'.repeat(5000) + 'END')"],
        { maxBufferBytes: 100 },
      );
      expect(res.stdout.length).toBe(100);
      expect(res.stdout.endsWith('END')).toBe(true);
    });
  });
});
