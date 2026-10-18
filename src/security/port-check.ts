import net from 'node:net';
import { IPCClient } from 'unitup';

export interface PortCheckOptions {
  host?: string;
  timeoutMs?: number;
}

export interface PortCheckResult {
  port: number;
  isOccupied: boolean;
  isSupervisorActive: boolean;
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

  return {
    port,
    isOccupied: true,
    isSupervisorActive: false,
    ok: false,
    error: `Public port ${port} is already occupied by an external or unmanaged process, but Unitup supervisor for '${serviceName}' is not running on IPC. Please release port ${port} or stop conflicting processes before deploying.`,
  };
}
