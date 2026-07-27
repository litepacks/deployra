import fs from 'node:fs';
import path from 'node:path';
import {
  addService,
  getServiceStatus,
  isSystemctlAvailable,
  restartService,
  startService,
  stopService,
  unitFileExists,
} from 'unitup';
import { RuntimeError } from '../errors/deployra-error.js';
import { logger } from '../logging/logger.js';
import type { RuntimeManager, RuntimeStatus, ServiceOptions } from './runtime-manager.js';

function resolveEntryPoint(
  cwd?: string,
  script?: string,
  command?: string,
): { script?: string; command?: string } {
  if (command) {
    return { command };
  }
  if (script) {
    return { script };
  }

  if (cwd && fs.existsSync(cwd)) {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.main && fs.existsSync(path.join(cwd, pkg.main))) {
          return { script: pkg.main };
        }
        if (pkg.scripts?.start) {
          return { command: 'npm start' };
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    const candidates = [
      'index.js',
      'server.js',
      'app.js',
      'main.js',
      'dist/index.js',
      'dist/server.js',
      'dist/main.js',
      'build/index.js',
      'src/index.js',
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(cwd, candidate))) {
        return { script: candidate };
      }
    }
  }

  return { script: 'index.js' };
}

export class UnitupAdapter implements RuntimeManager {
  private async isSystemdAvailable(): Promise<boolean> {
    try {
      return await isSystemctlAvailable();
    } catch {
      return false;
    }
  }

  private async ensureServiceExists(service: string, options?: ServiceOptions): Promise<void> {
    try {
      if (unitFileExists(service)) {
        return;
      }
    } catch {
      // Ignore check error and attempt addService
    }

    logger.info(
      `Service '${service}' does not exist in systemd. Auto-registering service via unitup...`,
      {
        service,
        cwd: options?.cwd,
      },
    );

    const cwd = options?.cwd || process.cwd();
    const entry = resolveEntryPoint(cwd, options?.script, options?.command);

    try {
      await addService({
        name: service,
        cwd,
        ...entry,
        memoryMax: options?.memoryMax,
        memoryHigh: options?.memoryHigh,
        start: true,
        force: true,
      });
      logger.info(`Successfully created and started service '${service}' via unitup!`, { service });
    } catch (err: any) {
      throw new RuntimeError(`Unitup failed to auto-create service '${service}': ${err.message}`);
    }
  }

  public async start(service: string, options?: ServiceOptions): Promise<void> {
    if (!(await this.isSystemdAvailable())) {
      logger.warn(
        `Systemd is not available on this platform. Simulating service start for '${service}'.`,
      );
      return;
    }
    try {
      if (!unitFileExists(service)) {
        await this.ensureServiceExists(service, options);
        return;
      }
      await startService(service);
    } catch (err: any) {
      if (err.message?.includes('does not exist') || err.message?.includes('not found')) {
        await this.ensureServiceExists(service, options);
        return;
      }
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

  public async restart(service: string, options?: ServiceOptions): Promise<void> {
    if (!(await this.isSystemdAvailable())) {
      logger.warn(
        `Systemd is not available on this platform. Simulating service restart for '${service}'.`,
      );
      return;
    }
    try {
      if (!unitFileExists(service)) {
        await this.ensureServiceExists(service, options);
        return;
      }
      await restartService(service);
    } catch (err: any) {
      if (err.message?.includes('does not exist') || err.message?.includes('not found')) {
        await this.ensureServiceExists(service, options);
        return;
      }
      throw new RuntimeError(`Unitup failed to restart service '${service}': ${err.message}`);
    }
  }

  public async reload(service: string, options?: ServiceOptions): Promise<void> {
    if (!(await this.isSystemdAvailable())) {
      logger.warn(
        `Systemd is not available on this platform. Simulating service reload for '${service}'.`,
      );
      return;
    }
    try {
      if (!unitFileExists(service)) {
        await this.ensureServiceExists(service, options);
        return;
      }
      await restartService(service);
    } catch (err: any) {
      if (err.message?.includes('does not exist') || err.message?.includes('not found')) {
        await this.ensureServiceExists(service, options);
        return;
      }
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
