import fs from 'node:fs';
import path from 'node:path';
import {
  addService,
  getServiceStatus,
  isUserSystemdAvailable,
  removeService,
  restartService,
  startService,
  stopService,
  unitFileExists,
} from 'unitup';
import { RuntimeError } from '../errors/deployra-error.js';
import { logger } from '../logging/logger.js';
import type { RuntimeManager, RuntimeStatus, ServiceOptions } from './runtime-manager.js';

export function parseCommandString(command: string): { command: string; args?: string[] } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { command: '' };
  }

  const tokens: string[] = [];
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match = regex.exec(trimmed);
  while (match !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1]);
    } else if (match[2] !== undefined) {
      tokens.push(match[2]);
    } else {
      tokens.push(match[0]);
    }
    match = regex.exec(trimmed);
  }

  if (tokens.length === 0) {
    return { command: trimmed };
  }

  const binary = tokens[0];
  const args = tokens.slice(1);

  return {
    command: binary,
    ...(args.length > 0 ? { args } : {}),
  };
}

function resolveEntryPoint(
  cwd?: string,
  script?: string,
  command?: string,
): { script?: string; command?: string; args?: string[] } {
  if (command) {
    return parseCommandString(command);
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
          return { command: 'npm', args: ['start'] };
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

function isNonFatalSystemdError(err: any): boolean {
  if (!err) return false;
  const msg = typeof err === 'string' ? err : err.message || '';
  return (
    msg.includes('Failed to reload systemd daemon') ||
    msg.includes('Failed to connect to bus') ||
    msg.includes('systemd is not running') ||
    msg.includes('Systemd is not available') ||
    msg.includes('Not running under systemd') ||
    msg.includes('does not exist') ||
    msg.includes('not found')
  );
}

export class UnitupAdapter implements RuntimeManager {
  private systemdAvailabilityCache?: boolean;

  private async isSystemdAvailable(): Promise<boolean> {
    if (this.systemdAvailabilityCache !== undefined) {
      return this.systemdAvailabilityCache;
    }
    try {
      const checkPromise = isUserSystemdAvailable();
      const timeoutPromise = new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 1500),
      );
      this.systemdAvailabilityCache = await Promise.race([checkPromise, timeoutPromise]);
      return this.systemdAvailabilityCache;
    } catch {
      this.systemdAvailabilityCache = false;
      return false;
    }
  }

  private async upsertService(service: string, options?: ServiceOptions): Promise<void> {
    const cwd = options?.cwd || process.cwd();
    const entry = resolveEntryPoint(cwd, options?.script, options?.command);

    logger.info(
      `Registering/updating systemd service '${service}' via unitup (command: ${entry.command || entry.script || 'default'})...`,
      {
        service,
        cwd,
        command: entry.command,
        script: entry.script,
      },
    );

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
      logger.info(`Successfully created/updated and started service '${service}' via unitup!`, {
        service,
      });
    } catch (err: any) {
      if (isNonFatalSystemdError(err)) {
        logger.warn(
          `Systemd daemon reload or user D-Bus is inactive (${err.message}). Simulating service action for '${service}'.`,
          { service },
        );
        return;
      }
      throw new RuntimeError(`Unitup failed to create/update service '${service}': ${err.message}`);
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
      if (options || !unitFileExists(service)) {
        await this.upsertService(service, options);
        return;
      }
      await startService(service);
    } catch (err: any) {
      if (isNonFatalSystemdError(err)) {
        await this.upsertService(service, options);
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
      if (isNonFatalSystemdError(err)) {
        logger.warn(
          `Systemd daemon reload or user D-Bus is inactive (${err.message}). Simulating service stop for '${service}'.`,
          { service },
        );
        return;
      }
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
      if (options || !unitFileExists(service)) {
        await this.upsertService(service, options);
        return;
      }
      await restartService(service);
    } catch (err: any) {
      if (isNonFatalSystemdError(err)) {
        await this.upsertService(service, options);
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
      if (options || !unitFileExists(service)) {
        await this.upsertService(service, options);
        return;
      }
      await restartService(service);
    } catch (err: any) {
      if (isNonFatalSystemdError(err)) {
        await this.upsertService(service, options);
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

  public async remove(service: string): Promise<void> {
    if (!(await this.isSystemdAvailable())) {
      logger.warn(
        `Systemd is not available on this platform. Simulating service removal for '${service}'.`,
      );
      return;
    }
    try {
      if (unitFileExists(service)) {
        await removeService(service, { force: true });
        logger.info(`Successfully stopped and removed unitup systemd service '${service}'`, {
          service,
        });
      }
    } catch (err: any) {
      logger.warn(`Failed to remove unitup service '${service}': ${err.message}`, { service });
    }
  }
}
