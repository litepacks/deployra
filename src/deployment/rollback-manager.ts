import fs from 'node:fs';
import path from 'node:path';
import type { NormalizedDeployraConfig } from '../config/types.js';
import { RollbackError } from '../errors/deployra-error.js';
import { GitClient } from '../git/git-client.js';
import { logger } from '../logging/logger.js';
import { ReadyCheckerAdapter } from '../readiness/ready-checker-adapter.js';
import { parseCommandString, UnitupAdapter } from '../runtime/unitup-adapter.js';
import { safeExec } from '../security/exec.js';

export class RollbackManager {
  private gitClient = new GitClient();
  private unitupAdapter = new UnitupAdapter();
  private readyAdapter = new ReadyCheckerAdapter();

  public async rollback(data: {
    projectName: string;
    projectPath: string;
    previousSuccessfulSha?: string;
    deploymentId?: string;
    config: NormalizedDeployraConfig;
  }): Promise<void> {
    logger.warn(
      `Initiating automated rollback for project '${data.projectName}'${data.previousSuccessfulSha ? ` to SHA ${data.previousSuccessfulSha}` : ''}`,
      {
        project: data.projectName,
      },
    );

    const isIsolated = data.config.deploy.strategy === 'isolated';
    const workingDir = isIsolated ? data.config.deploy.workspacePath : data.projectPath;

    if (data.config.deploy.strategy === 'release') {
      const releaseRoot = data.config.deploy.workspacePath;
      const releasesDir = path.join(releaseRoot, 'releases');
      const currentLink = path.join(releaseRoot, 'current');

      try {
        if (fs.existsSync(releasesDir)) {
          const entries = fs
            .readdirSync(releasesDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && (!data.deploymentId || d.name !== data.deploymentId))
            .map((d) => ({
              name: d.name,
              path: path.join(releasesDir, d.name),
              mtime: fs.statSync(path.join(releasesDir, d.name)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);

          let activeTarget: string | null = null;
          try {
            if (fs.existsSync(currentLink)) {
              activeTarget = fs.realpathSync(currentLink);
            }
          } catch {
            // Ignore realpath error
          }

          const previousRelease = entries[0];
          if (previousRelease) {
            if (activeTarget !== previousRelease.path) {
              const tmpLink = path.join(releaseRoot, 'current.rollback.tmp');
              try {
                if (fs.existsSync(tmpLink) || fs.lstatSync(tmpLink).isSymbolicLink()) {
                  fs.unlinkSync(tmpLink);
                }
              } catch {}
              fs.symlinkSync(previousRelease.path, tmpLink, 'dir');
              fs.renameSync(tmpLink, currentLink);
            }

            logger.info(
              `Rollback ensured 'current' symlink points to release '${previousRelease.name}' for project '${data.projectName}'`,
              { project: data.projectName, previousRelease: previousRelease.name },
            );

            if (data.deploymentId) {
              const failedDir = path.join(releasesDir, data.deploymentId);
              if (fs.existsSync(failedDir)) {
                try {
                  fs.rmSync(failedDir, { recursive: true, force: true });
                  logger.info(`Removed failed release directory '${data.deploymentId}'`);
                } catch {}
              }
            }

            if (data.config.deploy.service.action !== 'none') {
              await this.unitupAdapter.restart(data.config.deploy.service.name, {
                cwd: currentLink,
              });
            }
            if (data.config.deploy.ready.checks.length > 0) {
              await this.readyAdapter.wait(data.config.deploy.ready);
            }
            return;
          }
        }
      } catch (err: any) {
        logger.error(`Release symlink rollback failed: ${err.message}`, { error: err });
      }
    }

    if (!data.previousSuccessfulSha) {
      logger.warn(
        `Rollback skipped for project '${data.projectName}': No previous successful SHA found.`,
      );
      return;
    }

    try {
      // 1. Reset repository to previous successful SHA
      await this.gitClient.resetHard(data.projectPath, data.previousSuccessfulSha);
      await this.gitClient.cleanUntracked(data.projectPath);

      if (isIsolated && fs.existsSync(workingDir)) {
        await this.gitClient.resetHard(workingDir, data.previousSuccessfulSha);
        await this.gitClient.cleanUntracked(workingDir);
      }

      // 2. Re-run install and build commands if configured
      for (const cmdStr of data.config.deploy.commands.install || []) {
        const parsed = parseCommandString(cmdStr);
        await safeExec(parsed.command, parsed.args || [], { cwd: workingDir });
      }

      for (const cmdStr of data.config.deploy.commands.build || []) {
        const parsed = parseCommandString(cmdStr);
        await safeExec(parsed.command, parsed.args || [], { cwd: workingDir });
      }

      if (isIsolated && fs.existsSync(workingDir)) {
        await this.syncIsolatedWorkspace(workingDir, data.projectPath);
      }

      // 3. Restart systemd service via Unitup
      if (data.config.deploy.service.action !== 'none') {
        await this.unitupAdapter.restart(data.config.deploy.service.name);
      }

      // 4. Verify readiness again via Ready-checker
      if (data.config.deploy.ready.checks.length > 0) {
        await this.readyAdapter.wait(data.config.deploy.ready);
      }

      logger.info(
        `Rollback successfully completed for project '${data.projectName}' at SHA ${data.previousSuccessfulSha}`,
        {
          project: data.projectName,
        },
      );
    } catch (err: any) {
      throw new RollbackError(
        `Automated rollback failed for project '${data.projectName}': ${err.message}`,
      );
    }
  }

  private async syncIsolatedWorkspace(sourceDir: string, targetDir: string): Promise<void> {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    try {
      await safeExec('rsync', [
        '-av',
        '--delete',
        '--exclude=.git',
        `${sourceDir}/`,
        `${targetDir}/`,
      ]);
    } catch {
      fs.cpSync(sourceDir, targetDir, {
        recursive: true,
        force: true,
        filter: (src) => !src.includes('/.git'),
      });
    }
  }
}
