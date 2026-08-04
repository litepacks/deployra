import chalk from 'chalk';
import Table from 'cli-table3';
import { closeDatabase } from '../../storage/database.js';
import { ProjectRepository } from '../../storage/project-repository.js';

export function listCommand(): void {
  try {
    const repo = new ProjectRepository();
    const projects = repo.getAllProjects();

    if (projects.length === 0) {
      console.log(
        chalk.yellow(
          'No projects currently registered in Deployra. Use `deployra add` to register a project.',
        ),
      );
      return;
    }

    const table = new Table({
      head: [
        chalk.cyan('Project'),
        chalk.cyan('Config Version'),
        chalk.cyan('Path'),
        chalk.cyan('Remote/Branch'),
        chalk.cyan('Last Seen SHA'),
        chalk.cyan('Last Success SHA'),
      ],
    });

    for (const p of projects) {
      table.push([
        chalk.bold(p.name),
        `v${p.configVersion} (${p.configHash ? p.configHash.substring(0, 10) : 'cfg_default'})`,
        p.path,
        `${p.remote}/${p.branch}`,
        p.lastSeenSha ? p.lastSeenSha.substring(0, 7) : chalk.gray('none'),
        p.lastSuccessfulSha ? chalk.green(p.lastSuccessfulSha.substring(0, 7)) : chalk.gray('none'),
      ]);
    }

    console.log(table.toString());
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to list projects: ${err.message}`));
    process.exit(1);
  } finally {
    closeDatabase();
  }
}
