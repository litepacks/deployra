import path from 'node:path';

export function normalizePath(targetPath: string): string {
  return path.resolve(path.normalize(targetPath));
}

export function isSubdirectory(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function assertSafePath(targetPath: string, baseDir?: string): string {
  const normalized = normalizePath(targetPath);
  if (baseDir) {
    const normalizedBase = normalizePath(baseDir);
    if (normalized !== normalizedBase && !isSubdirectory(normalizedBase, normalized)) {
      throw new Error(
        `Path traversal attempt blocked: '${targetPath}' is outside base directory '${baseDir}'`,
      );
    }
  }
  return normalized;
}

export function isRootUser(): boolean {
  if (process.platform === 'win32') return false;
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

export function assertNonRootUser(allowRoot = false): void {
  const isAllowed = allowRoot || process.env.DEPLOYRA_ALLOW_ROOT === 'true';
  if (isRootUser() && !isAllowed) {
    throw new Error(
      'Running Deployra directly as root is discouraged for security reasons. Use a dedicated service user or set DEPLOYRA_ALLOW_ROOT=true to override.',
    );
  }
}
