import readline from 'node:readline';
import chalk from 'chalk';
import Table from 'cli-table3';
import { resolveProjectName } from '../../config/parser.js';
import { RollbackManager } from '../../deployment/rollback-manager.js';
import { closeDatabase } from '../../storage/database.js';
import { DeploymentRepository } from '../../storage/deployment-repository.js';
import { ProjectRepository } from '../../storage/project-repository.js';

export interface RollbackCommandOptions {
  to?: string;
  inline?: boolean;
}

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

export async function rollbackCommand(
  projectName?: string,
  options: RollbackCommandOptions = {},
): Promise<void> {
  const targetProject = resolveProjectName(projectName);
  if (!targetProject) {
    console.error(
      chalk.red(
        '✖ Error: Project name is required. Specify project name or run in a directory containing deployra.config.yaml',
      ),
    );
    process.exit(1);
  }

  const projRepo = new ProjectRepository();
  const depRepo = new DeploymentRepository();
  const project = projRepo.getProject(targetProject);

  if (!project) {
    console.error(chalk.red(`✖ Error: Project '${targetProject}' is not registered in Deployra.`));
    process.exit(1);
  }

  const history = depRepo.getDeploymentsByProject(targetProject, 20);
  const successfulDeployments = history.filter((d) => d.status === 'success');

  if (successfulDeployments.length === 0) {
    console.error(
      chalk.red(
        `✖ Error: No successful past deployments found for project '${targetProject}' to rollback to.`,
      ),
    );
    process.exit(1);
  }

  let selectedDeployment = successfulDeployments[0];

  if (options.to) {
    const specified = history.find(
      (d) =>
        d.id === options.to || d.id === `dep_${options.to}` || d.targetSha.startsWith(options.to!),
    );
    if (!specified) {
      console.error(
        chalk.red(
          `✖ Error: Deployment '${options.to}' not found in history for project '${targetProject}'.`,
        ),
      );
      process.exit(1);
    }
    selectedDeployment = specified;
  } else if (process.stdin.isTTY && successfulDeployments.length > 1) {
    console.log(chalk.bold(`\nAvailable Rollback Targets for '${chalk.cyan(targetProject)}':\n`));

    const table = new Table({
      head: [
        chalk.cyan('#'),
        chalk.cyan('Deployment ID'),
        chalk.cyan('Target SHA'),
        chalk.cyan('Created At'),
      ],
    });

    successfulDeployments.slice(0, 10).forEach((dep, idx) => {
      table.push([
        chalk.bold(String(idx + 1)),
        `#${dep.id}`,
        dep.targetSha.substring(0, 7),
        new Date(dep.createdAt).toLocaleString(),
      ]);
    });

    console.log(table.toString());
    console.log('');

    const answer = await askQuestion(
      chalk.yellow(
        `Select deployment number to rollback to (1-${Math.min(10, successfulDeployments.length)}) [default: 1]: `,
      ),
    );

    if (answer) {
      const idx = Number.parseInt(answer, 10);
      if (Number.isNaN(idx) || idx < 1 || idx > successfulDeployments.length) {
        console.error(chalk.red(`✖ Invalid selection '${answer}'. Aborting rollback.`));
        process.exit(1);
      }
      selectedDeployment = successfulDeployments[idx - 1];
    }
  }

  console.log(
    chalk.bold(
      `\nRolling back '${chalk.cyan(targetProject)}' to deployment #${chalk.yellow(selectedDeployment.id)} (SHA: ${chalk.green(selectedDeployment.targetSha.substring(0, 7))})...`,
    ),
  );

  const rollbackManager = new RollbackManager();

  try {
    await rollbackManager.rollback({
      projectName: targetProject,
      projectPath: project.path,
      previousSuccessfulSha: selectedDeployment.targetSha,
      deploymentId: selectedDeployment.id,
      config: project.config,
    });

    projRepo.updateLastSuccessfulSha(targetProject, selectedDeployment.targetSha);
    console.log(
      chalk.green(
        `\n✔ Rollback successfully completed! Project '${targetProject}' is now at commit ${selectedDeployment.targetSha.substring(0, 7)}.`,
      ),
    );
  } catch (err: any) {
    console.error(chalk.red(`\n✖ Rollback failed: ${err.message}`));
    process.exit(1);
  } finally {
    closeDatabase();
  }
}
