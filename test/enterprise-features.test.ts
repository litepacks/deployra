import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertDiskSpace,
  checkDiskSpace,
  cleanCommand,
  clearRegisteredSecrets,
  closeDatabase,
  DeploymentRepository,
  deepMerge,
  extractClientIp,
  getDatabase,
  getDatabaseSize,
  isIpAllowed,
  loadConfig,
  maskSecrets,
  matchCidr,
  normalizeAndValidateConfig,
  ProjectRepository,
  parseEnvFile,
  registerSecret,
  registerSecrets,
  rollbackCommand,
  statusCommand,
  vacuumDatabase,
} from '../src/index.js';

describe('Enterprise Features & DX Improvements Suite', () => {
  const tmpDir = path.join('/tmp', `deployra_enterprise_test_${Date.now()}`);

  beforeEach(() => {
    process.env.DEPLOYRA_DB_PATH = ':memory:';
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    clearRegisteredSecrets();
    closeDatabase();
    getDatabase();
  });

  afterEach(() => {
    closeDatabase();
    clearRegisteredSecrets();
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  describe('1. SQLite & Log Retention Policy (Clean & Prune)', () => {
    it('prunes deployments and steps exceeding keep count', () => {
      const depRepo = new DeploymentRepository();
      const projRepo = new ProjectRepository();

      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'retention-test', path: tmpDir },
        }),
      );

      for (let i = 1; i <= 10; i++) {
        const dep = depRepo.createDeployment({
          id: `dep_prune_${i}`,
          projectName: 'retention-test',
          targetSha: `sha_${i}`,
          triggerType: 'manual',
          status: 'success',
        });
        depRepo.updateStep(dep.id, 'install', {
          status: 'success',
          output: `Installed package step ${i}`,
        });
      }

      expect(depRepo.getDeploymentsByProject('retention-test', 20)).toHaveLength(10);

      const result = depRepo.pruneDeployments({
        projectName: 'retention-test',
        keepCount: 3,
      });

      expect(result.deletedDeployments).toBe(7);
      expect(depRepo.getDeploymentsByProject('retention-test', 20)).toHaveLength(3);
    });

    it('prunes deployments older than specified maxAgeDays without deleting active jobs', () => {
      const depRepo = new DeploymentRepository();
      const projRepo = new ProjectRepository();

      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'age-prune-test', path: tmpDir },
        }),
      );

      const db = getDatabase();
      const oldTime = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago

      db.prepare(`
        INSERT INTO deployments (id, project_name, target_sha, status, trigger_type, dry_run, created_at)
        VALUES ('dep_old_1', 'age-prune-test', 'old_sha_1', 'success', 'manual', 0, ?)
      `).run(oldTime);

      db.prepare(`
        INSERT INTO deployments (id, project_name, target_sha, status, trigger_type, dry_run, created_at)
        VALUES ('dep_active_old', 'age-prune-test', 'old_sha_2', 'running', 'manual', 0, ?)
      `).run(oldTime);

      const result = depRepo.pruneDeployments({
        projectName: 'age-prune-test',
        maxAgeDays: 30,
      });

      expect(result.deletedDeployments).toBe(1);
      expect(depRepo.getDeployment('dep_old_1')).toBeNull();
      expect(depRepo.getDeployment('dep_active_old')).not.toBeNull();
    });

    it('executes cleanCommand and database vacuum without throwing', async () => {
      await expect(
        cleanCommand('non-existent-proj', { keep: 5, vacuum: true }),
      ).resolves.not.toThrow();
      expect(getDatabaseSize()).toBeGreaterThanOrEqual(0);
      expect(() => vacuumDatabase()).not.toThrow();
    });
  });

  describe('2. Project .env & Secret Management', () => {
    it('parses .env files correctly including comments, quotes, and export syntax', () => {
      const envPath = path.join(tmpDir, '.env.production');
      fs.writeFileSync(
        envPath,
        `
        # Database credentials
        DB_HOST=127.0.0.1
        DB_PORT=5432
        export API_SECRET="super-secret-key-123"
        SINGLE_QUOTED='my-single-secret'
        EXPANDED=\${TEST_EXPAND_VAR:-}
      `,
      );

      process.env.TEST_EXPAND_VAR = 'custom_expansion';
      const parsed = parseEnvFile(envPath);
      delete process.env.TEST_EXPAND_VAR;

      expect(parsed.DB_HOST).toBe('127.0.0.1');
      expect(parsed.DB_PORT).toBe('5432');
      expect(parsed.API_SECRET).toBe('super-secret-key-123');
      expect(parsed.SINGLE_QUOTED).toBe('my-single-secret');
      expect(parsed.EXPANDED).toBe('custom_expansion');
    });

    it('normalizes deploy.env and resolves $VAR references', () => {
      process.env.MY_SECRET_TOKEN = 'secret_value_xyz';
      const config = normalizeAndValidateConfig({
        project: { name: 'env-test', path: tmpDir },
        deploy: {
          envFile: '.env.staging',
          env: {
            NODE_ENV: 'staging',
            API_KEY: '$MY_SECRET_TOKEN',
          },
        },
      });
      delete process.env.MY_SECRET_TOKEN;

      expect(config.deploy.envFile).toBe('.env.staging');
      expect(config.deploy.env.NODE_ENV).toBe('staging');
      expect(config.deploy.env.API_KEY).toBe('secret_value_xyz');
    });

    it('redacts registered dynamic secrets from logs and step outputs', () => {
      registerSecret('ultra-secret-password-999');
      registerSecrets({ API_KEY: 'top-secret-api-token' });

      const logOutput =
        'Connecting to database with password=ultra-secret-password-999 and token top-secret-api-token completed.';
      const masked = maskSecrets(logOutput);

      expect(masked).not.toContain('ultra-secret-password-999');
      expect(masked).not.toContain('top-secret-api-token');
      expect(masked).toContain('[REDACTED]');
    });
  });

  describe('3. Pre-flight Disk Space Check', () => {
    it('checks disk space on valid directory', () => {
      const result = checkDiskSpace(tmpDir, { maxUsagePercent: 99 });
      expect(result).toHaveProperty('ok');
      expect(result).toHaveProperty('usagePercent');
      expect(typeof result.ok).toBe('boolean');
    });

    it('throws PreflightError when usage threshold is set to 0%', () => {
      expect(() => {
        assertDiskSpace(tmpDir, { maxUsagePercent: 1 });
      }).toThrow(/Pre-flight disk check failed/);
    });
  });

  describe('4. Webhook IP Whitelist & Proxy Trust', () => {
    it('matches exact IPv4, IPv6, and CIDR subnets correctly', () => {
      expect(isIpAllowed('192.168.1.100', ['192.168.1.100'])).toBe(true);
      expect(isIpAllowed('192.168.1.101', ['192.168.1.100'])).toBe(false);

      // CIDR matching
      expect(matchCidr('192.30.252.5', '192.30.252.0/22')).toBe(true);
      expect(matchCidr('192.30.255.254', '192.30.252.0/22')).toBe(true);
      expect(matchCidr('192.30.251.254', '192.30.252.0/22')).toBe(false);
      expect(isIpAllowed('140.82.112.50', ['140.82.112.0/20'])).toBe(true);
      expect(isIpAllowed('10.0.0.1', ['140.82.112.0/20'])).toBe(false);
    });

    it('extracts client IP with and without trustProxy', () => {
      const headers = {
        'x-forwarded-for': '203.0.113.195, 70.41.3.18',
        'x-real-ip': '203.0.113.195',
      };

      const directIp = extractClientIp('127.0.0.1', headers, false);
      expect(directIp).toBe('127.0.0.1');

      const proxyIp = extractClientIp('127.0.0.1', headers, true);
      expect(proxyIp).toBe('203.0.113.195');
    });
  });

  describe('5. Multi-Environment Support (Staging vs Production)', () => {
    it('merges deep environment configuration overrides', () => {
      const configPath = path.join(tmpDir, 'deployra.config.yaml');
      fs.writeFileSync(
        configPath,
        `
project:
  name: multi-env-app
  path: ${tmpDir}
source:
  remote: origin
  branch: main
deploy:
  commands:
    build: ["npm run build:prod"]
  env:
    NODE_ENV: production
environments:
  staging:
    source:
      branch: develop
    deploy:
      commands:
        build: ["npm run build:stage"]
      env:
        NODE_ENV: staging
`,
      );

      const prodConfig = loadConfig(configPath);
      expect(prodConfig.source.branch).toBe('main');
      expect(prodConfig.deploy.commands.build).toEqual(['npm run build:prod']);
      expect(prodConfig.deploy.env.NODE_ENV).toBe('production');

      const stageConfig = loadConfig(configPath, 'staging');
      expect(stageConfig.environment).toBe('staging');
      expect(stageConfig.source.branch).toBe('develop');
      expect(stageConfig.deploy.commands.build).toEqual(['npm run build:stage']);
      expect(stageConfig.deploy.env.NODE_ENV).toBe('staging');
    });

    it('deepMerge utility merges nested objects properly', () => {
      const base = { a: 1, nested: { x: 10, y: 20 } };
      const override = { b: 2, nested: { y: 99, z: 30 } };
      const merged = deepMerge(base, override);

      expect(merged).toEqual({
        a: 1,
        b: 2,
        nested: { x: 10, y: 99, z: 30 },
      });
    });
  });

  describe('6. Rollback & Deployment Selection CLI', () => {
    it('executes targeted rollback to a past successful deployment', async () => {
      const projRepo = new ProjectRepository();
      const depRepo = new DeploymentRepository();

      const config = normalizeAndValidateConfig({
        project: { name: 'rollback-test-proj', path: tmpDir },
        deploy: {
          strategy: 'in-place',
          commands: { install: [], build: [] },
          service: { name: 'rollback-test-proj', action: 'none' },
        },
      });
      projRepo.saveProject(config);

      // Create git repo in tmpDir for git reset to succeed
      const { safeExec } = await import('../src/security/exec.js');
      await safeExec('git', ['init', '-b', 'main'], { cwd: tmpDir });
      await safeExec('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
      await safeExec('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'version 1');
      await safeExec('git', ['add', '.'], { cwd: tmpDir });
      await safeExec('git', ['commit', '-m', 'commit 1'], { cwd: tmpDir });
      const sha1 = (await safeExec('git', ['rev-parse', 'HEAD'], { cwd: tmpDir })).stdout.trim();

      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'version 2');
      await safeExec('git', ['add', '.'], { cwd: tmpDir });
      await safeExec('git', ['commit', '-m', 'commit 2'], { cwd: tmpDir });
      const sha2 = (await safeExec('git', ['rev-parse', 'HEAD'], { cwd: tmpDir })).stdout.trim();

      depRepo.createDeployment({
        id: 'dep_target_success_1',
        projectName: 'rollback-test-proj',
        targetSha: sha1,
        triggerType: 'manual',
        status: 'success',
      });

      depRepo.createDeployment({
        id: 'dep_latest_bad_2',
        projectName: 'rollback-test-proj',
        targetSha: sha2,
        triggerType: 'manual',
        status: 'failed',
      });

      await rollbackCommand('rollback-test-proj', { to: 'dep_target_success_1' });

      const currentSha = (
        await safeExec('git', ['rev-parse', 'HEAD'], { cwd: tmpDir })
      ).stdout.trim();
      expect(currentSha).toBe(sha1);
    });
  });

  describe('7. Status TUI Dashboard', () => {
    it('renders dashboard overview without error in non-watch mode', async () => {
      const projRepo = new ProjectRepository();
      projRepo.saveProject(
        normalizeAndValidateConfig({
          project: { name: 'dashboard-test-app', path: tmpDir },
        }),
      );

      await expect(statusCommand('dashboard-test-app', { watch: false })).resolves.not.toThrow();
    });
  });
});
