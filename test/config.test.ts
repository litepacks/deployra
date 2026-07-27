import { describe, expect, it } from 'vitest';
import { formatDurationMs, parseDurationMs } from '../src/config/duration.js';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { ConfigValidationError } from '../src/errors/deployra-error.js';

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
});
