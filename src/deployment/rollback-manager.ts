import fs from 'node:fs';
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
    previousSuccessfulSha: string;
    config: NormalizedDeployraConfig;
  }): Promise<void> {
    logger.warn(
      `Initiating automated rollback for project '${data.projectName}' to SHA ${data.previousSuccessfulSha}`,
      {
        project: data.projectName,
      },
    );

    const isIsolated = data.config.deploy.strategy === 'isolated';
    const workingDir = isIsolated ? data.config.deploy.workspacePath : data.projectPath;

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
