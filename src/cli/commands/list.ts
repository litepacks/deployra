import Table from 'cli-table3';
import chalk from 'chalk';
import { ProjectRepository } from '../../storage/project-repository.js';

export function listCommand(): void {
  const repo = new ProjectRepository();
  const projects = repo.getAllProjects();

  if (projects.length === 0) {
    console.log(
      chalk.yellow(
        'No projects currently registered in Gitship. Use `gitship add` to register a project.',
      ),
    );
    return;
  }

  const table = new Table({
    head: [
      chalk.cyan('Project'),
      chalk.cyan('Path'),
      chalk.cyan('Remote/Branch'),
      chalk.cyan('Last Seen SHA'),
      chalk.cyan('Last Success SHA'),
    ],
  });

  for (const p of projects) {
    table.push([
      chalk.bold(p.name),
      p.path,
      `${p.remote}/${p.branch}`,
      p.lastSeenSha ? p.lastSeenSha.substring(0, 7) : chalk.gray('none'),
      p.lastSuccessfulSha ? chalk.green(p.lastSuccessfulSha.substring(0, 7)) : chalk.gray('none'),
    ]);
  }

  console.log(table.toString());
}
