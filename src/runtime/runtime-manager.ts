export interface RuntimeStatus {
  service: string;
  active: boolean;
  subState?: string;
  mainPid?: number;
  restartCount?: number;
  exitStatus?: number;
}

export interface ServiceOptions {
  cwd?: string;
  script?: string;
  command?: string;
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
}
