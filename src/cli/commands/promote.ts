import chalk from 'chalk';
import { resolveProjectName } from '../../config/parser.js';
import { UnitupAdapter } from '../../runtime/unitup-adapter.js';
import { closeDatabase } from '../../storage/database.js';
import { ProjectRepository } from '../../storage/project-repository.js';

export async function promoteCommand(projectName?: string): Promise<void> {
  const targetProject = resolveProjectName(projectName);
  if (!targetProject) {
    console.error(
      chalk.red(
        '✖ Error: Project name is required. Specify project name or run in a directory containing deployra.config.yaml',
      ),
    );
    process.exit(1);
  }

  const projRepo = new ProjectRepository();
  const project = projRepo.getProject(targetProject);

  if (!project) {
    console.error(chalk.red(`✖ Error: Project '${targetProject}' is not registered in Deployra.`));
    process.exit(1);
  }

  const serviceName = project.config.deploy.service.name || targetProject;
  const unitup = new UnitupAdapter();

  try {
    console.log(
      chalk.bold(`Promoting canary generation for project '${chalk.cyan(targetProject)}'...`),
    );

    const result = await unitup.promoteZeroDowntime(serviceName);

    console.log(
      chalk.green(
        `✔ Successfully promoted generation #${result.promotedGeneration} to 100% active traffic! (previous: #${result.previousGeneration || 'none'}, downtime: ${result.downtimeMs}ms)`,
      ),
    );
  } catch (err: any) {
    console.error(
      chalk.red(`✖ Failed to promote canary for project '${targetProject}': ${err.message}`),
    );
    process.exitCode = 1;
  } finally {
    closeDatabase();
  }
}
