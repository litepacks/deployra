import chalk from 'chalk';
import { resolveProjectName } from '../../config/parser.js';
import { WorkmaticEngine } from '../../jobs/workmatic-engine.js';
import { isDaemonRunning } from '../../runtime/daemon-check.js';
import { closeDatabase } from '../../storage/database.js';
import { DeploymentRepository } from '../../storage/deployment-repository.js';
import { SourceWatcher } from '../../watcher/source-watcher.js';

export async function deployCommand(
  projectName?: string,
  options?: { dryRun?: boolean },
): Promise<void> {
  const targetProject = resolveProjectName(projectName);
  if (!targetProject) {
    console.error(
      chalk.red(
        '✖ Error: Project name is required. Specify project name or run in a directory containing deployra.config.yaml',
      ),
    );
    process.exit(1);
  }

  const isDryRun = Boolean(options?.dryRun);
  const workmatic = new WorkmaticEngine();
  const depRepo = new DeploymentRepository();
  const watcher = new SourceWatcher(workmatic);

  try {
    if (isDryRun) {
      console.log(
        chalk.yellow.bold(
          `⚡ [DRY-RUN MODE] Simulating deployment for '${targetProject}' (no real shell/service commands will be run)...`,
        ),
      );
    } else {
      const daemonActive = await isDaemonRunning();
      if (!daemonActive) {
        console.log(
          chalk.yellow(
            `⚠ Warning: Deployra daemon ('deployra-daemon') is not running. Deployment will remain queued until the daemon is started.`,
          ),
        );
      }
      console.log(chalk.bold(`Triggering manual deployment for '${targetProject}'...`));
    }

    const depId = await watcher.checkProject(targetProject, 'manual', isDryRun);

    if (depId) {
      console.log(
        chalk.green(
          `✔ ${isDryRun ? '[DRY-RUN] ' : ''}Deployment queued (ID: #${depId}). Processing...`,
        ),
      );

      let finalStatus = 'queued';
      for (let i = 0; i < 120; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const dep = depRepo.getDeployment(depId);
        if (dep && dep.status !== 'queued' && dep.status !== 'running') {
          finalStatus = dep.status;
          break;
        }
      }

      if (finalStatus === 'success') {
        if (isDryRun) {
          console.log(
            chalk.cyan.bold(
              `✔ [DRY-RUN] Deployment simulation #${depId} completed successfully! No actual system changes were executed.`,
            ),
          );
        } else {
          console.log(chalk.green(`✔ Deployment #${depId} completed successfully!`));
        }
      } else if (finalStatus === 'rolled_back') {
        console.log(chalk.yellow(`⚠ Deployment #${depId} failed and was rolled back.`));
      } else if (finalStatus === 'failed') {
        console.log(chalk.red(`✖ Deployment #${depId} failed.`));
      } else {
        console.log(chalk.blue(`ℹ Deployment #${depId} current status: ${finalStatus}`));
      }
    } else {
      console.log(
        chalk.yellow(
          `Could not trigger deployment for '${targetProject}'. Check configuration and repository state.`,
        ),
      );
    }
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to trigger deployment: ${err.message}`));
  } finally {
    closeDatabase();
  }
}
