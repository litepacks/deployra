import path from 'node:path';
import { z } from 'zod';
import { ConfigValidationError } from '../errors/deployra-error.js';
import { parseDurationMs } from './duration.js';
import type { NormalizedDeployraConfig } from './types.js';

const durationSchema = z.union([z.string(), z.number()]);

const httpCheckSchema = z.object({
  type: z.enum(['http', 'https']),
  url: z.string().url(),
  expect: z
    .object({
      status: z.number().int().optional(),
      headers: z.record(z.string()).optional(),
      bodyIncludes: z.string().optional(),
    })
    .optional(),
});

const tcpCheckSchema = z.object({
  type: z.literal('tcp'),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
});

const commandCheckSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1),
  expectedExitCode: z.number().int().optional(),
});

const processCheckSchema = z.object({
  type: z.literal('process'),
  name: z.string().optional(),
  pidFile: z.string().optional(),
});

const fileCheckSchema = z.object({
  type: z.literal('file'),
  path: z.string().min(1),
});

const individualCheckSchema = z.discriminatedUnion('type', [
  httpCheckSchema,
  tcpCheckSchema,
  commandCheckSchema,
  processCheckSchema,
  fileCheckSchema,
]);

export const deployraConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1, 'project.name is required'),
    path: z.string().min(1, 'project.path is required'),
  }),
  source: z
    .object({
      remote: z.string().default('origin'),
      branch: z.string().default('main'),
    })
    .default({ remote: 'origin', branch: 'main' }),
  watch: z
    .object({
      interval: durationSchema.default('30s'),
    })
    .default({ interval: '30s' }),
  deploy: z
    .object({
      strategy: z.enum(['in-place', 'isolated']).default('in-place'),
      workspacePath: z.string().optional(),
      concurrency: z.number().int().min(1).default(1),
      queueMode: z.enum(['latest', 'fifo', 'reject']).default('latest'),
      dirtyWorkspace: z.enum(['reject', 'reset', 'stash']).default('reject'),
      timeout: durationSchema.default('10m'),
      retry: z
        .object({
          attempts: z.number().int().min(0).default(2),
          backoff: durationSchema.default('10s'),
        })
        .default({ attempts: 2, backoff: '10s' }),
      commands: z
        .object({
          install: z.array(z.string()).default([]),
          build: z.array(z.string()).default([]),
        })
        .default({ install: [], build: [] }),
      service: z
        .object({
          name: z.string(),
          action: z.enum(['start', 'restart', 'reload', 'none']).default('restart'),
          script: z.string().optional(),
          command: z.string().optional(),
          memoryMax: z.string().optional(),
          memoryHigh: z.string().optional(),
          cpuQuota: z.string().optional(),
          restartSec: z.string().optional(),
        })
        .optional(),
      ready: z
        .object({
          url: z.string().optional(),
          timeout: durationSchema.default('45s'),
          interval: durationSchema.default('2s'),
          mode: z.enum(['all', 'any', 'sequence']).default('all'),
          checks: z.array(individualCheckSchema).default([]),
        })
        .optional(),
      rollback: z
        .object({
          enabled: z.boolean().default(true),
          on: z
            .array(z.enum(['build-failure', 'service-failure', 'ready-failure']))
            .default(['build-failure', 'service-failure', 'ready-failure']),
        })
        .default({ enabled: true, on: ['build-failure', 'service-failure', 'ready-failure'] }),
    })
    .default({}),
});

export function normalizeAndValidateConfig(rawConfig: unknown): NormalizedDeployraConfig {
  const result = deployraConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new ConfigValidationError(`Invalid configuration: ${issues}`);
  }

  const data = result.data;
  const watchIntervalMs = parseDurationMs(data.watch.interval);
  const deployTimeoutMs = parseDurationMs(data.deploy.timeout);
  const retryBackoffMs = parseDurationMs(data.deploy.retry.backoff);

  // Normalize Service config (default name to project name if not specified)
  const serviceName = data.deploy.service?.name ?? data.project.name;
  const serviceAction = data.deploy.service?.action ?? 'restart';

  // Normalize Ready check config
  let readyTimeoutMs = 45000;
  let readyIntervalMs = 2000;
  let readyMode: NormalizedDeployraConfig['deploy']['ready']['mode'] = 'all';
  const checks = data.deploy.ready?.checks ? [...data.deploy.ready.checks] : [];

  if (data.deploy.ready) {
    readyTimeoutMs = parseDurationMs(data.deploy.ready.timeout);
    readyIntervalMs = parseDurationMs(data.deploy.ready.interval);
    readyMode = data.deploy.ready.mode;

    // Shorthand URL check
    if (data.deploy.ready.url) {
      const isHttps = data.deploy.ready.url.startsWith('https://');
      checks.unshift({
        type: isHttps ? 'https' : 'http',
        url: data.deploy.ready.url,
        expect: { status: 200 },
      });
    }

    if (readyIntervalMs >= readyTimeoutMs) {
      throw new ConfigValidationError(
        `deploy.ready.interval (${data.deploy.ready.interval}) must be shorter than deploy.ready.timeout (${data.deploy.ready.timeout})`,
      );
    }
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const defaultWorkspacePath = path.join(homeDir, '.deployra/workspaces', data.project.name);
  const resolvedWorkspacePath = data.deploy.workspacePath
    ? path.resolve(data.deploy.workspacePath)
    : defaultWorkspacePath;

  return {
    project: {
      name: data.project.name,
      path: data.project.path,
    },
    source: {
      remote: data.source.remote,
      branch: data.source.branch,
    },
    watch: {
      intervalMs: watchIntervalMs,
    },
    deploy: {
      strategy: data.deploy.strategy,
      workspacePath: resolvedWorkspacePath,
      concurrency: data.deploy.concurrency,
      queueMode: data.deploy.queueMode,
      dirtyWorkspace: data.deploy.dirtyWorkspace,
      timeoutMs: deployTimeoutMs,
      retry: {
        attempts: data.deploy.retry.attempts,
        backoffMs: retryBackoffMs,
      },
      commands: {
        install: data.deploy.commands.install,
        build: data.deploy.commands.build,
      },
      service: {
        name: serviceName,
        action: serviceAction,
        memoryMax: data.deploy.service?.memoryMax,
        memoryHigh: data.deploy.service?.memoryHigh,
        cpuQuota: data.deploy.service?.cpuQuota,
        restartSec: data.deploy.service?.restartSec,
      },
      ready: {
        timeoutMs: readyTimeoutMs,
        intervalMs: readyIntervalMs,
        mode: readyMode,
        checks,
      },
      rollback: {
        enabled: data.deploy.rollback.enabled,
        on: data.deploy.rollback.on,
      },
    },
  };
}
