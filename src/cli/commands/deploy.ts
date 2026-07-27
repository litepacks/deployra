import chalk from 'chalk';
import { WorkmaticEngine } from '../../jobs/workmatic-engine.js';
import { DeploymentPipelineRunner } from '../../pipeline/pipeline-runner.js';
import { closeDatabase } from '../../storage/database.js';
import { DeploymentRepository } from '../../storage/deployment-repository.js';
import { SourceWatcher } from '../../watcher/source-watcher.js';

export async function deployCommand(projectName: string): Promise<void> {
  const workmatic = new WorkmaticEngine();
  const runner = new DeploymentPipelineRunner();
  const depRepo = new DeploymentRepository();
  workmatic.setPipelineRunner(runner);
  await workmatic.startWorker();

  const watcher = new SourceWatcher(workmatic);

  try {
    console.log(chalk.bold(`Triggering manual deployment for '${projectName}'...`));
    const depId = await watcher.checkProject(projectName, 'manual');

    if (depId) {
      console.log(chalk.green(`✔ Manual deployment queued (ID: #${depId}). Processing...`));

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
        console.log(chalk.green(`✔ Deployment #${depId} completed successfully!`));
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
          `Could not trigger deployment for '${projectName}'. Check configuration and repository state.`,
        ),
      );
    }
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to trigger deployment: ${err.message}`));
  } finally {
    await workmatic.stopWorker();
    closeDatabase();
  }
}
