import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { DeploymentPipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { UnitupAdapter } from '../src/runtime/unitup-adapter.js';
import { safeExec } from '../src/security/exec.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';

describe('Unitup Zero-Downtime Deployment Subsystem for Deployra', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-zd-test-'));
    process.env.DEPLOYRA_DB_PATH = path.join(tmpDir, 'deployra.db');
    process.env.WORKMATIC_DB_PATH = path.join(tmpDir, 'workmatic.db');
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('1. Configuration & Schema Normalization', () => {
    it('normalizes strategy: zero-downtime and resolves public port and drain timeout', () => {
      const config = normalizeAndValidateConfig({
        project: {
          name: 'api-service',
          path: '/tmp/api-service',
        },
        deploy: {
          strategy: 'zero-downtime',
          port: 8080,
          drainTimeout: '15s',
          canary: {
            enabled: true,
            weight: '25%',
          },
          service: {
            name: 'api-service',
            command: 'node server.js',
          },
        },
      });

      expect(config.deploy.strategy).toBe('zero-downtime');
      expect(config.deploy.zeroDowntime).toBe(true);
      expect(config.deploy.port).toBe(8080);
      expect(config.deploy.service.port).toBe(8080);
      expect(config.deploy.drainTimeoutMs).toBe(15000);
      expect(config.deploy.canary.enabled).toBe(true);
      expect(config.deploy.canary.weight).toBe(0.25);
    });

    it('derives zeroDowntime from service.zeroDowntime or deploy.zeroDowntime flags', () => {
      const config = normalizeAndValidateConfig({
        project: {
          name: 'worker-app',
          path: '/tmp/worker-app',
        },
        deploy: {
          strategy: 'in-place',
          zeroDowntime: true,
          port: 3000,
          service: {
            name: 'worker-app',
          },
        },
      });

      expect(config.deploy.strategy).toBe('in-place');
      expect(config.deploy.zeroDowntime).toBe(true);
      expect(config.deploy.port).toBe(3000);
      expect(config.deploy.drainTimeoutMs).toBe(10000); // default 10s
    });

    it('normalizes canary percentage and decimal weights correctly', () => {
      const configDecimal = normalizeAndValidateConfig({
        project: { name: 'app1', path: '/tmp/app1' },
        deploy: {
          canary: { weight: 0.15 },
        },
      });
      expect(configDecimal.deploy.canary.weight).toBe(0.15);

      const configPercent = normalizeAndValidateConfig({
        project: { name: 'app2', path: '/tmp/app2' },
        deploy: {
          canaryWeight: '40%',
        },
      });
      expect(configPercent.deploy.canary.enabled).toBe(true);
      expect(configPercent.deploy.canary.weight).toBe(0.4);
    });
  });

  describe('2. UnitupAdapter Zero-Downtime Lifecycle Methods', () => {
    it('executes deployZeroDowntime and returns generation results', async () => {
      const adapter = new UnitupAdapter();
      const appDir = path.join(tmpDir, 'zd-app');
      fs.mkdirSync(appDir, { recursive: true });

      const serverFile = path.join(appDir, 'server.js');
      fs.writeFileSync(
        serverFile,
        `
        const http = require('http');
        const port = process.env.PORT || 3000;
        const server = http.createServer((req, res) => res.end('v1'));
        server.listen(port, '127.0.0.1');
      `,
      );

      const progressEvents: string[] = [];
      const result = await adapter.deployZeroDowntime('zd-test-svc', {
        cwd: appDir,
        command: `node ${serverFile}`,
        publicPort: 0,
        drainTimeout: 2000,
        onProgress: (evt) => {
          progressEvents.push(evt.state);
        },
      });

      expect(result).toBeDefined();
      expect(result.service).toBe('zd-test-svc');
      expect(result.currentGeneration).toBeGreaterThanOrEqual(1);
      expect(typeof result.downtimeMs).toBe('number');
    });

    it('executes rollbackZeroDowntime safely', async () => {
      const adapter = new UnitupAdapter();
      const result = await adapter.rollbackZeroDowntime('zd-test-svc');
      expect(result).toBeDefined();
      expect(result.service).toBe('zd-test-svc');
      expect(result.activeGeneration).toBeGreaterThanOrEqual(1);
    });

    it('executes promoteZeroDowntime safely', async () => {
      const adapter = new UnitupAdapter();
      const result = await adapter.promoteZeroDowntime('zd-test-svc');
      expect(result).toBeDefined();
      expect(result.service).toBe('zd-test-svc');
      expect(result.promotedGeneration).toBeGreaterThanOrEqual(1);
    });

    it('retrieves generations list', async () => {
      const adapter = new UnitupAdapter();
      const gens = await adapter.getGenerations('zd-test-svc');
      expect(Array.isArray(gens)).toBe(true);
    });
  });

  describe('3. End-to-End Pipeline Runner with Zero-Downtime Deployment', () => {
    let remoteRepoPath: string;
    let workDir: string;
    let targetPath: string;

    beforeEach(async () => {
      remoteRepoPath = path.join(tmpDir, 'remote.git');
      workDir = path.join(tmpDir, 'work');
      targetPath = path.join(tmpDir, 'target');

      fs.mkdirSync(remoteRepoPath, { recursive: true });
      fs.mkdirSync(workDir, { recursive: true });
      fs.mkdirSync(targetPath, { recursive: true });

      await safeExec('git', ['init', '--bare'], { cwd: remoteRepoPath });
      await safeExec('git', ['init'], { cwd: workDir });
      await safeExec('git', ['config', 'user.name', 'Deployra ZeroDowntime Tester'], {
        cwd: workDir,
      });
      await safeExec('git', ['config', 'user.email', 'zd@deployra.local'], { cwd: workDir });
      await safeExec('git', ['remote', 'add', 'origin', remoteRepoPath], { cwd: workDir });

      fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({ name: 'zd-web-app' }));
      fs.writeFileSync(
        path.join(workDir, 'server.js'),
        `
        const http = require('http');
        const port = process.env.PORT || 4000;
        const server = http.createServer((req, res) => {
          if (req.url && req.url.includes('non-existent-probe')) {
            res.statusCode = 500;
            return res.end('probe failed');
          }
          res.end('hello zero downtime');
        });
        server.listen(port, '127.0.0.1');
      `,
      );

      await safeExec('git', ['add', '.'], { cwd: workDir });
      await safeExec('git', ['commit', '-m', 'feat: initial commit'], { cwd: workDir });
      await safeExec('git', ['branch', '-M', 'main'], { cwd: workDir });
      await safeExec('git', ['push', '-u', 'origin', 'main'], { cwd: workDir });

      await safeExec('git', ['clone', remoteRepoPath, targetPath]);
      await safeExec('git', ['config', 'user.name', 'Deployra ZeroDowntime Tester'], {
        cwd: targetPath,
      });
      await safeExec('git', ['config', 'user.email', 'zd@deployra.local'], { cwd: targetPath });
    });

    it('successfully completes zero-downtime deployment pipeline', async () => {
      const projRepo = new ProjectRepository();
      const depRepo = new DeploymentRepository();
      const runner = new DeploymentPipelineRunner();

      const config = normalizeAndValidateConfig({
        project: {
          name: 'zd-web-app',
          path: targetPath,
        },
        deploy: {
          strategy: 'zero-downtime',
          port: 4000,
          commands: {
            build: ['echo "build ok"'],
          },
          service: {
            name: 'zd-web-app',
            command: 'node server.js',
          },
          ready: {
            url: 'http://127.0.0.1:4000/health',
          },
        },
      });

      projRepo.saveProject(config);

      const dep = depRepo.createDeployment({
        projectName: 'zd-web-app',
        targetSha: 'initial_sha',
        status: 'queued',
        triggerType: 'manual',
      });

      await runner.runDeployment({
        deploymentId: dep.id,
        projectName: 'zd-web-app',
        targetSha: 'initial_sha',
        triggerType: 'manual',
        triggeredAt: Date.now(),
      });

      const finishedDep = depRepo.getDeployment(dep.id);
      expect(finishedDep).toBeDefined();
      expect(finishedDep?.status).toBe('success');

      // Verify service-action step executed
      const serviceStep = finishedDep?.steps.find((s) => s.stepName === 'service-action');
      expect(serviceStep).toBeDefined();
      expect(serviceStep?.status).toBe('success');
      expect(serviceStep?.output).toContain('activated');
    });

    it('deploys canary generation with specified weight in zero-downtime mode', async () => {
      const projRepo = new ProjectRepository();
      const depRepo = new DeploymentRepository();
      const runner = new DeploymentPipelineRunner();

      const config = normalizeAndValidateConfig({
        project: {
          name: 'zd-canary-app',
          path: targetPath,
        },
        deploy: {
          strategy: 'zero-downtime',
          port: 4001,
          service: {
            name: 'zd-canary-app',
            command: 'node server.js',
          },
        },
      });

      projRepo.saveProject(config);

      const dep = depRepo.createDeployment({
        projectName: 'zd-canary-app',
        targetSha: 'canary_sha',
        status: 'queued',
        triggerType: 'manual',
      });

      await runner.runDeployment({
        deploymentId: dep.id,
        projectName: 'zd-canary-app',
        targetSha: 'canary_sha',
        triggerType: 'manual',
        canary: true,
        canaryWeight: '15%',
        triggeredAt: Date.now(),
      });

      const finishedDep = depRepo.getDeployment(dep.id);
      expect(finishedDep?.status).toBe('success');

      const serviceStep = finishedDep?.steps.find((s) => s.stepName === 'service-action');
      expect(serviceStep?.status).toBe('success');
      expect(serviceStep?.output).toContain('Canary');
    });

    it('rolls back cleanly on readiness failure in zero-downtime mode', async () => {
      const projRepo = new ProjectRepository();
      const depRepo = new DeploymentRepository();
      const runner = new DeploymentPipelineRunner();

      const config = normalizeAndValidateConfig({
        project: {
          name: 'zd-fail-app',
          path: targetPath,
        },
        deploy: {
          strategy: 'zero-downtime',
          port: 4002,
          service: {
            name: 'zd-fail-app',
            command: 'node server.js',
          },
          ready: {
            url: 'http://127.0.0.1:4002/non-existent-probe',
            timeout: '1s',
            interval: '100ms',
          },
          rollback: {
            enabled: true,
          },
        },
      });

      projRepo.saveProject(config);

      const dep = depRepo.createDeployment({
        projectName: 'zd-fail-app',
        targetSha: 'fail_sha',
        status: 'queued',
        triggerType: 'manual',
      });

      await runner.runDeployment({
        deploymentId: dep.id,
        projectName: 'zd-fail-app',
        targetSha: 'fail_sha',
        triggerType: 'manual',
        triggeredAt: Date.now(),
      });

      const finishedDep = depRepo.getDeployment(dep.id);
      expect(finishedDep?.status).toBe('rolled_back');
    });
  });
});
