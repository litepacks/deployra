import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployCommand } from '../src/cli/commands/deploy.js';
import { logsCommand } from '../src/cli/commands/logs.js';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { DeploymentPipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { safeExec } from '../src/security/exec.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';

describe('CI/CD & Developer Experience (DX) Improvements', () => {
  let tempDir: string;
  let dbDir: string;
  let projectRepo: ProjectRepository;
  let depRepo: DeploymentRepository;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-dx-test-'));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-db-test-'));
    process.env.DEPLOYRA_DB_PATH = path.join(dbDir, 'deployra.db');
    process.env.DEPLOYRA_ALLOW_ROOT = 'true';
    resetDatabase();
    projectRepo = new ProjectRepository();
    depRepo = new DeploymentRepository();
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    try {
      fs.rmSync(dbDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('1. Step-level Terminal Output Capture', () => {
    it('stores command stdout in deployment_steps.output', () => {
      const config = normalizeAndValidateConfig({
        project: { name: 'dx-log-app', path: '/fake/path' },
      });
      projectRepo.saveProject(config);

      const dep = depRepo.createDeployment({
        projectName: 'dx-log-app',
        targetSha: '1111111111111111111111111111111111111111',
        triggerType: 'manual',
        steps: ['install', 'build'],
      });

      depRepo.updateStep(dep.id, 'build', {
        status: 'success',
        duration: 120,
        output: '$ npm run build\nBuilding assets... done in 0.4s',
      });

      const fetched = depRepo.getDeployment(dep.id);
      expect(fetched).not.toBeNull();
      const buildStep = fetched?.steps.find((s) => s.stepName === 'build');
      expect(buildStep?.output).toContain('Building assets... done in 0.4s');
    });

    it('captures command output during pipeline execution', async () => {
      const runner = new DeploymentPipelineRunner();

      // Initialize a real minimal git repo in tempDir
      await safeExec('git', ['init', '-b', 'main'], { cwd: tempDir });
      await safeExec('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
      await safeExec('git', ['config', 'user.email', 'test@example.com'], {
        cwd: tempDir,
      });
      await safeExec('git', ['remote', 'add', 'origin', tempDir], {
        cwd: tempDir,
      });

      fs.writeFileSync(path.join(tempDir, 'file.txt'), 'hello');
      await safeExec('git', ['add', '.'], { cwd: tempDir });
      await safeExec('git', ['commit', '-m', 'Initial commit'], { cwd: tempDir });
      const shaRes = await safeExec('git', ['rev-parse', 'HEAD'], {
        cwd: tempDir,
      });
      const currentSha = shaRes.stdout.trim();

      const config = normalizeAndValidateConfig({
        project: { name: 'pipeline-log-app', path: tempDir },
        deploy: {
          strategy: 'in-place',
          commands: {
            build: ['node -e "console.log(\'CUSTOM_BUILD_LOG_OUTPUT_12345\')"'],
          },
          service: { name: 'dummy-svc', action: 'none' },
          ready: { checks: [] },
          rollback: { enabled: false },
        },
      });
      projectRepo.saveProject(config);

      const dep = depRepo.createDeployment({
        projectName: 'pipeline-log-app',
        targetSha: currentSha,
        triggerType: 'manual',
      });

      await runner.runDeployment({
        deploymentId: dep.id,
        projectName: 'pipeline-log-app',
        targetSha: currentSha,
        triggerType: 'manual',
        triggeredAt: Date.now(),
      });

      const completedDep = depRepo.getDeployment(dep.id);
      expect(completedDep?.status).toBe('success');
      const buildStep = completedDep?.steps.find((s) => s.stepName === 'build');
      expect(buildStep?.output).toContain('CUSTOM_BUILD_LOG_OUTPUT_12345');
    });
  });

  describe('2. deployCommand --inline Mode', () => {
    it('executes deployment directly in current process without requiring external daemon', async () => {
      await safeExec('git', ['init', '-b', 'main'], { cwd: tempDir });
      await safeExec('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
      await safeExec('git', ['config', 'user.email', 'test@example.com'], {
        cwd: tempDir,
      });
      await safeExec('git', ['remote', 'add', 'origin', tempDir], {
        cwd: tempDir,
      });
      fs.writeFileSync(path.join(tempDir, 'README.md'), 'inline test');
      await safeExec('git', ['add', '.'], { cwd: tempDir });
      await safeExec('git', ['commit', '-m', 'inline commit'], { cwd: tempDir });

      const config = normalizeAndValidateConfig({
        project: { name: 'inline-test-app', path: tempDir },
        deploy: {
          strategy: 'in-place',
          commands: {
            build: ['node -e "console.log(\'inline build ok\')"'],
          },
          service: { name: 'inline-svc', action: 'none' },
          ready: { checks: [] },
        },
      });
      projectRepo.saveProject(config);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await deployCommand('inline-test-app', { inline: true });

      const latest = depRepo.getLatestDeployment('inline-test-app');
      expect(latest).not.toBeNull();
      expect(latest?.status).toBe('success');

      const logs = consoleSpy.mock.calls.map((c) => c.join(' '));
      expect(logs.some((l) => l.includes('[INLINE MODE]'))).toBe(true);
      expect(logs.some((l) => l.includes('completed successfully'))).toBe(true);
    });
  });

  describe('3. logsCommand Formatting and Step Filtering', () => {
    it('outputs structured JSON when format: json is requested', async () => {
      const config = normalizeAndValidateConfig({
        project: { name: 'json-log-app', path: '/fake/path' },
      });
      projectRepo.saveProject(config);

      const dep = depRepo.createDeployment({
        projectName: 'json-log-app',
        targetSha: '3333333333333333333333333333333333333333',
        triggerType: 'manual',
        steps: ['build'],
      });
      depRepo.updateStep(dep.id, 'build', {
        status: 'success',
        output: 'Webpack compiled successfully',
      });

      let jsonOutput = '';
      vi.spyOn(console, 'log').mockImplementation((content) => {
        jsonOutput = content;
      });

      await logsCommand('json-log-app', {
        deployment: dep.id,
        format: 'json',
      });

      const parsed = JSON.parse(jsonOutput);
      expect(parsed.id).toBe(dep.id);
      expect(parsed.projectName).toBe('json-log-app');
      expect(parsed.steps[0].output).toBe('Webpack compiled successfully');
    });

    it('filters specific step when step filter is provided in logsCommand', async () => {
      const config = normalizeAndValidateConfig({
        project: { name: 'step-filter-app', path: '/fake/path' },
      });
      projectRepo.saveProject(config);

      const dep = depRepo.createDeployment({
        projectName: 'step-filter-app',
        targetSha: '4444444444444444444444444444444444444444',
        triggerType: 'manual',
        steps: ['install', 'build'],
      });
      depRepo.updateStep(dep.id, 'install', {
        status: 'success',
        output: 'installed 42 packages',
      });
      depRepo.updateStep(dep.id, 'build', {
        status: 'success',
        output: 'build target created',
      });

      let jsonOutput = '';
      vi.spyOn(console, 'log').mockImplementation((content) => {
        jsonOutput = content;
      });

      await logsCommand('step-filter-app', {
        deployment: dep.id,
        step: 'install',
        format: 'json',
      });

      const parsed = JSON.parse(jsonOutput);
      expect(parsed.stepName).toBe('install');
      expect(parsed.output).toBe('installed 42 packages');
    });

    it('outputs valid JSON Lines when format: jsonl is requested', async () => {
      const config = normalizeAndValidateConfig({
        project: { name: 'jsonl-log-app', path: '/fake/path' },
      });
      projectRepo.saveProject(config);

      const dep = depRepo.createDeployment({
        projectName: 'jsonl-log-app',
        targetSha: '5555555555555555555555555555555555555555',
        triggerType: 'manual',
        steps: ['build'],
      });

      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((content) => {
        lines.push(content);
      });

      await logsCommand('jsonl-log-app', {
        deployment: dep.id,
        format: 'jsonl',
      });

      expect(lines.length).toBeGreaterThanOrEqual(2);
      const first = JSON.parse(lines[0]);
      expect(first.type).toBe('deployment');
      expect(first.id).toBe(dep.id);

      const second = JSON.parse(lines[1]);
      expect(second.type).toBe('step');
    });
  });
});
