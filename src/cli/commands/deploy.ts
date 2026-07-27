import chalk from 'chalk';
import { WorkmaticEngine } from '../../jobs/workmatic-engine.js';
import { DeploymentPipelineRunner } from '../../pipeline/pipeline-runner.js';
import { closeDatabase } from '../../storage/database.js';
import { SourceWatcher } from '../../watcher/source-watcher.js';

export async function deployCommand(projectName: string): Promise<void> {
  const workmatic = new WorkmaticEngine();
  const runner = new DeploymentPipelineRunner();
  workmatic.setPipelineRunner(runner);
  await workmatic.startWorker();

  const watcher = new SourceWatcher(workmatic);

  try {
    console.log(chalk.bold(`Triggering manual deployment for '${projectName}'...`));
    const depId = await watcher.checkProject(projectName, 'manual');

    if (depId) {
      console.log(chalk.green(`✔ Manual deployment triggered successfully (ID: #${depId}).`));
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
    // Wait a brief moment for worker to begin processing if active
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await workmatic.stopWorker();
    closeDatabase();
  }
}
