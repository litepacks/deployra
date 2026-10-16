import fs from 'node:fs';
import path from 'node:path';
import { RepositoryError } from '../errors/deployra-error.js';
import { logger } from '../logging/logger.js';
import { type ExecOptions, type ExecResult, safeExec } from '../security/exec.js';

export class GitClient {
  /**
   * Cleans up any stale Git lock files that were left behind if the process or machine crashed.
   */
  public repairStaleLocks(cwd: string, maxAgeMs = 0): number {
    const gitDir = path.join(cwd, '.git');
    if (!fs.existsSync(gitDir)) return 0;

    const lockFiles = [
      path.join(gitDir, 'index.lock'),
      path.join(gitDir, 'FETCH_HEAD.lock'),
      path.join(gitDir, 'HEAD.lock'),
      path.join(gitDir, 'config.lock'),
      path.join(gitDir, 'shallow.lock'),
    ];

    // Also check refs/heads/*.lock
    const refsHeadsDir = path.join(gitDir, 'refs', 'heads');
    if (fs.existsSync(refsHeadsDir)) {
      try {
        const headFiles = fs.readdirSync(refsHeadsDir);
        for (const f of headFiles) {
          if (f.endsWith('.lock')) {
            lockFiles.push(path.join(refsHeadsDir, f));
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    const now = Date.now();
    let removed = 0;
    for (const lockFile of lockFiles) {
      try {
        if (fs.existsSync(lockFile)) {
          if (maxAgeMs > 0) {
            const stat = fs.statSync(lockFile);
            if (now - stat.mtimeMs < maxAgeMs) {
              // Lock file is fresh and likely belongs to an actively running git operation
              continue;
            }
          }
          fs.unlinkSync(lockFile);
          removed++;
          logger.warn(`Self-repaired stale Git lock file: ${lockFile}`, { cwd });
        }
      } catch (err: any) {
        logger.warn(`Could not remove stale Git lock ${lockFile}: ${err.message}`);
      }
    }
    return removed;
  }

  private async execGit(
    args: string[],
    cwd: string,
    options: Partial<ExecOptions> = {},
  ): Promise<ExecResult> {
    const effectiveOptions: Partial<ExecOptions> = {
      timeoutMs: options.timeoutMs ?? 30000,
      ...options,
    };
    try {
      return await safeExec('git', args, { cwd, ...effectiveOptions });
    } catch (err: any) {
      const msg = err.message || '';
      if (
        msg.includes('index.lock') ||
        msg.includes('File exists') ||
        msg.includes('Another git process seems to be running')
      ) {
        logger.warn(
          `Detected Git lock contention in '${cwd}'. Attempting automated self-repair...`,
        );
        const removed = this.repairStaleLocks(cwd, 15000);
        if (removed > 0) {
          // Retry once after clearing stale lock
          return await safeExec('git', args, { cwd, ...effectiveOptions });
        }
      }
      throw err;
    }
  }

  public async checkRemoteHead(
    cwd: string,
    remote = 'origin',
    branch = 'main',
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<string | null> {
    try {
      const result = await this.execGit(['ls-remote', remote, `refs/heads/${branch}`], cwd, {
        timeoutMs: options.timeoutMs ?? 30000,
        signal: options.signal,
      });
      const line = result.stdout.trim().split('\n')[0];
      if (!line) return null;
      const sha = line.split('\t')[0];
      return sha || null;
    } catch (err: any) {
      throw new RepositoryError(
        `Failed to fetch remote SHA from '${remote}/${branch}': ${err.message}`,
      );
    }
  }

  public async validateRepository(cwd: string, remote = 'origin'): Promise<void> {
    try {
      const isInside = await this.execGit(['rev-parse', '--is-inside-work-tree'], cwd, {
        timeoutMs: 15000,
      });
      if (isInside.stdout.trim() !== 'true') {
        throw new RepositoryError(`Path '${cwd}' is not inside a valid Git working tree.`);
      }

      await this.execGit(['remote', 'get-url', remote], cwd, { timeoutMs: 15000 });
    } catch (err: any) {
      throw new RepositoryError(`Repository validation failed at '${cwd}': ${err.message}`);
    }
  }

  public async isDirty(cwd: string): Promise<boolean> {
    const result = await this.execGit(['status', '--porcelain'], cwd, { timeoutMs: 15000 });
    return result.stdout.trim().length > 0;
  }

  public async fetchBranch(
    cwd: string,
    remote = 'origin',
    branch = 'main',
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.execGit(['fetch', '--prune', remote, branch], cwd, {
      timeoutMs: options.timeoutMs ?? 120000,
      signal: options.signal,
    });
  }

  public async getCurrentSha(cwd: string): Promise<string> {
    const result = await this.execGit(['rev-parse', 'HEAD'], cwd);
    return result.stdout.trim();
  }

  public async resetHard(cwd: string, targetSha: string): Promise<void> {
    await this.execGit(['reset', '--hard', targetSha], cwd);
  }

  public async cleanUntracked(cwd: string): Promise<void> {
    await this.execGit(['clean', '-fd'], cwd);
  }

  public async stashChanges(cwd: string): Promise<void> {
    await this.execGit(['stash'], cwd);
  }
}
