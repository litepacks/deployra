import chalk from 'chalk';
import { ProjectRepository } from '../../storage/project-repository.js';

export function removeCommand(projectName: string): void {
  const repo = new ProjectRepository();
  const deleted = repo.deleteProject(projectName);

  if (deleted) {
    console.log(chalk.green(`✔ Removed project '${projectName}' from Gitship registry.`));
  } else {
    console.log(chalk.yellow(`Project '${projectName}' was not found in registry.`));
  }
}
