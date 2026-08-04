import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { WorkmaticEngine } from '../src/jobs/workmatic-engine.js';
import { DeploymentPipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { safeExec } from '../src/security/exec.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';
import { StateRepository } from '../src/storage/state-repository.js';
import { SourceWatcher } from '../src/watcher/source-watcher.js';
import { createSampleServer } from './fixtures/sample-server.js';

describe('Deployra End-to-End (E2E) Pipeline', () => {
  let tmpDir: string;
  let remoteRepoPath: string;
  let workDir: string;
  let targetPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-e2e-'));
    process.env.DEPLOYRA_DB_PATH = path.join(tmpDir, 'deployra.db');
    process.env.WORKMATIC_DB_PATH = path.join(tmpDir, 'workmatic.db');
    resetDatabase();
    remoteRepoPath = path.join(tmpDir, 'remote.git');
    workDir = path.join(tmpDir, 'work');
    targetPath = path.join(tmpDir, 'target');

    fs.mkdirSync(remoteRepoPath, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(targetPath, { recursive: true });

    // Initialize bare remote repo
    await safeExec('git', ['init', '--bare'], { cwd: remoteRepoPath });

    // Initialize working repo, commit initial files, and push to remote
    await safeExec('git', ['init'], { cwd: workDir });
    await safeExec('git', ['config', 'user.name', 'Deployra Test'], { cwd: workDir });
    await safeExec('git', ['config', 'user.email', 'test@deployra.local'], { cwd: workDir });
    await safeExec('git', ['remote', 'add', 'origin', remoteRepoPath], { cwd: workDir });

    fs.writeFileSync(path.join(workDir, 'build.sh'), 'echo "Build OK"');
    fs.writeFileSync(path.join(workDir, 'app.js'), 'console.log("v1.0.0");');
    fs.writeFileSync(
      path.join(workDir, 'package.json'),
      JSON.stringify({ name: 'e2e-app', version: '1.0.0' }),
    );

    await safeExec('git', ['add', '.'], { cwd: workDir });
    await safeExec('git', ['commit', '-m', 'Initial release v1.0.0'], { cwd: workDir });
    await safeExec('git', ['branch', '-M', 'main'], { cwd: workDir });
    await safeExec('git', ['push', '-u', 'origin', 'main'], { cwd: workDir });

    // Clone working copy into targetPath as initial setup
    await safeExec('git', ['clone', remoteRepoPath, targetPath]);
    await safeExec('git', ['config', 'user.name', 'Deployra Test'], { cwd: targetPath });
    await safeExec('git', ['config', 'user.email', 'test@deployra.local'], { cwd: targetPath });
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('executes full end-to-end deployment pipeline on commit update', async () => {
    // 1. Register project in repository
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    const config = normalizeAndValidateConfig({
      project: {
        name: 'e2e-app',
        path: targetPath,
      },
      source: {
        remote: 'origin',
        branch: 'main',
      },
      deploy: {
        strategy: 'in-place',
        commands: {
          install: ['echo "Installing..."'],
          build: ['echo "Building..."'],
        },
        service: {
          name: 'e2e-app',
          action: 'none',
        },
      },
    });

    projRepo.saveProject(config);

    // 2. Commit v2.0.0 change to remote repo
    fs.writeFileSync(path.join(workDir, 'app.js'), 'console.log("v2.0.0");');
    await safeExec('git', ['commit', '-am', 'Release v2.0.0'], { cwd: workDir });
    await safeExec('git', ['push', 'origin', 'main'], { cwd: workDir });

    const newShaRes = await safeExec('git', ['rev-parse', 'HEAD'], { cwd: workDir });
    const targetSha = newShaRes.stdout.trim();

    // 3. Create deployment record and run pipeline
    const depRecord = depRepo.createDeployment({
      id: 'dep_e2e_1',
      projectName: 'e2e-app',
      targetSha,
      triggerType: 'poll',
    });

    const runner = new DeploymentPipelineRunner();
    await runner.runDeployment({
      deploymentId: depRecord.id,
      projectName: 'e2e-app',
      targetSha,
      triggerType: 'poll',
      triggeredAt: Date.now(),
    });

    // 4. Assert deployment result
    const updatedDep = depRepo.getDeployment('dep_e2e_1');
    expect(updatedDep?.status).toBe('success');

    // Verify target file has updated content
    const targetAppContent = fs.readFileSync(path.join(targetPath, 'app.js'), 'utf-8');
    expect(targetAppContent).toBe('console.log("v2.0.0");');

    // Verify statistics
    const stats = depRepo.getStats('e2e-app');
    expect(stats.total).toBe(1);
    expect(stats.success).toBe(1);
    expect(stats.success / stats.total).toBe(1);
  }, 20000);

  it('triggers automated rollback when build fails during deployment', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    const config = normalizeAndValidateConfig({
      project: {
        name: 'e2e-rollback-app',
        path: targetPath,
      },
      source: {
        remote: 'origin',
        branch: 'main',
      },
      deploy: {
        strategy: 'in-place',
        retry: {
          attempts: 0,
          backoff: '0s',
        },
        commands: {
          build: ['sh build.sh'],
        },
        service: {
          name: 'e2e-rollback-app',
          action: 'none',
        },
        rollback: {
          enabled: true,
          on: ['build-failure'],
        },
      },
    });

    projRepo.saveProject(config);

    // Initial successful SHA
    const initialShaRes = await safeExec('git', ['rev-parse', 'HEAD'], { cwd: workDir });
    const initialSha = initialShaRes.stdout.trim();
    projRepo.updateLastSuccessfulSha('e2e-rollback-app', initialSha);

    // Commit broken v2.0.0 with broken build.sh
    fs.writeFileSync(path.join(workDir, 'build.sh'), 'exit 1');
    fs.writeFileSync(path.join(workDir, 'app.js'), 'console.log("BROKEN");');
    await safeExec('git', ['add', '.'], { cwd: workDir });
    await safeExec('git', ['commit', '-m', 'Broken release v2.0.0'], { cwd: workDir });
    await safeExec('git', ['push', 'origin', 'main'], { cwd: workDir });

    const brokenShaRes = await safeExec('git', ['rev-parse', 'HEAD'], { cwd: workDir });
    const brokenSha = brokenShaRes.stdout.trim();

    const depRecord = depRepo.createDeployment({
      id: 'dep_e2e_rollback',
      projectName: 'e2e-rollback-app',
      targetSha: brokenSha,
      triggerType: 'poll',
    });

    const runner = new DeploymentPipelineRunner();
    await runner.runDeployment({
      deploymentId: depRecord.id,
      projectName: 'e2e-rollback-app',
      targetSha: brokenSha,
      previousSha: initialSha,
      triggerType: 'poll',
      triggeredAt: Date.now(),
    });

    const updatedDep = depRepo.getDeployment('dep_e2e_rollback');
    expect(updatedDep?.status).toBe('rolled_back');

    // Verify target file rolled back to v1.0.0 content and build.sh is restored
    const targetAppContent = fs.readFileSync(path.join(targetPath, 'app.js'), 'utf-8');
    const targetBuildSh = fs.readFileSync(path.join(targetPath, 'build.sh'), 'utf-8');
    expect(targetAppContent).toBe('console.log("v1.0.0");');
    expect(targetBuildSh).toBe('echo "Build OK"');
  }, 20000);

  it('deploys a Node.js web server app with live HTTP health checks on commit update', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    // 1. Start live sample Node.js HTTP server fixture on port 3998
    const fixtureServer = createSampleServer('v1.0.0', 3998);
    await new Promise<void>((resolve) => fixtureServer.server.listen(3998, '127.0.0.1', resolve));

    try {
      // 2. Register project with HTTP readiness check
      const config = normalizeAndValidateConfig({
        project: {
          name: 'node-web-app',
          path: targetPath,
        },
        source: {
          remote: 'origin',
          branch: 'main',
        },
        deploy: {
          strategy: 'in-place',
          commands: {
            install: ['echo "Installing node dependencies..."'],
            build: ['echo "Building node app..."'],
          },
          service: {
            name: 'node-web-app',
            action: 'none',
          },
          ready: {
            url: `${fixtureServer.url}/health`,
            timeout: '5s',
            interval: '500ms',
          },
        },
      });

      projRepo.saveProject(config);

      // 3. Push v2.0.0 update to Git repository
      fs.writeFileSync(path.join(workDir, 'server.js'), 'const version = "v2.0.0";');
      await safeExec('git', ['add', '.'], { cwd: workDir });
      await safeExec('git', ['commit', '-m', 'Release Node web app v2.0.0'], { cwd: workDir });
      await safeExec('git', ['push', 'origin', 'main'], { cwd: workDir });

      const newShaRes = await safeExec('git', ['rev-parse', 'HEAD'], { cwd: workDir });
      const targetSha = newShaRes.stdout.trim();

      // Update server version to simulate restarted app
      fixtureServer.setVersion('v2.0.0');

      // 4. Run deployment pipeline
      const depRecord = depRepo.createDeployment({
        id: 'dep_node_web_1',
        projectName: 'node-web-app',
        targetSha,
        triggerType: 'poll',
      });

      const runner = new DeploymentPipelineRunner();
      await runner.runDeployment({
        deploymentId: depRecord.id,
        projectName: 'node-web-app',
        targetSha,
        triggerType: 'poll',
        triggeredAt: Date.now(),
      });

      // 5. Assert deployment success & file update
      const updatedDep = depRepo.getDeployment('dep_node_web_1');
      expect(updatedDep?.status).toBe('success');

      const deployedServerJs = fs.readFileSync(path.join(targetPath, 'server.js'), 'utf-8');
      expect(deployedServerJs).toContain('v2.0.0');

      expect(fixtureServer.getVersion()).toBe('v2.0.0');
    } finally {
      await fixtureServer.close();
    }
  }, 25000);

  it('processes deployment jobs asynchronously via Workmatic background queue worker', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const engine = new WorkmaticEngine();
    const runner = new DeploymentPipelineRunner();
    engine.setPipelineRunner(runner);

    const fixtureServer = createSampleServer('v1.0.0', 3999);
    await new Promise<void>((resolve) => fixtureServer.server.listen(3999, '127.0.0.1', resolve));

    try {
      // 1. Start Workmatic worker
      await engine.startWorker();

      // 2. Register project
      const config = normalizeAndValidateConfig({
        project: {
          name: 'queue-app',
          path: targetPath,
        },
        source: {
          remote: 'origin',
          branch: 'main',
        },
        deploy: {
          strategy: 'in-place',
          service: { name: 'queue-app', action: 'none' },
          ready: {
            url: `${fixtureServer.url}/health`,
            timeout: '5s',
            interval: '500ms',
          },
        },
      });
      projRepo.saveProject(config);

      // 3. Commit new version to Git repo
      fs.writeFileSync(path.join(workDir, 'app.js'), 'console.log("queued_v2.0.0");');
      await safeExec('git', ['add', '.'], { cwd: workDir });
      await safeExec('git', ['commit', '-m', 'Queued release v2.0.0'], { cwd: workDir });
      await safeExec('git', ['push', 'origin', 'main'], { cwd: workDir });

      // 4. Trigger watcher check which enqueues job into Workmatic Queue
      const watcher = new SourceWatcher(engine);
      const deploymentId = await watcher.checkProject('queue-app', 'poll');
      expect(deploymentId).toBeTruthy();

      // 5. Poll deployment status in SQLite DB until Workmatic worker processes the job
      let status = '';
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const dep = depRepo.getDeployment(deploymentId!);
        if (
          dep &&
          (dep.status === 'success' || dep.status === 'failed' || dep.status === 'rolled_back')
        ) {
          status = dep.status;
          break;
        }
      }

      expect(status).toBe('success');

      const targetAppContent = fs.readFileSync(path.join(targetPath, 'app.js'), 'utf-8');
      expect(targetAppContent).toBe('console.log("queued_v2.0.0");');
    } finally {
      await engine.stopWorker();
      await fixtureServer.close();
    }
  }, 45000);

  it('prevents rollback and stops execution immediately when acquire-lock fails', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const stateRepo = new StateRepository();

    const config = normalizeAndValidateConfig({
      project: {
        name: 'lock-test-app',
        path: targetPath,
      },
      source: {
        remote: 'origin',
        branch: 'main',
      },
      deploy: {
        strategy: 'in-place',
        rollback: { enabled: true },
        commands: {
          install: ['echo "Should not run install"'],
          build: ['echo "Should not run build"'],
        },
        service: { name: 'lock-test-app', action: 'none' },
      },
    });

    projRepo.saveProject(config);
    projRepo.updateLastSuccessfulSha('lock-test-app', 'sha_old_123');

    // Simulate an active lock held by another process/deployment
    stateRepo.acquireLock('lock-test-app', 'other_dep_123');

    const runner = new DeploymentPipelineRunner();
    const dep = depRepo.createDeployment({
      id: 'dep_lock_fail_1',
      projectName: 'lock-test-app',
      targetSha: 'sha_new_456',
      previousSha: 'sha_old_123',
      triggerType: 'manual',
    });

    await runner.runDeployment({
      deploymentId: dep.id,
      projectName: 'lock-test-app',
      targetSha: 'sha_new_456',
      previousSha: 'sha_old_123',
    });

    const result = depRepo.getDeployment(dep.id);
    expect(result?.status).toBe('failed');
    expect(result?.error).toContain('Could not acquire deployment lock');

    const lockStep = result?.steps.find((s) => s.stepName === 'acquire-lock');
    expect(lockStep?.status).toBe('failed');

    const installStep = result?.steps.find((s) => s.stepName === 'install');
    expect(installStep?.status).toBe('pending');
  });

  it('dynamically reloads updated deployra.config.yaml commands from repository commit during deployment', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    fs.writeFileSync(path.join(workDir, 'build_v1.sh'), 'echo BUILD_V1 > build_output.txt');
    fs.writeFileSync(path.join(workDir, 'build_v2.sh'), 'echo BUILD_V2 > build_output.txt');
    await safeExec('git', ['add', '.'], { cwd: workDir });
    await safeExec('git', ['commit', '-m', 'Add build scripts'], { cwd: workDir });

    // 1. Initial config with build command v1 (sh build_v1.sh)
    const initialConfig = normalizeAndValidateConfig({
      project: {
        name: 'dynamic-cfg-app',
        path: workDir,
      },
      source: { remote: 'origin', branch: 'main' },
      deploy: {
        strategy: 'in-place',
        commands: {
          build: ['sh build_v1.sh'],
        },
        service: { name: 'dynamic-cfg-app', action: 'none' },
      },
    });

    const savedInitial = projRepo.saveProject(initialConfig);
    expect(savedInitial.configVersion).toBe(1);

    // Update deployra.config.yaml to use build_v2.sh in the working tree
    const newConfigYaml = `
project:
  name: dynamic-cfg-app
  path: ${workDir}
source:
  remote: origin
  branch: main
deploy:
  strategy: in-place
  commands:
    build:
      - sh build_v2.sh
  service:
    name: dynamic-cfg-app
    action: none
`;
    fs.writeFileSync(path.join(workDir, 'deployra.config.yaml'), newConfigYaml);
    await safeExec('git', ['add', '.'], { cwd: workDir });
    await safeExec('git', ['commit', '-m', 'Update deployra.config.yaml to use build_v2.sh'], { cwd: workDir });
    await safeExec('git', ['push', 'origin', 'main'], { cwd: workDir });

    const targetSha = (await safeExec('git', ['rev-parse', 'HEAD'], { cwd: workDir })).stdout.trim();

    const runner = new DeploymentPipelineRunner();
    const dep = depRepo.createDeployment({
      id: 'dep_dynamic_cfg_1',
      projectName: 'dynamic-cfg-app',
      targetSha,
      triggerType: 'manual',
    });

    await runner.runDeployment({
      deploymentId: dep.id,
      projectName: 'dynamic-cfg-app',
      targetSha,
    });

    const result = depRepo.getDeployment(dep.id);
    expect(result?.status).toBe('success');

    // Verify build_output.txt contains BUILD_V2
    const outputContent = fs.readFileSync(path.join(workDir, 'build_output.txt'), 'utf-8');
    expect(outputContent.trim()).toBe('BUILD_V2');

    // Verify ProjectRepository was updated to configVersion: 2
    const updatedProj = projRepo.getProject('dynamic-cfg-app');
    expect(updatedProj?.configVersion).toBe(2);
    expect(updatedProj?.config.deploy.commands.build).toEqual(['sh build_v2.sh']);
  });
});
