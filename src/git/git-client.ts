import { safeExec } from '../security/exec.js';
import { RepositoryError } from '../errors/gitship-error.js';

export class GitClient {
  public async checkRemoteHead(
    cwd: string,
    remote = 'origin',
    branch = 'main',
  ): Promise<string | null> {
    try {
      const result = await safeExec('git', ['ls-remote', remote, `refs/heads/${branch}`], { cwd });
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
      const isInside = await safeExec('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
      if (isInside.stdout.trim() !== 'true') {
        throw new RepositoryError(`Path '${cwd}' is not inside a valid Git working tree.`);
      }

      await safeExec('git', ['remote', 'get-url', remote], { cwd });
    } catch (err: any) {
      throw new RepositoryError(`Repository validation failed at '${cwd}': ${err.message}`);
    }
  }

  public async isDirty(cwd: string): Promise<boolean> {
    const result = await safeExec('git', ['status', '--porcelain'], { cwd });
    return result.stdout.trim().length > 0;
  }

  public async fetchBranch(cwd: string, remote = 'origin', branch = 'main'): Promise<void> {
    await safeExec('git', ['fetch', '--prune', remote, branch], { cwd });
  }

  public async getCurrentSha(cwd: string): Promise<string> {
    const result = await safeExec('git', ['rev-parse', 'HEAD'], { cwd });
    return result.stdout.trim();
  }

  public async resetHard(cwd: string, targetSha: string): Promise<void> {
    await safeExec('git', ['reset', '--hard', targetSha], { cwd });
  }

  public async cleanUntracked(cwd: string): Promise<void> {
    await safeExec('git', ['clean', '-fd'], { cwd });
  }

  public async stashChanges(cwd: string): Promise<void> {
    await safeExec('git', ['stash'], { cwd });
  }
}
