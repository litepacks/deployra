import net from 'node:net';
import { getServiceStatus, IPCClient, readAppMetadata, unitFileExists } from 'unitup';

export interface PortCheckOptions {
  host?: string;
  timeoutMs?: number;
  /** Override for legacy unit detection (used in tests). */
  detectLegacyUnit?: (serviceName: string) => Promise<boolean>;
}

export interface PortCheckResult {
  port: number;
  isOccupied: boolean;
  isSupervisorActive: boolean;
  /** Port is held by this service's own non-zero-downtime unitup unit, which must be migrated to supervisor mode. */
  isLegacyUnit?: boolean;
  ok: boolean;
  error?: string;
  warning?: string;
}

/**
 * Checks if a TCP port is accepting connections on the specified host.
 */
export async function isPortOccupied(
  port: number,
  options: PortCheckOptions = {},
): Promise<boolean> {
  const host = options.host ?? '127.0.0.1';
  const timeoutMs = options.timeoutMs ?? 400;

  return new Promise((resolve) => {
    const socket = new net.Socket();

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

/**
 * Returns true when the service has a running unitup unit that was registered without
 * zero-downtime (the app binds the public port itself, no supervisor/IPC).
 */
export async function isLegacyManagedUnitRunning(serviceName: string): Promise<boolean> {
  try {
    if (!unitFileExists(serviceName)) return false;
    const meta = readAppMetadata(serviceName) as { deploy?: { zeroDowntime?: boolean } } | null;
    if (meta?.deploy?.zeroDowntime) return false;
    const status = await getServiceStatus(serviceName);
    return status.state === 'running' || status.status === 'running';
  } catch {
    return false;
  }
}

/**
 * Validates whether a public port can be safely bound for zero-downtime deployment.
 * If the port is in use, it verifies whether the existing listener is the Unitup supervisor
 * for this exact service via IPC. If occupied by an unmanaged foreign process, it reports failure.
 */
export async function checkZeroDowntimePort(
  serviceName: string,
  port: number,
  options: PortCheckOptions = {},
): Promise<PortCheckResult> {
  const isOccupied = await isPortOccupied(port, options);

  if (!isOccupied) {
    return {
      port,
      isOccupied: false,
      isSupervisorActive: false,
      ok: true,
    };
  }

  // Port is occupied: check if it belongs to the active Unitup supervisor for this service
  let isSupervisorActive = false;
  try {
    const ipc = new IPCClient(serviceName);
    isSupervisorActive = await ipc.isAlive();
  } catch {
    isSupervisorActive = false;
  }

  if (isSupervisorActive) {
    // Port is occupied by our own supervisor -> valid for zero-downtime rolling update!
    return {
      port,
      isOccupied: true,
      isSupervisorActive: true,
      ok: true,
    };
  }

  // Port is held by this service's own plain-mode unit: allow the switch to supervisor mode
  const detectLegacyUnit = options.detectLegacyUnit ?? isLegacyManagedUnitRunning;
  if (await detectLegacyUnit(serviceName)) {
    return {
      port,
      isOccupied: true,
      isSupervisorActive: false,
      isLegacyUnit: true,
      ok: true,
      warning: `Public port ${port} is held by the existing non-zero-downtime unit for '${serviceName}'. It will be migrated to Unitup supervisor mode; expect a brief restart during this first deployment.`,
    };
  }

  return {
    port,
    isOccupied: true,
    isSupervisorActive: false,
    ok: false,
    error: `Public port ${port} is already occupied by an external or unmanaged process, but Unitup supervisor for '${serviceName}' is not running on IPC. Please release port ${port} or stop conflicting processes before deploying.`,
  };
}
