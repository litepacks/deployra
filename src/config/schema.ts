import path from 'node:path';
import { z } from 'zod';
import { ConfigValidationError } from '../errors/deployra-error.js';
import { assertSafePath } from '../security/path-validator.js';
import { parseDurationMs } from './duration.js';
import type { NormalizedDeployraConfig } from './types.js';

export function isUrlLike(str: string): boolean {
  if (!str) return false;
  return (
    /^(https?:\/\/|git@|[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:)/i.test(str) ||
    str.endsWith('.git') ||
    str.includes('://')
  );
}

export function sanitizeProjectName(str: string): string {
  if (!str) return 'app';

  let cleaned = str.trim();

  if (cleaned.includes('?')) {
    cleaned = cleaned.split('?')[0];
  }

  cleaned = cleaned.replace(/[/:\\]+$/, '');
  cleaned = cleaned.replace(/\.git$/i, '').trim();

  if (isUrlLike(cleaned) || /[/:\\]/.test(cleaned)) {
    const parts = cleaned.split(/[/:\\]/).filter((p) => p.length > 0);
    const last = parts[parts.length - 1];
    if (last && last.length > 0) {
      cleaned = last;
    }
  }

  cleaned = cleaned
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return cleaned || 'app';
}

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

const notificationEventSchema = z.enum(['success', 'failure', 'rollback']);

export const notificationChannelSchema = z.object({
  type: z.enum(['slack', 'discord', 'telegram', 'webhook']),
  url: z.string().optional(),
  token: z.string().optional(),
  chatId: z.string().optional(),
  events: z.array(notificationEventSchema).default(['success', 'failure', 'rollback']),
  headers: z.record(z.string(), z.string()).optional(),
});

export const notificationsObjectSchema = z.object({
  channels: z.array(notificationChannelSchema).optional(),
  events: z.array(notificationEventSchema).optional(),
  slack: z
    .object({
      url: z.string(),
      events: z.array(notificationEventSchema).optional(),
    })
    .optional(),
  discord: z
    .object({
      url: z.string(),
      events: z.array(notificationEventSchema).optional(),
    })
    .optional(),
  telegram: z
    .object({
      token: z.string(),
      chatId: z.string(),
      events: z.array(notificationEventSchema).optional(),
    })
    .optional(),
  webhook: z
    .object({
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      events: z.array(notificationEventSchema).optional(),
    })
    .optional(),
});

export const notificationsConfigSchema = z.union([
  z.array(notificationChannelSchema),
  notificationsObjectSchema,
]);

export const readyCheckConfigSchema = z.object({
  url: z.string().optional(),
  timeout: durationSchema.default('45s'),
  interval: durationSchema.default('2s'),
  mode: z.enum(['all', 'any', 'sequence']).default('all'),
  checks: z.array(individualCheckSchema).default([]),
});

export const preflightConfigSchema = z.object({
  diskCheck: z.boolean().default(true),
  minDiskFreeMb: z.number().int().positive().optional(),
  maxDiskUsagePercent: z.number().min(1).max(100).default(98),
});

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
      strategy: z.enum(['in-place', 'isolated', 'release', 'zero-downtime']).default('in-place'),
      workspacePath: z.string().optional(),
      concurrency: z.number().int().min(1).default(1),
      queueMode: z.enum(['latest', 'fifo', 'reject']).default('latest'),
      dirtyWorkspace: z.enum(['reject', 'reset', 'stash']).default('reject'),
      releasesToKeep: z.number().int().min(1).default(5),
      timeout: durationSchema.default('10m'),
      retry: z
        .object({
          attempts: z.number().int().min(0).default(2),
          backoff: durationSchema.default('10s'),
        })
        .default({ attempts: 2, backoff: '10s' }),
      envFile: z.string().optional(),
      env: z.record(z.string(), z.string()).default({}),
      preflight: preflightConfigSchema.default({ diskCheck: true, maxDiskUsagePercent: 98 }),
      commands: z.record(z.string(), z.array(z.string())).default({ install: [], build: [] }),
      port: z.number().int().min(1).max(65535).optional(),
      zeroDowntime: z.boolean().optional(),
      drainTimeout: durationSchema.optional(),
      canary: z
        .union([
          z.boolean(),
          z.object({
            enabled: z.boolean().default(true),
            weight: z.union([z.number(), z.string()]).default(0.1),
          }),
        ])
        .optional(),
      canaryWeight: z.union([z.number(), z.string()]).optional(),
      service: z
        .object({
          name: z.string(),
          action: z.enum(['start', 'restart', 'reload', 'none']).default('restart'),
          stopBeforeBuild: z.boolean().default(false),
          script: z.string().optional(),
          command: z.string().optional(),
          port: z.number().int().min(1).max(65535).optional(),
          zeroDowntime: z.boolean().optional(),
          drainTimeout: durationSchema.optional(),
          memoryMax: z.string().optional(),
          memoryHigh: z.string().optional(),
          cpuQuota: z.string().optional(),
          restartSec: z.string().optional(),
        })
        .optional(),
      ready: readyCheckConfigSchema.optional(),
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
  webhook: z
    .object({
      enabled: z.boolean().default(true),
      secret: z.string().optional(),
      branch: z.string().optional(),
      allowedIps: z.array(z.string()).optional(),
      trustProxy: z.boolean().default(false),
    })
    .optional(),
  notifications: notificationsConfigSchema.optional(),
  environments: z.record(z.string(), z.any()).optional(),
});

function normalizeReadyConfig(
  ready?: z.infer<typeof readyCheckConfigSchema>,
): NormalizedDeployraConfig['deploy']['ready'] {
  let readyTimeoutMs = 45000;
  let readyIntervalMs = 2000;
  let readyMode: NormalizedDeployraConfig['deploy']['ready']['mode'] = 'all';
  const checks = ready?.checks ? [...ready.checks] : [];

  if (ready) {
    readyTimeoutMs = parseDurationMs(ready.timeout);
    readyIntervalMs = parseDurationMs(ready.interval);
    readyMode = ready.mode;

    if (ready.url) {
      const isHttps = ready.url.startsWith('https://');
      checks.unshift({
        type: isHttps ? 'https' : 'http',
        url: ready.url,
        expect: { status: 200 },
      });
    }

    if (readyIntervalMs >= readyTimeoutMs) {
      throw new ConfigValidationError(
        `deploy.ready.interval (${ready.interval}) must be shorter than deploy.ready.timeout (${ready.timeout})`,
      );
    }
  }

  return {
    timeoutMs: readyTimeoutMs,
    intervalMs: readyIntervalMs,
    mode: readyMode,
    checks,
  };
}

function normalizeWebhookConfig(webhook?: {
  enabled: boolean;
  secret?: string;
  branch?: string;
  allowedIps?: string[];
  trustProxy?: boolean;
}): NormalizedDeployraConfig['webhook'] {
  if (!webhook) return undefined;
  let secret = webhook.secret;
  if (secret?.startsWith('$')) {
    secret = process.env[secret.slice(1)];
  }
  return {
    enabled: webhook.enabled,
    secret,
    branch: webhook.branch,
    allowedIps: webhook.allowedIps,
    trustProxy: Boolean(webhook.trustProxy),
  };
}

function normalizeNotificationsConfig(
  notifications?: z.infer<typeof notificationsConfigSchema>,
): NormalizedDeployraConfig['notifications'] {
  const result: NormalizedDeployraConfig['notifications'] = [];
  if (!notifications) return result;

  const resolveEnv = (val?: string) =>
    val?.startsWith('$') ? process.env[val.slice(1)] || val : val;

  if (Array.isArray(notifications)) {
    for (const ch of notifications) {
      result.push({
        type: ch.type,
        url: resolveEnv(ch.url),
        token: resolveEnv(ch.token),
        chatId: resolveEnv(ch.chatId),
        events: ch.events,
        headers: ch.headers,
      });
    }
    return result;
  }

  const obj = notifications;
  const defaultEvents = obj.events || ['success', 'failure', 'rollback'];

  if (Array.isArray(obj.channels)) {
    for (const ch of obj.channels) {
      result.push({
        type: ch.type,
        url: resolveEnv(ch.url),
        token: resolveEnv(ch.token),
        chatId: resolveEnv(ch.chatId),
        events: ch.events || defaultEvents,
        headers: ch.headers,
      });
    }
  }
  if (obj.slack) {
    result.push({
      type: 'slack',
      url: resolveEnv(obj.slack.url),
      events: obj.slack.events || defaultEvents,
    });
  }
  if (obj.discord) {
    result.push({
      type: 'discord',
      url: resolveEnv(obj.discord.url),
      events: obj.discord.events || defaultEvents,
    });
  }
  if (obj.telegram) {
    result.push({
      type: 'telegram',
      token: resolveEnv(obj.telegram.token),
      chatId: resolveEnv(obj.telegram.chatId),
      events: obj.telegram.events || defaultEvents,
    });
  }
  if (obj.webhook) {
    result.push({
      type: 'webhook',
      url: resolveEnv(obj.webhook.url),
      headers: obj.webhook.headers,
      events: obj.webhook.events || defaultEvents,
    });
  }
  return result;
}

export function normalizeAndValidateConfig(rawConfig: unknown): NormalizedDeployraConfig {
  let normalizedInput = rawConfig;
  if (rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    const rawObj = { ...(rawConfig as Record<string, any>) };
    if (rawObj.service && !rawObj.deploy?.service) {
      rawObj.deploy = { ...(rawObj.deploy || {}), service: rawObj.service };
    }
    normalizedInput = rawObj;
  }

  const result = deployraConfigSchema.safeParse(normalizedInput);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new ConfigValidationError(`Invalid configuration: ${issues}`);
  }

  const data = result.data;
  const watchIntervalMs = parseDurationMs(data.watch.interval);
  const deployTimeoutMs = parseDurationMs(data.deploy.timeout);
  const retryBackoffMs = parseDurationMs(data.deploy.retry.backoff);

  const projectName = sanitizeProjectName(data.project.name);
  const serviceName = sanitizeProjectName(data.deploy.service?.name ?? projectName);
  const serviceAction = data.deploy.service?.action ?? 'restart';

  const readyConfig = normalizeReadyConfig(data.deploy.ready);
  const webhookConfig = normalizeWebhookConfig(data.webhook);
  const normalizedNotifications = normalizeNotificationsConfig(data.notifications);

  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const defaultWorkspacePath = path.join(homeDir, '.deployra/workspaces', projectName);
  const resolvedWorkspacePath = assertSafePath(
    data.deploy.workspacePath ? path.resolve(data.deploy.workspacePath) : defaultWorkspacePath,
  );
  const resolvedProjectPath = assertSafePath(path.resolve(data.project.path));

  const normalizedEnv: Record<string, string> = {};
  if (data.deploy.env) {
    for (const [key, val] of Object.entries(data.deploy.env)) {
      if (typeof val === 'string') {
        if (val.startsWith('$')) {
          const varName =
            val.startsWith('${') && val.endsWith('}') ? val.slice(2, -1) : val.slice(1);
          normalizedEnv[key] = process.env[varName] || '';
        } else {
          normalizedEnv[key] = val;
        }
      }
    }
  }

  const zeroDowntime = Boolean(
    data.deploy.strategy === 'zero-downtime' ||
      data.deploy.zeroDowntime ||
      data.deploy.service?.zeroDowntime,
  );
  const publicPort = data.deploy.port ?? data.deploy.service?.port;
  const rawDrain = data.deploy.drainTimeout ?? data.deploy.service?.drainTimeout ?? '10s';
  const drainTimeoutMs = parseDurationMs(rawDrain);

  let canaryEnabled = false;
  let canaryWeight = 0.1;
  if (data.deploy.canary !== undefined) {
    if (typeof data.deploy.canary === 'boolean') {
      canaryEnabled = data.deploy.canary;
    } else if (typeof data.deploy.canary === 'object') {
      canaryEnabled = data.deploy.canary.enabled !== false;
      if (data.deploy.canary.weight !== undefined) {
        const rawW = data.deploy.canary.weight;
        const parsedW =
          typeof rawW === 'string' ? Number.parseFloat(rawW.replace('%', '')) : Number(rawW);
        canaryWeight = Number.isNaN(parsedW) ? 0.1 : parsedW > 1 ? parsedW / 100 : parsedW;
      }
    }
  }
  if (data.deploy.canaryWeight !== undefined) {
    const rawW = data.deploy.canaryWeight;
    const parsedW =
      typeof rawW === 'string' ? Number.parseFloat(rawW.replace('%', '')) : Number(rawW);
    canaryWeight = Number.isNaN(parsedW) ? 0.1 : parsedW > 1 ? parsedW / 100 : parsedW;
    canaryEnabled = true;
  }

  return {
    project: {
      name: projectName,
      path: resolvedProjectPath,
    },
    source: {
      remote: data.source.remote,
      branch: data.source.branch,
    },
    watch: {
      intervalMs: watchIntervalMs,
    },
    webhook: webhookConfig,
    notifications: normalizedNotifications,
    deploy: {
      strategy: data.deploy.strategy,
      workspacePath: resolvedWorkspacePath,
      concurrency: data.deploy.concurrency,
      queueMode: data.deploy.queueMode,
      dirtyWorkspace: data.deploy.dirtyWorkspace,
      releasesToKeep: data.deploy.releasesToKeep,
      timeoutMs: deployTimeoutMs,
      retry: {
        attempts: data.deploy.retry.attempts,
        backoffMs: retryBackoffMs,
      },
      envFile: data.deploy.envFile,
      env: normalizedEnv,
      preflight: {
        diskCheck: data.deploy.preflight?.diskCheck ?? true,
        minDiskFreeMb: data.deploy.preflight?.minDiskFreeMb,
        maxDiskUsagePercent: data.deploy.preflight?.maxDiskUsagePercent ?? 98,
      },
      commands: data.deploy.commands,
      port: publicPort,
      zeroDowntime,
      drainTimeoutMs,
      canary: {
        enabled: canaryEnabled,
        weight: canaryWeight,
      },
      service: {
        name: serviceName,
        action: serviceAction,
        stopBeforeBuild: data.deploy.service?.stopBeforeBuild ?? false,
        script: data.deploy.service?.script,
        command: data.deploy.service?.command,
        port: publicPort,
        zeroDowntime,
        drainTimeoutMs,
        memoryMax: data.deploy.service?.memoryMax,
        memoryHigh: data.deploy.service?.memoryHigh,
        cpuQuota: data.deploy.service?.cpuQuota,
        restartSec: data.deploy.service?.restartSec,
      },
      ready: readyConfig,
      rollback: {
        enabled: data.deploy.rollback.enabled,
        on: data.deploy.rollback.on,
      },
    },
  };
}
