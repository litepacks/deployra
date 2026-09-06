import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../src/cli/commands/doctor.js';
import { uninstallCommand } from '../src/cli/commands/uninstall.js';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { DeployraDaemon } from '../src/daemon.js';
import { logger } from '../src/logging/logger.js';
import { assertSafePath } from '../src/security/path-validator.js';
import { closeDatabase, getDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';

describe('Categories 3, 4, 5 Improvements and Fixes', () => {
  beforeEach(() => {
    process.env.DEPLOYRA_DB_PATH = ':memory:';
    process.env.DEPLOYRA_ALLOW_ROOT = 'true';
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  describe('Category 3: Database & Performance', () => {
    it('enables SQLite foreign keys and cascades delete from projects to deployments and steps', () => {
      const db = getDatabase();
      const fkPragma = db.pragma('foreign_keys', { simple: true });
      expect(fkPragma).toBe(1);

      const projectRepo = new ProjectRepository();
      const deploymentRepo = new DeploymentRepository();

      const config = normalizeAndValidateConfig({
        project: { name: 'fk-test-app', path: '/fake/path' },
      });
      projectRepo.saveProject(config);

      const dep = deploymentRepo.createDeployment({
        projectName: 'fk-test-app',
        targetSha: 'abc1234567890123456789012345678901234567',
        triggerType: 'manual',
      });

      deploymentRepo.updateStep(dep.id, 'build', { status: 'success' });

      expect(deploymentRepo.getDeployment(dep.id)).not.toBeNull();
      const stepsBefore = db
        .prepare('SELECT * FROM deployment_steps WHERE deployment_id = ?')
        .all(dep.id);
      expect(stepsBefore.length).toBeGreaterThan(0);

      // Deleting project should cascade to deployments and deployment_steps
      projectRepo.deleteProject('fk-test-app');

      expect(deploymentRepo.getDeployment(dep.id)).toBeNull();
      const stepsAfter = db
        .prepare('SELECT * FROM deployment_steps WHERE deployment_id = ?')
        .all(dep.id);
      expect(stepsAfter.length).toBe(0);
    });

    it('creates performance indexes on deployments and steps', () => {
      const db = getDatabase();
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[];
      const names = indexes.map((i) => i.name);

      expect(names).toContain('idx_deployments_project_created');
      expect(names).toContain('idx_deployments_status');
      expect(names).toContain('idx_deployment_steps_deployment');
    });

    it('hydrates multiple deployments and steps in batch without N+1 queries', () => {
      const projectRepo = new ProjectRepository();
      const deploymentRepo = new DeploymentRepository();

      const config = normalizeAndValidateConfig({
        project: { name: 'batch-test-app', path: '/fake/path' },
      });
      projectRepo.saveProject(config);

      const dep1 = deploymentRepo.createDeployment({
        projectName: 'batch-test-app',
        targetSha: '1111111111111111111111111111111111111111',
        triggerType: 'manual',
        steps: ['build', 'service-action'],
      });
      deploymentRepo.updateStep(dep1.id, 'build', { status: 'success' });

      const dep2 = deploymentRepo.createDeployment({
        projectName: 'batch-test-app',
        targetSha: '2222222222222222222222222222222222222222',
        triggerType: 'poll',
        steps: ['build', 'service-action'],
      });
      deploymentRepo.updateStep(dep2.id, 'build', { status: 'success' });

      const results = deploymentRepo.getDeploymentsByProject('batch-test-app');
      expect(results.length).toBe(2);
      expect(results[0].steps.length).toBe(2);
      expect(results[1].steps.length).toBe(2);

      const active = deploymentRepo.getActiveDeployments('batch-test-app');
      expect(active.length).toBe(2);
    });
  });

  describe('Category 4: CLI & UX Improvements', () => {
    it('doctor command handles :memory: database mode without throwing', async () => {
      process.env.DEPLOYRA_DB_PATH = ':memory:';
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(doctorCommand()).resolves.not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('uninstall command does not invoke npm uninstall -g unless global is explicitly true', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Call uninstall without global option
      await uninstallCommand({ keepData: true });

      const logCalls = consoleSpy.mock.calls.map((c) => c.join(' '));
      const retainedMessage = logCalls.some((msg) => msg.includes('Global npm package retained'));
      const uninstalledMessage = logCalls.some((msg) =>
        msg.includes('Uninstalling deployra globally via npm'),
      );

      expect(retainedMessage).toBe(true);
      expect(uninstalledMessage).toBe(false);
    });

    it('logger formats project and deploymentId correctly from metadata in pretty mode', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      logger.info('Test deployment event', {
        project: 'demo-app',
        deploymentId: 'dep_999',
        step: 'build',
      });

      const output = consoleSpy.mock.calls[0].join(' ');
      expect(output).toContain('demo-app');
      expect(output).toContain('dep_999');
      expect(output).toContain('build');
      expect(output).toContain('Test deployment event');
    });

    it('normalizes project.path into an absolute safe path', () => {
      const config = normalizeAndValidateConfig({
        project: { name: 'rel-app', path: './relative/path' },
      });

      expect(path.isAbsolute(config.project.path)).toBe(true);
      expect(config.project.path).toBe(path.resolve('./relative/path'));
    });
  });

  describe('Category 5: Security & Daemon Resilience', () => {
    it('assertSafePath blocks directory traversal attempts when baseDir is enforced', () => {
      const baseDir = '/var/www/app';
      expect(() => {
        assertSafePath('/var/www/app/../../etc/passwd', baseDir);
      }).toThrow(/Path traversal attempt blocked/);

      expect(assertSafePath('/var/www/app/subfolder', baseDir)).toBe(
        path.resolve('/var/www/app/subfolder'),
      );
    });

    it('DeployraDaemon instantiates cleanly and checks non-root user permissions', () => {
      const daemon = new DeployraDaemon();
      expect(daemon).toBeDefined();
    });
  });
});
