export type DeployStrategy = 'in-place' | 'isolated';
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

export interface DeployConfig {
  strategy?: DeployStrategy; // Default 'in-place'
  workspacePath?: string;
  concurrency?: number; // Default 1
  queueMode?: QueueMode; // Default 'latest'
  dirtyWorkspace?: DirtyWorkspaceMode; // Default 'reject'
  timeout?: string | number; // Default 10m
  retry?: RetryConfig;
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

export interface DeployraConfig {
  project: ProjectConfig;
  source?: SourceConfig;
  watch?: WatchConfig;
  deploy?: DeployConfig;
}

// Normalized internal representation with resolved default values and duration milliseconds
export interface NormalizedDeployraConfig {
  configHash?: string;
  configVersion?: number;
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
  deploy: {
    strategy: DeployStrategy;
    workspacePath: string;
    concurrency: number;
    queueMode: QueueMode;
    dirtyWorkspace: DirtyWorkspaceMode;
    timeoutMs: number;
    retry: {
      attempts: number;
      backoffMs: number;
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
