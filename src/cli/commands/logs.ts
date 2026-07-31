import chalk from 'chalk';
import { maskSecrets } from '../../logging/masker.js';
import { DeploymentRepository } from '../../storage/deployment-repository.js';

export function logsCommand(
  projectName?: string,
  options: { follow?: boolean; deployment?: string; format?: 'pretty' | 'json' | 'jsonl' } = {},
): void {
  const depRepo = new DeploymentRepository();

  let deploymentId = options.deployment;
  if (!deploymentId && projectName) {
    const latest = depRepo.getLatestDeployment(projectName);
    if (latest) deploymentId = latest.id;
  }

  if (!deploymentId) {
    console.log(
      chalk.yellow(
        'No deployment found to fetch logs for. Specify a project name or deployment ID with --deployment.',
      ),
    );
    return;
  }

  const dep = depRepo.getDeployment(deploymentId);
  if (!dep) {
    console.log(chalk.red(`Deployment #${deploymentId} not found.`));
    return;
  }

  console.log(
    chalk.bold(`\nLogs for Deployment #${dep.id} (${dep.projectName} - ${dep.status}):\n`),
  );

  for (const step of dep.steps) {
    const statusSymbol =
      step.status === 'success'
        ? chalk.green('✔')
        : step.status === 'failed'
          ? chalk.red('✖')
          : step.status === 'running'
            ? chalk.yellow('▶')
            : chalk.gray('•');

    const durationStr = step.duration ? chalk.gray(`(${step.duration}ms)`) : '';
    console.log(`${statusSymbol} Step: ${chalk.bold(step.stepName)} ${durationStr}`);
    if (step.status === 'failed' && step.error) {
      console.log(`   ${chalk.red('Error:')} ${maskSecrets(step.error)}`);
    }
  }

  if (dep.error) {
    console.log(`\n${chalk.red('Deployment Failure:')} ${maskSecrets(dep.error)}`);
  }
}
