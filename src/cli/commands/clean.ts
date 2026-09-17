import chalk from 'chalk';
import { resolveProjectName } from '../../config/parser.js';
import { getDatabaseSize, vacuumDatabase } from '../../storage/database.js';
import { DeploymentRepository } from '../../storage/deployment-repository.js';

export interface CleanCommandOptions {
  keep?: string | number;
  days?: string | number;
  vacuum?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
}

export async function cleanCommand(
  projectName?: string,
  options: CleanCommandOptions = {},
): Promise<void> {
  const resolvedProject = projectName ? resolveProjectName(projectName) || projectName : undefined;
  const depRepo = new DeploymentRepository();

  const keepCount = options.keep !== undefined ? Number.parseInt(String(options.keep), 10) : 50;
  const maxAgeDays =
    options.days !== undefined ? Number.parseInt(String(options.days), 10) : undefined;
  const shouldVacuum = options.vacuum !== false;

  const sizeBefore = getDatabaseSize();

  const targetLabel = resolvedProject ? `project '${chalk.cyan(resolvedProject)}'` : 'all projects';
  console.log(chalk.bold(`\nCleaning deployment logs and database for ${targetLabel}...`));
  if (keepCount !== undefined && !Number.isNaN(keepCount)) {
    console.log(chalk.gray(`  • Retaining at most latest ${keepCount} deployments per project`));
  }
  if (maxAgeDays !== undefined && !Number.isNaN(maxAgeDays)) {
    console.log(chalk.gray(`  • Pruning deployments older than ${maxAgeDays} days`));
  }

  const result = depRepo.pruneDeployments({
    projectName: resolvedProject,
    keepCount: Number.isNaN(keepCount) ? undefined : keepCount,
    maxAgeDays: Number.isNaN(maxAgeDays as number) ? undefined : maxAgeDays,
  });

  if (shouldVacuum) {
    vacuumDatabase();
  }

  const sizeAfter = getDatabaseSize();

  console.log(chalk.green(`\n✔ Clean completed successfully:`));
  console.log(`  • Pruned deployments: ${chalk.yellow(result.deletedDeployments)}`);
  console.log(`  • Pruned step logs:    ${chalk.yellow(result.deletedSteps)}`);
  if (sizeBefore > 0) {
    console.log(
      `  • Database size:       ${formatBytes(sizeBefore)} → ${chalk.green(formatBytes(sizeAfter))}`,
    );
  }
  if (shouldVacuum) {
    console.log(chalk.gray(`  • SQLite VACUUM executed.`));
  }
  console.log('');
}
