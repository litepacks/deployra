import chalk from 'chalk';
import { closeDatabase } from '../../storage/database.js';
import { ProjectRepository } from '../../storage/project-repository.js';

export function removeCommand(projectName: string): void {
  try {
    const repo = new ProjectRepository();
    const deleted = repo.deleteProject(projectName);

    if (deleted) {
      console.log(chalk.green(`✔ Removed project '${projectName}' from Deployra registry.`));
    } else {
      console.log(chalk.yellow(`Project '${projectName}' was not found in registry.`));
    }
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to remove project '${projectName}': ${err.message}`));
    process.exit(1);
  } finally {
    closeDatabase();
  }
}
