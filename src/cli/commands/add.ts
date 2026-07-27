import chalk from 'chalk';
import { loadConfig } from '../../config/parser.js';
import { WorkmaticEngine } from '../../jobs/workmatic-engine.js';
import { closeDatabase } from '../../storage/database.js';
import { ProjectRepository } from '../../storage/project-repository.js';
import { SourceWatcher } from '../../watcher/source-watcher.js';

export async function addCommand(configPath?: string): Promise<void> {
  try {
    const config = loadConfig(configPath);
    const repo = new ProjectRepository();
    const saved = repo.saveProject(config);

    console.log(
      chalk.green(
        `✔ Added project '${saved.name}' (${saved.remote}/${saved.branch}) pointing to '${saved.path}'`,
      ),
    );

    // Automatically trigger initial check & queue deployment
    const workmatic = new WorkmaticEngine();
    const watcher = new SourceWatcher(workmatic);
    const depId = await watcher.checkProject(saved.name, 'manual');

    if (depId) {
      console.log(chalk.green(`✔ Queued initial deployment #${depId} for '${saved.name}'.`));
    } else {
      console.log(chalk.blue(`ℹ Project '${saved.name}' is up to date at target remote commit.`));
    }

    console.log(
      chalk.gray(`ℹ Background monitoring active for '${saved.name}'. (Daemon: deployra watch)`),
    );
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to add project: ${err.message}`));
    process.exit(1);
  } finally {
    closeDatabase();
  }
}
