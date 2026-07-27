import chalk from 'chalk';
import Table from 'cli-table3';
import { formatDurationMs } from '../../config/duration.js';
import { DeploymentRepository } from '../../storage/deployment-repository.js';
import { ProjectRepository } from '../../storage/project-repository.js';

export function statsCommand(projectName?: string): void {
  const projRepo = new ProjectRepository();
  const depRepo = new DeploymentRepository();

  const projects = projRepo.getAllProjects();
  const targetProjects = projectName ? projects.filter((p) => p.name === projectName) : projects;

  if (projectName && targetProjects.length === 0) {
    console.log(chalk.yellow(`Project '${projectName}' not found in Deployra registry.`));
    return;
  }

  const stats = depRepo.getStats(projectName);
  const successRate = stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) : '0.0';

  console.log(
    chalk.bold(`\n📊 Deployra Deployment Statistics${projectName ? ` (${projectName})` : ''}:\n`),
  );

  const table = new Table({
    head: [chalk.cyan('Metric'), chalk.cyan('Value')],
  });

  table.push(
    [chalk.bold('Registered Projects'), projects.length],
    [chalk.bold('Total Deployments'), stats.total],
    [chalk.bold('Successful Deployments'), chalk.green(stats.success)],
    [chalk.bold('Failed Deployments'), stats.failed > 0 ? chalk.red(stats.failed) : '0'],
    [
      chalk.bold('Rolled Back Deployments'),
      stats.rolledBack > 0 ? chalk.yellow(stats.rolledBack) : '0',
    ],
    [chalk.bold('Active / Running'), stats.running > 0 ? chalk.blue(stats.running) : '0'],
    [chalk.bold('Queued'), stats.queued],
    [chalk.bold('Cancelled'), stats.cancelled],
    [chalk.bold('Overall Success Rate'), chalk.bold(`${successRate}%`)],
    [chalk.bold('Avg Deployment Duration'), formatDurationMs(stats.avgDurationMs)],
  );

  console.log(table.toString());
}
