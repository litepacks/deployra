import chalk from 'chalk';
import { resolveProjectName } from '../../config/parser.js';
import { closeDatabase } from '../../storage/database.js';
import { DeploymentRepository } from '../../storage/deployment-repository.js';

export function cancelCommand(target?: string): void {
  const targetProjectOrId = resolveProjectName(target) || target;
  if (!targetProjectOrId) {
    console.error(
      chalk.red(
        '✖ Error: Project name or deployment ID is required. Specify target or run in a directory containing deployra.config.yaml',
      ),
    );
    process.exit(1);
  }

  try {
    const repo = new DeploymentRepository();

    let deployment = repo.getDeployment(targetProjectOrId);
    if (!deployment) {
      const active = repo.getActiveDeployments(targetProjectOrId);
      if (active.length > 0) {
        deployment = active[0];
      }
    }

    if (!deployment) {
      console.log(chalk.yellow(`No active deployment found matching '${targetProjectOrId}'.`));
      return;
    }

    repo.updateStatus(deployment.id, 'cancelled', 'Manually cancelled via CLI');
    console.log(
      chalk.green(
        `✔ Cancelled deployment #${deployment.id} for project '${deployment.projectName}'`,
      ),
    );
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to cancel deployment '${targetProjectOrId}': ${err.message}`));
    process.exit(1);
  } finally {
    closeDatabase();
  }
}
