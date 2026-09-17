import chalk from 'chalk';
import { loadConfig, resolveProjectName } from '../../config/parser.js';
import { WorkmaticEngine } from '../../jobs/workmatic-engine.js';
import { DeploymentPipelineRunner } from '../../pipeline/pipeline-runner.js';
import { isDaemonRunning } from '../../runtime/daemon-check.js';
import { closeDatabase } from '../../storage/database.js';
import { DeploymentRepository } from '../../storage/deployment-repository.js';
import { ProjectRepository } from '../../storage/project-repository.js';
import { SourceWatcher } from '../../watcher/source-watcher.js';

async function logDeploymentMode(
  targetProject: string,
  isDryRun: boolean,
  isInline: boolean,
): Promise<void> {
  if (isDryRun) {
    console.log(
      chalk.yellow.bold(
        `⚡ [DRY-RUN MODE] Simulating deployment for '${targetProject}' (no real shell/service commands will be run)...`,
      ),
    );
  } else if (isInline) {
    console.log(
      chalk.blue.bold(
        `🚀 [INLINE MODE] Executing deployment pipeline directly in current process...`,
      ),
    );
  } else {
    const daemonActive = await isDaemonRunning();
    if (!daemonActive) {
      console.log(
        chalk.yellow(
          `⚠ Warning: Deployra daemon ('deployra-daemon') is not running. Deployment will remain queued until daemon is started. (Tip: use '--inline' to run directly without daemon).`,
        ),
      );
    }
    console.log(chalk.bold(`Triggering manual deployment for '${targetProject}'...`));
  }
}

async function executeInlineDeployment(
  depId: string,
  depRepo: DeploymentRepository,
): Promise<void> {
  const dep = depRepo.getDeployment(depId);
  if (dep) {
    const runner = new DeploymentPipelineRunner();
    await runner.runDeployment({
      deploymentId: dep.id,
      projectName: dep.projectName,
      previousSha: dep.previousSha,
      targetSha: dep.targetSha,
      triggerType: dep.triggerType,
      dryRun: dep.dryRun,
      triggeredAt: dep.createdAt,
    });
  }
}

async function pollDeploymentStatus(
  depId: string,
  depRepo: DeploymentRepository,
  isDryRun: boolean,
): Promise<void> {
  console.log(
    chalk.green(
      `✔ ${isDryRun ? '[DRY-RUN] ' : ''}Deployment queued (ID: #${depId}). Processing...`,
    ),
  );

  for (let i = 0; i < 120; i++) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 500);
    });
    const dep = depRepo.getDeployment(depId);
    if (dep && dep.status !== 'queued' && dep.status !== 'running') {
      break;
    }
  }
}

function reportDeploymentResult(
  depId: string,
  finalStatus: string,
  isDryRun: boolean,
  isInline: boolean,
): void {
  if (finalStatus === 'success') {
    if (isDryRun) {
      console.log(
        chalk.cyan.bold(
          `✔ [DRY-RUN] Deployment simulation #${depId} completed successfully! No actual system changes were executed.`,
        ),
      );
    } else {
      console.log(chalk.green(`✔ Deployment #${depId} completed successfully!`));
    }
  } else if (finalStatus === 'rolled_back') {
    console.log(chalk.yellow(`⚠ Deployment #${depId} failed and was rolled back.`));
    if (isInline) process.exitCode = 1;
  } else if (finalStatus === 'failed') {
    console.log(chalk.red(`✖ Deployment #${depId} failed.`));
    if (isInline) process.exitCode = 1;
  } else {
    console.log(chalk.blue(`ℹ Deployment #${depId} current status: ${finalStatus}`));
  }
}

export async function deployCommand(
  projectName?: string,
  options?: { dryRun?: boolean; inline?: boolean; env?: string },
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

  const isDryRun = Boolean(options?.dryRun);
  const isInline = Boolean(options?.inline);
  const workmatic = new WorkmaticEngine();
  const depRepo = new DeploymentRepository();
  const projRepo = new ProjectRepository();

  if (options?.env) {
    try {
      const freshConfig = loadConfig(undefined, options.env);
      if (freshConfig && freshConfig.project.name === targetProject) {
        projRepo.saveProject(freshConfig);
        console.log(chalk.cyan(`ℹ Activated environment profile: '${chalk.bold(options.env)}'`));
      }
    } catch {
      // If local file not found or name differs, proceed with existing registered config
    }
  }

  const watcher = new SourceWatcher(workmatic);

  try {
    await logDeploymentMode(targetProject, isDryRun, isInline);

    const depId = await watcher.checkProject(targetProject, 'manual', isDryRun);

    if (depId) {
      if (isInline) {
        await executeInlineDeployment(depId, depRepo);
      } else {
        await pollDeploymentStatus(depId, depRepo, isDryRun);
      }

      const finalDep = depRepo.getDeployment(depId);
      const finalStatus = finalDep?.status || 'unknown';
      reportDeploymentResult(depId, finalStatus, isDryRun, isInline);
    } else {
      console.log(
        chalk.yellow(
          `Could not trigger deployment for '${targetProject}'. Check configuration and repository state.`,
        ),
      );
    }
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to trigger deployment: ${err.message}`));
    if (isInline) process.exitCode = 1;
  } finally {
    closeDatabase();
  }
}
