import chalk from 'chalk';
import { resolveProjectName } from '../../config/parser.js';
import { closeDatabase } from '../../storage/database.js';
import { ProjectRepository } from '../../storage/project-repository.js';

export function removeCommand(projectName?: string): void {
  const targetProject = resolveProjectName(projectName);
  if (!targetProject) {
    console.error(
      chalk.red(
        '✖ Error: Project name is required. Specify project name or run in a directory containing deployra.config.yaml',
      ),
    );
    process.exit(1);
  }

  try {
    const repo = new ProjectRepository();
    const deleted = repo.deleteProject(targetProject);

    if (deleted) {
      console.log(chalk.green(`✔ Removed project '${targetProject}' from Deployra registry.`));
    } else {
      console.log(chalk.yellow(`Project '${targetProject}' was not found in registry.`));
    }
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to remove project '${targetProject}': ${err.message}`));
    process.exit(1);
  } finally {
    closeDatabase();
  }
}
