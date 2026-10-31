import fs from 'node:fs';
import path from 'node:path';
import { safeExec } from '../security/exec.js';

/**
 * Paths never copied over or deleted in the target directory during isolated sync.
 * rsync does not delete excluded paths on the receiving side (no --delete-excluded),
 * so these also protect runtime-only files such as env files from `--delete`.
 */
export const DEFAULT_SYNC_EXCLUDES = ['.git', '.env', '.env.*'];

function normalizePattern(pattern: string): string {
  return pattern.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Matches a path relative to the sync root against rsync-style exclude patterns:
 * patterns without '/' match any path segment, patterns with '/' match from the root.
 */
export function isSyncExcluded(relativePath: string, patterns: string[]): boolean {
  const rel = relativePath.split(path.sep).join('/');
  if (!rel) return false;
  const segments = rel.split('/');
  for (const raw of patterns) {
    const pattern = normalizePattern(raw);
    if (!pattern) continue;
    if (pattern.includes('/')) {
      if (rel === pattern || rel.startsWith(`${pattern}/`)) return true;
    } else {
      const re = globToRegExp(pattern);
      if (segments.some((seg) => re.test(seg))) return true;
    }
  }
  return false;
}

export function resolveSyncExcludes(extra: Array<string | undefined> = []): string[] {
  const all = [...DEFAULT_SYNC_EXCLUDES];
  for (const p of extra) {
    if (p && !path.isAbsolute(p)) {
      const normalized = normalizePattern(p);
      if (normalized && !all.includes(normalized)) all.push(normalized);
    }
  }
  return all;
}

/**
 * Mirrors a built isolated workspace into the live project directory.
 */
export async function syncIsolatedWorkspace(
  sourceDir: string,
  targetDir: string,
  excludes: string[] = DEFAULT_SYNC_EXCLUDES,
): Promise<void> {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  try {
    await safeExec('rsync', [
      '-a',
      '--delete',
      ...excludes.map((p) => `--exclude=${normalizePattern(p)}`),
      `${sourceDir}/`,
      `${targetDir}/`,
    ]);
  } catch {
    fs.cpSync(sourceDir, targetDir, {
      recursive: true,
      force: true,
      filter: (src) => !isSyncExcluded(path.relative(sourceDir, src), excludes),
    });
  }
}
