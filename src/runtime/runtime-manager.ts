export interface RuntimeStatus {
  service: string;
  active: boolean;
  subState?: string;
  mainPid?: number;
  restartCount?: number;
  exitStatus?: number;
  generations?: GenerationRecordInfo[];
}

export interface GenerationRecordInfo {
  id: number;
  service: string;
  pid: number;
  internalPort: number;
  status: 'starting' | 'active' | 'previous' | 'draining' | 'stopped' | 'canary' | string;
  createdAt: string;
  activatedAt?: string;
  drainingAt?: string;
  stoppedAt?: string;
  canaryWeight?: number;
}

export interface ZeroDowntimeOptions {
  cwd?: string;
  command?: string;
  script?: string;
  publicPort?: number;
  readyPath?: string;
  drainTimeout?: number;
  canary?: boolean;
  canaryWeight?: number | string;
  onProgress?: (evt: any) => void;
}

export interface ZeroDowntimeResult {
  service: string;
  previousGeneration: number | null;
  currentGeneration: number;
  downtimeMs: number;
  status: string;
  canaryWeight?: number;
  isCanary?: boolean;
}

export interface ZeroDowntimeRollbackResult {
  service: string;
  rolledBackFrom: number | null;
  activeGeneration: number;
  status: string;
}

export interface ZeroDowntimePromoteResult {
  service: string;
  promotedGeneration: number;
  previousGeneration: number | null;
  downtimeMs: number;
  status: string;
}

export interface ServiceOptions {
  cwd?: string;
  script?: string;
  command?: string;
  port?: number;
  zeroDowntime?: boolean;
  drainTimeout?: number;
  memoryMax?: string;
  memoryHigh?: string;
  cpuQuota?: string;
  restartSec?: string;
}

export interface RuntimeManager {
  start(service: string, options?: ServiceOptions): Promise<void>;
  stop(service: string): Promise<void>;
  restart(service: string, options?: ServiceOptions): Promise<void>;
  reload(service: string, options?: ServiceOptions): Promise<void>;
  status(service: string): Promise<RuntimeStatus>;
  remove(service: string): Promise<void>;
  deployZeroDowntime?(service: string, options?: ZeroDowntimeOptions): Promise<ZeroDowntimeResult>;
  rollbackZeroDowntime?(
    service: string,
    options?: ZeroDowntimeOptions,
  ): Promise<ZeroDowntimeRollbackResult>;
  promoteZeroDowntime?(
    service: string,
    options?: ZeroDowntimeOptions,
  ): Promise<ZeroDowntimePromoteResult>;
  getGenerations?(service: string): Promise<GenerationRecordInfo[]>;
}
