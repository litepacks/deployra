import fs from 'node:fs';
import path from 'node:path';
import { PreflightError } from '../errors/deployra-error.js';

export interface DiskSpaceResult {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  freeMb: number;
  usagePercent: number;
  ok: boolean;
  warning?: string;
  error?: string;
}

export function checkDiskSpace(
  targetPath: string,
  options: { minFreeMb?: number; maxUsagePercent?: number } = {},
): DiskSpaceResult {
  const minFreeMb = options.minFreeMb ?? 200;
  const maxUsagePercent = options.maxUsagePercent ?? 98;
  const warnThreshold = Math.min(90, maxUsagePercent);

  let checkDir = targetPath;
  while (!fs.existsSync(checkDir)) {
    const parent = path.dirname(checkDir);
    if (parent === checkDir) break;
    checkDir = parent;
  }

  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(checkDir);
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      const usedBytes = totalBytes - freeBytes;
      const freeMb = Math.round(freeBytes / (1024 * 1024));
      const usagePercent =
        totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0;

      let ok = true;
      let error: string | undefined;
      let warning: string | undefined;

      if (usagePercent >= maxUsagePercent) {
        ok = false;
        error = `Disk is almost completely full (${usagePercent}% used, ${freeMb} MB free), exceeding critical threshold of ${maxUsagePercent}%.`;
      } else if (minFreeMb !== undefined && freeMb < minFreeMb) {
        ok = false;
        error = `Available disk space is ${freeMb} MB, which is below the minimum required space of ${minFreeMb} MB.`;
      } else if (usagePercent >= warnThreshold) {
        warning = `Disk usage is high (${usagePercent}% used, ${freeMb} MB free). Consider cleaning old deployments with 'deployra clean'.`;
      }

      return {
        totalBytes,
        freeBytes,
        usedBytes,
        freeMb,
        usagePercent,
        ok,
        warning,
        error,
      };
    }
  } catch (err: any) {
    return {
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      freeMb: 0,
      usagePercent: 0,
      ok: true,
      warning: `Could not determine disk usage for ${checkDir}: ${err.message}`,
    };
  }

  return {
    totalBytes: 0,
    freeBytes: 0,
    usedBytes: 0,
    freeMb: 0,
    usagePercent: 0,
    ok: true,
  };
}

export function assertDiskSpace(
  targetPath: string,
  options: { minFreeMb?: number; maxUsagePercent?: number } = {},
): DiskSpaceResult {
  const result = checkDiskSpace(targetPath, options);
  if (!result.ok && result.error) {
    throw new PreflightError(`Pre-flight disk check failed: ${result.error}`);
  }
  return result;
}
