import chalk from 'chalk';
import { DeploymentRepository } from '../../storage/deployment-repository.js';

export function cancelCommand(target: string): void {
  const repo = new DeploymentRepository();

  let deployment = repo.getDeployment(target);
  if (!deployment) {
    const active = repo.getActiveDeployments(target);
    if (active.length > 0) {
      deployment = active[0];
    }
  }

  if (!deployment) {
    console.log(chalk.yellow(`No active deployment found matching '${target}'.`));
    return;
  }

  repo.updateStatus(deployment.id, 'cancelled', 'Manually cancelled via CLI');
  console.log(
    chalk.green(`✔ Cancelled deployment #${deployment.id} for project '${deployment.projectName}'`),
  );
}
