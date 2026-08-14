import { describe, expect, it } from 'vitest';
import { formatDurationMs, parseDurationMs } from '../src/config/duration.js';
import { normalizeAndValidateConfig, sanitizeProjectName } from '../src/config/schema.js';
import { ConfigValidationError } from '../src/errors/deployra-error.js';

describe('Project Name Sanitization', () => {
  it('sanitizes URL-like project names, trailing slashes, and git extensions', () => {
    expect(sanitizeProjectName('https://github.com/user/my-repo.git')).toBe('my-repo');
    expect(sanitizeProjectName('https://github.com/user/my-repo.git/')).toBe('my-repo');
    expect(sanitizeProjectName('git@github.com:user/my-repo.git')).toBe('my-repo');
    expect(sanitizeProjectName('git@github.com:user/my-repo/')).toBe('my-repo');
    expect(sanitizeProjectName('http://127.0.0.1:3000/app')).toBe('app');
    expect(sanitizeProjectName('store-app.com')).toBe('store-app.com');
  });
});

describe('Config Duration Utility', () => {
  it('parses various human-readable durations accurately', () => {
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('30s')).toBe(30000);
    expect(parseDurationMs('5m')).toBe(300000);
    expect(parseDurationMs('1h')).toBe(3600000);
    expect(parseDurationMs(1500)).toBe(1500);
  });

  it('formats milliseconds back to human readable string', () => {
    expect(formatDurationMs(500)).toBe('500ms');
    expect(formatDurationMs(30000)).toBe('30s');
    expect(formatDurationMs(300000)).toBe('5m');
    expect(formatDurationMs(3600000)).toBe('1h');
  });

  it('throws ConfigValidationError on invalid duration format', () => {
    expect(() => parseDurationMs('invalid_val')).toThrow();
  });
});

describe('Config Schema Validation', () => {
  it('normalizes valid configuration object with defaults', () => {
    const raw = {
      project: {
        name: 'my-api',
        path: '/var/www/my-api',
      },
    };

    const normalized = normalizeAndValidateConfig(raw);
    expect(normalized.project.name).toBe('my-api');
    expect(normalized.source.remote).toBe('origin');
    expect(normalized.source.branch).toBe('main');
    expect(normalized.watch.intervalMs).toBe(30000);
    expect(normalized.deploy.concurrency).toBe(1);
    expect(normalized.deploy.queueMode).toBe('latest');
    expect(normalized.deploy.dirtyWorkspace).toBe('reject');
    expect(normalized.deploy.service.name).toBe('my-api');
    expect(normalized.deploy.service.action).toBe('restart');
  });

  it('normalizes root-level service configuration into deploy.service properly', () => {
    const raw = {
      project: {
        name: 'express-api',
        path: '/var/www/express-api',
      },
      service: {
        name: 'express-api',
        action: 'restart',
        command: 'npm run start:api',
      },
    };

    const normalized = normalizeAndValidateConfig(raw);
    expect(normalized.deploy.service.name).toBe('express-api');
    expect(normalized.deploy.service.action).toBe('restart');
    expect(normalized.deploy.service.command).toBe('npm run start:api');
  });

  it('preserves all custom command steps and multiple commands per step array', () => {
    const normalized = normalizeAndValidateConfig({
      project: { name: 'app-custom-steps', path: '/app' },
      deploy: {
        commands: {
          install: ['npm ci'],
          build: ['npm run build:css', 'npm run build:js'],
          test: ['npm test'],
          migrate: ['npx prisma db push'],
        },
      },
    });

    expect(normalized.deploy.commands.install).toEqual(['npm ci']);
    expect(normalized.deploy.commands.build).toEqual(['npm run build:css', 'npm run build:js']);
    expect(normalized.deploy.commands.test).toEqual(['npm test']);
    expect(normalized.deploy.commands.migrate).toEqual(['npx prisma db push']);
  });

  it('throws error when ready interval is greater or equal to ready timeout', () => {
    const raw = {
      project: { name: 'app', path: '/app' },
      deploy: {
        ready: {
          timeout: '10s',
          interval: '15s',
        },
      },
    };

    expect(() => normalizeAndValidateConfig(raw)).toThrow(ConfigValidationError);
  });

  it('normalizes strategy in-place as default and strategy isolated with custom workspacePath', () => {
    const defaultNorm = normalizeAndValidateConfig({
      project: { name: 'app1', path: '/app1' },
    });
    expect(defaultNorm.deploy.strategy).toBe('in-place');
    expect(defaultNorm.deploy.workspacePath).toContain('.deployra/workspaces/app1');

    const isolatedNorm = normalizeAndValidateConfig({
      project: { name: 'app2', path: '/app2' },
      deploy: {
        strategy: 'isolated',
        workspacePath: '/tmp/custom-workspace',
      },
    });
    expect(isolatedNorm.deploy.strategy).toBe('isolated');
    expect(isolatedNorm.deploy.workspacePath).toBe('/tmp/custom-workspace');
  });

  it('correctly identifies URL-like strings using isUrlLike', async () => {
    const { isUrlLike } = await import('../src/config/schema.js');

    expect(isUrlLike('https://github.com/user/repo.git')).toBe(true);
    expect(isUrlLike('http://gitlab.com/user/repo')).toBe(true);
    expect(isUrlLike('git@github.com:user/repo.git')).toBe(true);
    expect(isUrlLike('my-repo.git')).toBe(true);

    expect(isUrlLike('my-clean-app')).toBe(false);
    expect(isUrlLike('store-app')).toBe(false);
  });
});

describe('Config Hashing & Versioning', () => {
  it('generates consistent hashes for identical configs and different hashes when commands change', async () => {
    const { computeConfigHash } = await import('../src/config/parser.js');

    const config1 = normalizeAndValidateConfig({
      project: { name: 'app-hash', path: '/app' },
      deploy: { commands: { build: ['npm run build'] } },
    });

    const config2 = normalizeAndValidateConfig({
      project: { name: 'app-hash', path: '/app' },
      deploy: { commands: { build: ['npm run build'] } },
    });

    const config3 = normalizeAndValidateConfig({
      project: { name: 'app-hash', path: '/app' },
      deploy: { commands: { build: ['npm run build:v2'] } },
    });

    const hash1 = computeConfigHash(config1);
    const hash2 = computeConfigHash(config2);
    const hash3 = computeConfigHash(config3);

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).toMatch(/^cfg_[a-f0-9]{12}$/);
  });
});
