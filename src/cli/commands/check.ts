import chalk from 'chalk';
import { WorkmaticEngine } from '../../jobs/workmatic-engine.js';
import { SourceWatcher } from '../../watcher/source-watcher.js';
import { ProjectRepository } from '../../storage/project-repository.js';
import { closeDatabase } from '../../storage/database.js';

export async function checkCommand(targetProjectName?: string): Promise<void> {
  const workmatic = new WorkmaticEngine();
  const watcher = new SourceWatcher(workmatic);
  const repo = new ProjectRepository();

  const projects = targetProjectName
    ? [repo.getProject(targetProjectName)].filter(Boolean)
    : repo.getAllProjects();

  if (projects.length === 0) {
    console.log(chalk.yellow('No matching projects found to check.'));
    return;
  }

  console.log(chalk.bold('\nChecking remote repositories for changes...\n'));

  for (const p of projects) {
    try {
      const depId = await watcher.checkProject(p!.name, 'poll');
      if (depId) {
        console.log(
          chalk.green(`✔ New commit detected for '${p!.name}'. Created deployment #${depId}`),
        );
      } else {
        console.log(chalk.gray(`• Project '${p!.name}' is up to date.`));
      }
    } catch (err: any) {
      console.log(chalk.red(`✖ Failed checking '${p!.name}': ${err.message}`));
    }
  }

  closeDatabase();
}
