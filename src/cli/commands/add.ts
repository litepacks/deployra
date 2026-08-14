import chalk from 'chalk';
import { loadConfig } from '../../config/parser.js';
import { isUrlLike } from '../../config/schema.js';
import { WorkmaticEngine } from '../../jobs/workmatic-engine.js';
import { isDaemonRunning } from '../../runtime/daemon-check.js';
import { closeDatabase } from '../../storage/database.js';
import { ProjectRepository } from '../../storage/project-repository.js';
import { SourceWatcher } from '../../watcher/source-watcher.js';

export async function addCommand(configPath?: string): Promise<void> {
  try {
    const config = loadConfig(configPath);
    const repo = new ProjectRepository();
    const saved = repo.saveProject(config);

    if (isUrlLike(saved.name)) {
      console.log(
        chalk.yellow(
          `⚠ Warning: Project name '${saved.name}' looks like a Git URL. It's recommended to use a clean project name (e.g. 'my-app') for project.name in deployra.config.yaml.`,
        ),
      );
    }

    console.log(
      chalk.green(
        `✔ Added project '${saved.name}' (${saved.remote}/${saved.branch}) pointing to '${saved.path}'`,
      ),
    );

    const daemonActive = await isDaemonRunning();
    if (daemonActive) {
      console.log(
        chalk.green(
          `✔ Background daemon is active and will process initial deployment for '${saved.name}' automatically.`,
        ),
      );
    } else {
      console.log(
        chalk.yellow(
          `⚠ Warning: Deployra daemon is not running. Triggering initial deployment manually...`,
        ),
      );
      const workmatic = new WorkmaticEngine();
      const watcher = new SourceWatcher(workmatic);
      const depId = await watcher.checkProject(saved.name, 'manual');

      if (depId) {
        console.log(chalk.green(`✔ Queued initial deployment #${depId} for '${saved.name}'.`));
      } else {
        console.log(chalk.blue(`ℹ Project '${saved.name}' is up to date at target remote commit.`));
      }
    }
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to add project: ${err.message}`));
    process.exit(1);
  } finally {
    closeDatabase();
  }
}
