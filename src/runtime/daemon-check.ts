import { getServiceStatus, isSystemctlAvailable } from 'unitup';
import { safeExec } from '../security/exec.js';

export async function isDaemonRunning(): Promise<boolean> {
  try {
    if (await isSystemctlAvailable()) {
      const status = await getServiceStatus('deployra-daemon');
      if (status?.activeState === 'active') {
        return true;
      }
    }
  } catch {
    // Ignore systemd service lookup errors
  }

  try {
    const res = await safeExec('ps', ['-eo', 'pid,args'], { timeoutMs: 3000 });
    const lines = res.stdout.split('\n');
    const currentPid = process.pid;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = trimmed.split(/\s+/);
      const pid = parseInt(parts[0], 10);
      if (Number.isNaN(pid) || pid === currentPid) continue;

      const cmd = parts.slice(1).join(' ');
      if (
        (cmd.includes('deployra') || cmd.includes('cli/index') || cmd.includes('daemon')) &&
        cmd.includes('watch')
      ) {
        return true;
      }
    }
  } catch {
    // Ignore ps execution failure fallback
  }

  return false;
}
