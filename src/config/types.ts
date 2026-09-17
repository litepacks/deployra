export type DeployStrategy = 'in-place' | 'isolated' | 'release';
export type QueueMode = 'latest' | 'fifo' | 'reject';
export type DirtyWorkspaceMode = 'reject' | 'reset' | 'stash';
export type ServiceAction = 'start' | 'restart' | 'reload' | 'none';
export type ReadinessMode = 'all' | 'any' | 'sequence';
export type ReadyCheckType = 'http' | 'https' | 'tcp' | 'command' | 'process' | 'file';

export interface HttpCheckConfig {
  type: 'http' | 'https';
  url: string;
  expect?: {
    status?: number;
    headers?: Record<string, string>;
    bodyIncludes?: string;
  };
}

export interface TcpCheckConfig {
  type: 'tcp';
  host: string;
  port: number;
}

export interface CommandCheckConfig {
  type: 'command';
  command: string;
  expectedExitCode?: number;
}

export interface ProcessCheckConfig {
  type: 'process';
  name?: string;
  pidFile?: string;
}

export interface FileCheckConfig {
  type: 'file';
  path: string;
}

export type IndividualCheckConfig =
  | HttpCheckConfig
  | TcpCheckConfig
  | CommandCheckConfig
  | ProcessCheckConfig
  | FileCheckConfig;

export interface ReadyConfig {
  url?: string; // Shorthand for single HTTP check
  timeout?: string | number; // Default 45s
  interval?: string | number; // Default 2s
  mode?: ReadinessMode; // Default 'all'
  checks?: IndividualCheckConfig[];
}

export interface RetryConfig {
  attempts?: number; // Default 2
  backoff?: string | number; // Default 10s
}

export interface RollbackConfig {
  enabled?: boolean; // Default true
  on?: Array<'build-failure' | 'service-failure' | 'ready-failure'>;
}

export interface DeployCommandsConfig {
  install?: string[];
  build?: string[];
  [stepName: string]: string[] | undefined;
}

export interface DeployServiceConfig {
  name: string;
  action?: ServiceAction; // Default 'restart'
  stopBeforeBuild?: boolean;
  script?: string;
  command?: string;
  memoryMax?: string; // e.g. '512M', '1G'
  memoryHigh?: string; // e.g. '400M'
  cpuQuota?: string; // e.g. '50%'
  restartSec?: string; // e.g. '5s'
}

export interface PreflightConfig {
  diskCheck?: boolean; // Default true
  minDiskFreeMb?: number; // e.g. 500 (MB)
  maxDiskUsagePercent?: number; // Default 90 (%)
}

export interface DeployConfig {
  strategy?: DeployStrategy; // Default 'in-place'
  workspacePath?: string;
  concurrency?: number; // Default 1
  queueMode?: QueueMode; // Default 'latest'
  dirtyWorkspace?: DirtyWorkspaceMode; // Default 'reject'
  releasesToKeep?: number; // Default 5
  timeout?: string | number; // Default 10m
  retry?: RetryConfig;
  envFile?: string; // e.g. '.env.production'
  env?: Record<string, string>; // e.g. { NODE_ENV: 'production' }
  preflight?: PreflightConfig;
  commands?: DeployCommandsConfig;
  service?: DeployServiceConfig;
  ready?: ReadyConfig;
  rollback?: RollbackConfig;
}

export interface ProjectConfig {
  name: string;
  path: string;
}

export interface SourceConfig {
  remote?: string; // Default 'origin'
  branch?: string; // Default 'main'
}

export interface WatchConfig {
  interval?: string | number; // Default '30s'
}

export interface WebhookConfig {
  enabled?: boolean;
  secret?: string;
  branch?: string;
  allowedIps?: string[]; // e.g. ['127.0.0.1', '192.30.252.0/22', '140.82.112.0/20']
  trustProxy?: boolean; // Whether to trust X-Forwarded-For header
}

export type NotificationChannelType = 'slack' | 'discord' | 'telegram' | 'webhook';
export type NotificationEvent = 'success' | 'failure' | 'rollback';

export interface NotificationChannelConfig {
  type: NotificationChannelType;
  url?: string;
  token?: string;
  chatId?: string;
  events?: NotificationEvent[];
  headers?: Record<string, string>;
}

export type NotificationsConfig =
  | NotificationChannelConfig[]
  | {
      channels?: NotificationChannelConfig[];
      slack?: { url: string; events?: NotificationEvent[] };
      discord?: { url: string; events?: NotificationEvent[] };
      telegram?: { token: string; chatId: string; events?: NotificationEvent[] };
      webhook?: { url: string; headers?: Record<string, string>; events?: NotificationEvent[] };
    };

export interface NormalizedNotificationChannel {
  type: NotificationChannelType;
  url?: string;
  token?: string;
  chatId?: string;
  events: NotificationEvent[];
  headers?: Record<string, string>;
}

export interface DeployraConfig {
  project: ProjectConfig;
  source?: SourceConfig;
  watch?: WatchConfig;
  deploy?: DeployConfig;
  webhook?: WebhookConfig;
  notifications?: NotificationsConfig;
  environments?: Record<string, any>;
}

// Normalized internal representation with resolved default values and duration milliseconds
export interface NormalizedDeployraConfig {
  configHash?: string;
  configVersion?: number;
  environment?: string;
  project: {
    name: string;
    path: string;
  };
  source: {
    remote: string;
    branch: string;
  };
  watch: {
    intervalMs: number;
  };
  webhook?: {
    enabled: boolean;
    secret?: string;
    branch?: string;
    allowedIps?: string[];
    trustProxy: boolean;
  };
  notifications: NormalizedNotificationChannel[];
  deploy: {
    strategy: DeployStrategy;
    workspacePath: string;
    concurrency: number;
    queueMode: QueueMode;
    dirtyWorkspace: DirtyWorkspaceMode;
    releasesToKeep: number;
    timeoutMs: number;
    retry: {
      attempts: number;
      backoffMs: number;
    };
    envFile?: string;
    env: Record<string, string>;
    preflight: {
      diskCheck: boolean;
      minDiskFreeMb?: number;
      maxDiskUsagePercent: number;
    };
    commands: Record<string, string[]>;
    service: {
      name: string;
      action: ServiceAction;
      stopBeforeBuild: boolean;
      script?: string;
      command?: string;
      memoryMax?: string;
      memoryHigh?: string;
      cpuQuota?: string;
      restartSec?: string;
    };
    ready: {
      timeoutMs: number;
      intervalMs: number;
      mode: ReadinessMode;
      checks: IndividualCheckConfig[];
    };
    rollback: {
      enabled: boolean;
      on: Array<'build-failure' | 'service-failure' | 'ready-failure'>;
    };
  };
}
