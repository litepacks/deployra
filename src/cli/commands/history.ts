import Table from 'cli-table3';
import chalk from 'chalk';
import { DeploymentRepository } from '../../storage/deployment-repository.js';

export function historyCommand(projectName: string, limit = 10): void {
  const depRepo = new DeploymentRepository();
  const deployments = depRepo.getDeploymentsByProject(projectName, limit);

  if (deployments.length === 0) {
    console.log(chalk.yellow(`No deployment history found for project '${projectName}'.`));
    return;
  }

  console.log(chalk.bold(`\nDeployment History for '${projectName}':\n`));

  const table = new Table({
    head: [
      chalk.cyan('Dep ID'),
      chalk.cyan('Status'),
      chalk.cyan('Target SHA'),
      chalk.cyan('Prev SHA'),
      chalk.cyan('Trigger'),
      chalk.cyan('Date'),
    ],
  });

  for (const dep of deployments) {
    let statusColor = chalk.white;
    switch (dep.status) {
      case 'success':
        statusColor = chalk.green;
        break;
      case 'failed':
      case 'rollback_failed':
        statusColor = chalk.red;
        break;
      case 'running':
      case 'rolling_back':
        statusColor = chalk.yellow;
        break;
      case 'cancelled':
        statusColor = chalk.gray;
        break;
    }

    table.push([
      `#${dep.id}`,
      statusColor(dep.status),
      dep.targetSha.substring(0, 7),
      dep.previousSha ? dep.previousSha.substring(0, 7) : '-',
      dep.triggerType,
      new Date(dep.createdAt).toLocaleString(),
    ]);
  }

  console.log(table.toString());
}
