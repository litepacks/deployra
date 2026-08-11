import chalk from 'chalk';
import { resolveProjectName } from '../../config/parser.js';
import { UnitupAdapter } from '../../runtime/unitup-adapter.js';
import { closeDatabase } from '../../storage/database.js';
import { ProjectRepository } from '../../storage/project-repository.js';

export async function removeCommand(projectName?: string): Promise<void> {
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
    const existingProject = repo.getProject(targetProject);
    const unitup = new UnitupAdapter();

    if (existingProject) {
      const serviceName = existingProject.config.deploy.service.name || targetProject;
      await unitup.remove(serviceName);

      const deleted = repo.deleteProject(targetProject);
      if (deleted) {
        console.log(
          chalk.green(
            `✔ Removed project '${targetProject}' from Deployra registry and stopped associated systemd service '${serviceName}'.`,
          ),
        );
      }
    } else {
      await unitup.remove(targetProject);
      console.log(chalk.yellow(`Project '${targetProject}' was not found in registry.`));
    }
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to remove project '${targetProject}': ${err.message}`));
    process.exit(1);
  } finally {
    closeDatabase();
  }
}
