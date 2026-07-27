export interface RuntimeStatus {
  service: string;
  active: boolean;
  subState?: string;
  mainPid?: number;
  restartCount?: number;
  exitStatus?: number;
}

export interface RuntimeManager {
  start(service: string): Promise<void>;
  stop(service: string): Promise<void>;
  restart(service: string): Promise<void>;
  reload(service: string): Promise<void>;
  status(service: string): Promise<RuntimeStatus>;
}
