import fs from 'node:fs';
import path from 'node:path';
import { RepositoryError } from '../errors/deployra-error.js';
import { logger } from '../logging/logger.js';
import { type ExecOptions, type ExecResult, safeExec } from '../security/exec.js';

export class GitClient {
  /**
   * Cleans up any stale Git lock files that were left behind if the process or machine crashed.
   */
  public repairStaleLocks(cwd: string): number {
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

    let removed = 0;
    for (const lockFile of lockFiles) {
      try {
        if (fs.existsSync(lockFile)) {
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
    try {
      return await safeExec('git', args, { cwd, ...options });
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
        this.repairStaleLocks(cwd);
        // Retry once after clearing lock
        return await safeExec('git', args, { cwd, ...options });
      }
      throw err;
    }
  }

  public async checkRemoteHead(
    cwd: string,
    remote = 'origin',
    branch = 'main',
  ): Promise<string | null> {
    try {
      this.repairStaleLocks(cwd);
      const result = await this.execGit(['ls-remote', remote, `refs/heads/${branch}`], cwd, {
        timeoutMs: 30000,
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
      this.repairStaleLocks(cwd);
      const isInside = await this.execGit(['rev-parse', '--is-inside-work-tree'], cwd);
      if (isInside.stdout.trim() !== 'true') {
        throw new RepositoryError(`Path '${cwd}' is not inside a valid Git working tree.`);
      }

      await this.execGit(['remote', 'get-url', remote], cwd);
    } catch (err: any) {
      throw new RepositoryError(`Repository validation failed at '${cwd}': ${err.message}`);
    }
  }

  public async isDirty(cwd: string): Promise<boolean> {
    const result = await this.execGit(['status', '--porcelain'], cwd);
    return result.stdout.trim().length > 0;
  }

  public async fetchBranch(cwd: string, remote = 'origin', branch = 'main'): Promise<void> {
    this.repairStaleLocks(cwd);
    await this.execGit(['fetch', '--prune', remote, branch], cwd, { timeoutMs: 120000 });
  }

  public async getCurrentSha(cwd: string): Promise<string> {
    const result = await this.execGit(['rev-parse', 'HEAD'], cwd);
    return result.stdout.trim();
  }

  public async resetHard(cwd: string, targetSha: string): Promise<void> {
    this.repairStaleLocks(cwd);
    await this.execGit(['reset', '--hard', targetSha], cwd);
  }

  public async cleanUntracked(cwd: string): Promise<void> {
    await this.execGit(['clean', '-fd'], cwd);
  }

  public async stashChanges(cwd: string): Promise<void> {
    await this.execGit(['stash'], cwd);
  }
}
