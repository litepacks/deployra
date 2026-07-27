import type { NormalizedDeployraConfig } from '../config/types.js';
import { RollbackError } from '../errors/deployra-error.js';
import { GitClient } from '../git/git-client.js';
import { logger } from '../logging/logger.js';
import { ReadyCheckerAdapter } from '../readiness/ready-checker-adapter.js';
import { UnitupAdapter } from '../runtime/unitup-adapter.js';
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

    try {
      // 1. Reset repository to previous successful SHA
      await this.gitClient.resetHard(data.projectPath, data.previousSuccessfulSha);
      await this.gitClient.cleanUntracked(data.projectPath);

      // 2. Re-run install and build commands if configured
      for (const cmdStr of data.config.deploy.commands.install) {
        const parts = cmdStr.split(' ');
        await safeExec(parts[0], parts.slice(1), { cwd: data.projectPath });
      }

      for (const cmdStr of data.config.deploy.commands.build) {
        const parts = cmdStr.split(' ');
        await safeExec(parts[0], parts.slice(1), { cwd: data.projectPath });
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
}
