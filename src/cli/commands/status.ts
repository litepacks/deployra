import chalk from 'chalk';
import Table from 'cli-table3';
import { resolveProjectName } from '../../config/parser.js';
import { closeDatabase } from '../../storage/database.js';
import { DeploymentRepository } from '../../storage/deployment-repository.js';
import { ProjectRepository } from '../../storage/project-repository.js';

export function statusCommand(projectName?: string): void {
  const targetProject = resolveProjectName(projectName);
  try {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    const projects = targetProject
      ? [projRepo.getProject(targetProject)].filter(Boolean)
      : projRepo.getAllProjects();

    if (projects.length === 0) {
      console.log(chalk.yellow('No matching projects found.'));
      return;
    }

    const table = new Table({
      head: [
        chalk.cyan('Project'),
        chalk.cyan('Config Version'),
        chalk.cyan('Latest Dep ID'),
        chalk.cyan('Status'),
        chalk.cyan('Target SHA'),
        chalk.cyan('Trigger'),
        chalk.cyan('Created At'),
      ],
    });

    for (const p of projects) {
      const latest = depRepo.getLatestDeployment(p!.name);
      const configVer = `v${p!.configVersion}`;
      if (latest) {
        let statusColor = chalk.white;
        switch (latest.status) {
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
          chalk.bold(p!.name),
          configVer,
          `#${latest.id}`,
          statusColor(latest.status),
          latest.targetSha.substring(0, 7),
          latest.triggerType,
          new Date(latest.createdAt).toLocaleString(),
        ]);
      } else {
        table.push([
          chalk.bold(p!.name),
          configVer,
          chalk.gray('none'),
          chalk.gray('no deployments'),
          '-',
          '-',
          '-',
        ]);
      }
    }

    console.log(table.toString());
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to fetch status: ${err.message}`));
    process.exit(1);
  } finally {
    closeDatabase();
  }
}
