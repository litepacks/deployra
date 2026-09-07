import chalk from 'chalk';
import { resolveProjectName } from '../../config/parser.js';
import { maskSecrets } from '../../logging/masker.js';
import { DeploymentRepository } from '../../storage/deployment-repository.js';

export async function logsCommand(
  projectName?: string,
  options: {
    follow?: boolean;
    deployment?: string;
    format?: 'pretty' | 'json' | 'jsonl';
    step?: string;
  } = {},
): Promise<void> {
  const targetProject = resolveProjectName(projectName);
  const depRepo = new DeploymentRepository();

  let deploymentId = options.deployment;
  if (!deploymentId && targetProject) {
    const latest = depRepo.getLatestDeployment(targetProject);
    if (latest) deploymentId = latest.id;
  }

  if (!deploymentId) {
    if (options.format === 'json') {
      console.log(JSON.stringify({ error: 'No deployment found' }, null, 2));
    } else if (options.format === 'jsonl') {
      console.log(JSON.stringify({ error: 'No deployment found' }));
    } else {
      console.log(
        chalk.yellow(
          'No deployment found to fetch logs for. Specify a project name or deployment ID with --deployment.',
        ),
      );
    }
    return;
  }

  // Handle JSON / JSONL output formats
  if (options.format === 'json') {
    const dep = depRepo.getDeployment(deploymentId);
    if (!dep) {
      console.error(JSON.stringify({ error: `Deployment #${deploymentId} not found` }, null, 2));
      return;
    }
    if (options.step) {
      const step = dep.steps.find((s) => s.stepName === options.step);
      console.log(JSON.stringify(step || null, null, 2));
    } else {
      console.log(JSON.stringify(dep, null, 2));
    }
    return;
  }

  if (options.format === 'jsonl') {
    const dep = depRepo.getDeployment(deploymentId);
    if (!dep) {
      console.error(JSON.stringify({ error: `Deployment #${deploymentId} not found` }));
      return;
    }
    if (options.step) {
      const step = dep.steps.find((s) => s.stepName === options.step);
      if (step) {
        console.log(JSON.stringify(step));
      }
    } else {
      console.log(
        JSON.stringify({
          type: 'deployment',
          id: dep.id,
          projectName: dep.projectName,
          status: dep.status,
          targetSha: dep.targetSha,
          createdAt: dep.createdAt,
        }),
      );
      for (const step of dep.steps) {
        console.log(JSON.stringify({ type: 'step', ...step }));
      }
    }
    return;
  }

  // Pretty Console Output
  const renderedSteps = new Map<string, string>();

  const printLogs = (): boolean => {
    const dep = depRepo.getDeployment(deploymentId);
    if (!dep) {
      console.log(chalk.red(`Deployment #${deploymentId} not found.`));
      return true;
    }

    if (renderedSteps.size === 0) {
      console.log(
        chalk.bold(`\nLogs for Deployment #${dep.id} (${dep.projectName} - ${dep.status}):\n`),
      );
    }

    const stepsToDisplay = options.step
      ? dep.steps.filter((s) => s.stepName === options.step)
      : dep.steps;

    for (const step of stepsToDisplay) {
      const prevStatus = renderedSteps.get(step.stepName);
      if (prevStatus !== step.status) {
        renderedSteps.set(step.stepName, step.status);

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

        if (step.output) {
          const lines = step.output.trim().split('\n');
          for (const line of lines) {
            console.log(`   ${chalk.gray(maskSecrets(line))}`);
          }
        }

        if (step.status === 'failed' && step.error) {
          console.log(`   ${chalk.red('Error:')} ${maskSecrets(step.error)}`);
        }
      }
    }

    const isTerminalState =
      dep.status === 'success' ||
      dep.status === 'failed' ||
      dep.status === 'cancelled' ||
      dep.status === 'rolled_back' ||
      dep.status === 'rollback_failed';

    if (isTerminalState) {
      if (dep.error && !dep.steps.some((s) => s.error === dep.error)) {
        console.log(`\n${chalk.red('Deployment Failure:')} ${maskSecrets(dep.error)}`);
      }
      return true;
    }

    return false;
  };

  const finished = printLogs();

  if (options.follow && !finished) {
    console.log(chalk.gray('\nStreaming live logs... (Press Ctrl+C to stop)\n'));
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const isDone = printLogs();
        if (isDone) {
          clearInterval(interval);
          resolve();
        }
      }, 500);
    });
  }
}
