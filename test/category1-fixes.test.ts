import http from 'node:http';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { RollbackManager } from '../src/deployment/rollback-manager.js';
import { WorkmaticEngine } from '../src/jobs/workmatic-engine.js';
import { DeploymentPipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { ReadyCheckerAdapter } from '../src/readiness/ready-checker-adapter.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';
import { StateRepository } from '../src/storage/state-repository.js';
import { SourceWatcher } from '../src/watcher/source-watcher.js';

describe('Category 1 Critical Bug Fixes', () => {
  beforeEach(() => {
    process.env.DEPLOYRA_DB_PATH = ':memory:';
    process.env.WORKMATIC_DB_PATH = ':memory:';
    resetDatabase();
  });

  afterAll(() => {
    closeDatabase();
  });

  it('1. abortAllDeploymentsForProject aborts only target project deployments without affecting other projects', () => {
    const runner = new DeploymentPipelineRunner();

    const controllerA1 = new AbortController();
    const controllerA2 = new AbortController();
    const controllerB1 = new AbortController();

    (runner as any).activeAbortControllers.set('dep_a1', {
      controller: controllerA1,
      projectName: 'project-a',
    });
    (runner as any).activeAbortControllers.set('dep_a2', {
      controller: controllerA2,
      projectName: 'project-a',
    });
    (runner as any).activeAbortControllers.set('dep_b1', {
      controller: controllerB1,
      projectName: 'project-b',
    });

    runner.abortAllDeploymentsForProject('project-a', 'New commit arrived for project A');

    // Project A controllers MUST be aborted
    expect(controllerA1.signal.aborted).toBe(true);
    expect(controllerA2.signal.aborted).toBe(true);
    expect((runner as any).activeAbortControllers.has('dep_a1')).toBe(false);
    expect((runner as any).activeAbortControllers.has('dep_a2')).toBe(false);

    // Project B controller MUST NOT be aborted
    expect(controllerB1.signal.aborted).toBe(false);
    expect((runner as any).activeAbortControllers.has('dep_b1')).toBe(true);
  });

  it('2. queueMode: reject does NOT drop commit from subsequent polls by premature lastSeenSha update', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const engine = new WorkmaticEngine();
    const watcher = new SourceWatcher(engine);

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'reject-app', path: '/tmp/reject-app' },
        deploy: { queueMode: 'reject' },
      }),
    );

    // Create an active running deployment
    depRepo.createDeployment({
      id: 'dep_active_1',
      projectName: 'reject-app',
      targetSha: 'sha_first_111',
      status: 'running',
      triggerType: 'poll',
    });

    // Mock remote head returning a new commit
    (watcher as any).gitClient.checkRemoteHead = async () => 'sha_new_222';

    // First check while active deployment is running -> should reject
    const result1 = await watcher.checkProject('reject-app', 'poll');
    expect(result1).toBeNull();

    // Verify lastSeenSha was NOT updated to sha_new_222 prematurely
    const projAfterReject = projRepo.getProject('reject-app');
    expect(projAfterReject?.lastSeenSha).not.toBe('sha_new_222');

    // Now active deployment finishes
    depRepo.updateStatus('dep_active_1', 'success');

    // Next poll with sha_new_222 -> MUST now be detected and enqueued!
    const result2 = await watcher.checkProject('reject-app', 'poll');
    expect(result2).toBeTruthy();

    const enqueuedDep = depRepo.getDeployment(result2!);
    expect(enqueuedDep?.targetSha).toBe('sha_new_222');
  });

  it('3. RollbackManager correctly parses and executes commands with quotes without breaking arguments', async () => {
    const rollbackManager = new RollbackManager();

    // Mock gitClient methods to avoid needing a real git repo
    (rollbackManager as any).gitClient.resetHard = async () => {};
    (rollbackManager as any).gitClient.cleanUntracked = async () => {};
    (rollbackManager as any).unitupAdapter.restart = async () => {};

    const config = normalizeAndValidateConfig({
      project: { name: 'cmd-app', path: '/tmp' },
      deploy: {
        commands: {
          install: [
            'node -e "if (!process.argv[1]) throw new Error(\'Missing arg\')" "arg with space"',
          ],
          build: ['node -e "console.log(\'build ok\')"'],
        },
        service: {
          name: 'cmd-app',
          action: 'none',
        },
      },
    });

    await expect(
      rollbackManager.rollback({
        projectName: 'cmd-app',
        projectPath: '/tmp',
        previousSuccessfulSha: 'abc1234',
        config,
      }),
    ).resolves.not.toThrow();
  });

  it('4. ReadyCheckerAdapter verifies expect.status (e.g. 201) and expect.bodyIncludes correctly', async () => {
    // Spin up an ephemeral HTTP server returning status 201 with body text
    const server = http.createServer((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'auth-service' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;
    const testUrl = `http://127.0.0.1:${port}/health`;

    const adapter = new ReadyCheckerAdapter();

    try {
      // 4a. Check with matching expected status 201 and bodyIncludes
      const passResult = await adapter.wait({
        timeoutMs: 3000,
        intervalMs: 100,
        mode: 'all',
        checks: [
          {
            type: 'http',
            url: testUrl,
            expect: {
              status: 201,
              bodyIncludes: 'auth-service',
            },
          },
        ],
      });
      expect(passResult.ready).toBe(true);

      // 4b. Check expecting 200 (should fail since server returns 201)
      await expect(
        adapter.wait({
          timeoutMs: 400,
          intervalMs: 100,
          mode: 'all',
          checks: [
            {
              type: 'http',
              url: testUrl,
              expect: {
                status: 200,
              },
            },
          ],
        }),
      ).rejects.toThrow(/HTTP status 201, expected 200/);

      // 4c. Check with missing body string
      await expect(
        adapter.wait({
          timeoutMs: 400,
          intervalMs: 100,
          mode: 'all',
          checks: [
            {
              type: 'http',
              url: testUrl,
              expect: {
                status: 201,
                bodyIncludes: 'non-existent-keyword',
              },
            },
          ],
        }),
      ).rejects.toThrow(/Response body does not contain expected 'non-existent-keyword'/);
    } finally {
      server.close();
    }
  });

  it('5. StateRepository clears stale lock when holding deployment has reached a terminal status', () => {
    const stateRepo = new StateRepository();
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'my-proj', path: '/tmp/my-proj' },
      }),
    );

    depRepo.createDeployment({
      id: 'dep_cancelled_999',
      projectName: 'my-proj',
      targetSha: 'sha_1',
      status: 'running',
      triggerType: 'manual',
    });

    stateRepo.acquireLock('my-proj', 'dep_cancelled_999');

    // Second deployment cannot acquire while first is running
    expect(stateRepo.acquireLock('my-proj', 'dep_real_111')).toBe(false);

    // First deployment is cancelled
    depRepo.updateStatus('dep_cancelled_999', 'cancelled');

    // Now second deployment CAN acquire because first deployment is finished
    const acquired = stateRepo.acquireLock('my-proj', 'dep_real_111');
    expect(acquired).toBe(true);

    const info = stateRepo.getLockInfo('my-proj');
    expect(info?.lockedBy).toBe('dep_real_111');
  });

  it('6. DeploymentPipelineRunner handles deployment cancellation cleanly without triggering rollback', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const runner = new DeploymentPipelineRunner();

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'cancel-pipe-app', path: '/tmp/cancel-pipe-app' },
        deploy: {
          rollback: { enabled: true },
          commands: {
            install: ['sleep 1'],
          },
        },
      }),
    );

    depRepo.createDeployment({
      id: 'dep_cancel_test_1',
      projectName: 'cancel-pipe-app',
      targetSha: 'sha_new_555',
      previousSha: 'sha_prev_000',
      status: 'queued',
      triggerType: 'manual',
    });

    let rollbackTriggered = false;
    (runner as any).rollbackManager.rollback = async () => {
      rollbackTriggered = true;
    };

    // Pre-mark deployment as cancelled (as deployra cancel would do)
    depRepo.updateStatus('dep_cancel_test_1', 'cancelled', 'Manually cancelled');

    await runner.runDeployment({
      deploymentId: 'dep_cancel_test_1',
      projectName: 'cancel-pipe-app',
      targetSha: 'sha_new_555',
      previousSha: 'sha_prev_000',
      triggerType: 'manual',
      triggeredAt: Date.now(),
    });

    const finalDep = depRepo.getDeployment('dep_cancel_test_1');
    expect(finalDep?.status).toBe('cancelled');
    expect(rollbackTriggered).toBe(false);
  });
});
