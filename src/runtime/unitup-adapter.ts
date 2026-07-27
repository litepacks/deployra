import {
  getServiceStatus,
  isSystemctlAvailable,
  restartService,
  startService,
  stopService,
} from 'unitup';
import { RuntimeError } from '../errors/deployra-error.js';
import { logger } from '../logging/logger.js';
import type { RuntimeManager, RuntimeStatus } from './runtime-manager.js';

export class UnitupAdapter implements RuntimeManager {
  private async isSystemdAvailable(): Promise<boolean> {
    try {
      return await isSystemctlAvailable();
    } catch {
      return false;
    }
  }

  public async start(service: string): Promise<void> {
    if (!(await this.isSystemdAvailable())) {
      logger.warn(
        `Systemd is not available on this platform. Simulating service start for '${service}'.`,
      );
      return;
    }
    try {
      await startService(service);
    } catch (err: any) {
      throw new RuntimeError(`Unitup failed to start service '${service}': ${err.message}`);
    }
  }

  public async stop(service: string): Promise<void> {
    if (!(await this.isSystemdAvailable())) {
      logger.warn(
        `Systemd is not available on this platform. Simulating service stop for '${service}'.`,
      );
      return;
    }
    try {
      await stopService(service);
    } catch (err: any) {
      throw new RuntimeError(`Unitup failed to stop service '${service}': ${err.message}`);
    }
  }

  public async restart(service: string): Promise<void> {
    if (!(await this.isSystemdAvailable())) {
      logger.warn(
        `Systemd is not available on this platform. Simulating service restart for '${service}'.`,
      );
      return;
    }
    try {
      await restartService(service);
    } catch (err: any) {
      throw new RuntimeError(`Unitup failed to restart service '${service}': ${err.message}`);
    }
  }

  public async reload(service: string): Promise<void> {
    if (!(await this.isSystemdAvailable())) {
      logger.warn(
        `Systemd is not available on this platform. Simulating service reload for '${service}'.`,
      );
      return;
    }
    try {
      await restartService(service);
    } catch (err: any) {
      throw new RuntimeError(`Unitup failed to reload service '${service}': ${err.message}`);
    }
  }

  public async status(service: string): Promise<RuntimeStatus> {
    if (!(await this.isSystemdAvailable())) {
      return {
        service,
        active: true,
        subState: 'simulated (non-systemd)',
        mainPid: 1234,
      };
    }
    try {
      const res = await getServiceStatus(service);
      const parsedPid = res?.pid && res.pid !== '-' ? parseInt(res.pid, 10) : undefined;
      const parsedRestarts = res?.restarts ? parseInt(res.restarts, 10) : undefined;

      return {
        service,
        active: res?.activeState === 'active',
        subState: res?.subState,
        mainPid: Number.isNaN(parsedPid!) ? undefined : parsedPid,
        restartCount: Number.isNaN(parsedRestarts!) ? undefined : parsedRestarts,
      };
    } catch {
      return {
        service,
        active: false,
        subState: 'inactive',
      };
    }
  }
}
