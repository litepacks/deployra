import os from 'node:os';
import chalk from 'chalk';
import Table from 'cli-table3';
import { resolveProjectName } from '../../config/parser.js';
import { isDaemonRunning } from '../../runtime/daemon-check.js';
import { UnitupAdapter } from '../../runtime/unitup-adapter.js';
import { closeDatabase, getDatabaseSize } from '../../storage/database.js';
import { DeploymentRepository } from '../../storage/deployment-repository.js';
import { ProjectRepository } from '../../storage/project-repository.js';

export interface StatusCommandOptions {
  watch?: boolean;
  interval?: string | number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
}

function getStatusColor(status: string) {
  switch (status) {
    case 'success':
      return chalk.green;
    case 'failed':
    case 'rollback_failed':
      return chalk.red;
    case 'running':
    case 'rolling_back':
      return chalk.yellow.bold;
    case 'queued':
      return chalk.blue;
    case 'cancelled':
      return chalk.gray;
    default:
      return chalk.white;
  }
}

async function renderDashboard(
  targetProject?: string,
  projRepo = new ProjectRepository(),
  depRepo = new DeploymentRepository(),
  unitup = new UnitupAdapter(),
): Promise<string> {
  const projects = targetProject
    ? [projRepo.getProject(targetProject)].filter(Boolean)
    : projRepo.getAllProjects();

  const daemonActive = await isDaemonRunning();
  const dbSize = getDatabaseSize();
  const activeDeployments = depRepo.getActiveDeployments(targetProject);
  const stats = depRepo.getStats(targetProject);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);
  const load = os.loadavg()[0].toFixed(2);

  const lines: string[] = [];

  // Header Banner
  lines.push(
    chalk.cyan.bold('╔═══════════════════════════════════════════════════════════════════════╗'),
  );
  lines.push(
    chalk.cyan.bold('║') +
      chalk.bold('                    DEPLOYRA LIVE STATUS DASHBOARD                     ') +
      chalk.cyan.bold('║'),
  );
  lines.push(
    chalk.cyan.bold('╚═══════════════════════════════════════════════════════════════════════╝'),
  );

  // System & Daemon Stats Summary
  const daemonBadge = daemonActive
    ? chalk.bgGreen.black(' ACTIVE ')
    : chalk.bgRed.white(' STOPPED ');
  lines.push(
    ` ${chalk.bold('Daemon:')} ${daemonBadge}  │  ${chalk.bold('System Load:')} ${chalk.yellow(load)}  │  ${chalk.bold('RAM:')} ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPercent}%)  │  ${chalk.bold('DB:')} ${chalk.magenta(formatBytes(dbSize))}`,
  );
  lines.push(
    ` ${chalk.bold('Deployments:')} Total: ${chalk.bold(stats.total)} │ Success: ${chalk.green(stats.success)} │ Failed: ${chalk.red(stats.failed)} │ Running: ${chalk.yellow(stats.running)} │ Queued: ${chalk.blue(stats.queued)}`,
  );
  lines.push(chalk.gray('─'.repeat(73)));

  if (projects.length === 0) {
    lines.push(chalk.yellow('\n  No registered projects found.\n'));
    return lines.join('\n');
  }

  // Projects Overview Table
  const table = new Table({
    head: [
      chalk.cyan('Project'),
      chalk.cyan('Env / Branch'),
      chalk.cyan('Service Status'),
      chalk.cyan('Latest Dep'),
      chalk.cyan('Status'),
      chalk.cyan('Target SHA'),
      chalk.cyan('Date'),
    ],
  });

  for (const p of projects) {
    const latest = depRepo.getLatestDeployment(p!.name);
    const branchLabel = `${p!.remote}/${p!.branch}`;
    const envLabel = p!.config?.environment ? `[${p!.config.environment}] ` : '';

    let serviceStateStr = chalk.gray('n/a');
    let projectGenerations: any[] = [];
    if (p!.config?.deploy?.service?.name && p!.config?.deploy?.service?.action !== 'none') {
      try {
        const svcStatus = await unitup.status(p!.config.deploy.service.name);
        projectGenerations = svcStatus.generations || [];
        if (svcStatus.active) {
          const activeGen = projectGenerations.find((g) => g.status === 'active');
          const canaryGen = projectGenerations.find((g) => g.status === 'canary');
          if (canaryGen) {
            const rawWeight = canaryGen.canaryWeight || 0.1;
            const pct = Math.round(rawWeight > 1 ? rawWeight : rawWeight * 100);
            serviceStateStr =
              chalk.green('● active') +
              chalk.magenta(` (v${activeGen?.id || '?'}+${pct}% canary v${canaryGen.id})`);
          } else if (activeGen) {
            serviceStateStr = chalk.green(`● active (v${activeGen.id})`);
          } else {
            serviceStateStr = chalk.green(`● active`);
          }
        } else {
          serviceStateStr = chalk.red(`○ ${svcStatus.subState || 'inactive'}`);
        }
      } catch {
        serviceStateStr = chalk.gray('unmanaged');
      }
    }

    if (latest) {
      const colorFn = getStatusColor(latest.status);
      table.push([
        chalk.bold(p!.name),
        `${envLabel}${branchLabel}`,
        serviceStateStr,
        `#${latest.id}`,
        colorFn(latest.status),
        latest.targetSha.substring(0, 7),
        new Date(latest.createdAt).toLocaleTimeString(),
      ]);
    } else {
      table.push([
        chalk.bold(p!.name),
        `${envLabel}${branchLabel}`,
        serviceStateStr,
        chalk.gray('none'),
        chalk.gray('no deployments'),
        '-',
        '-',
      ]);
    }
  }

  lines.push(table.toString());

  // Zero-Downtime Generations Section (if available)
  const zdProjects = projects.filter(
    (p) =>
      p!.config?.deploy?.strategy === 'zero-downtime' ||
      p!.config?.deploy?.zeroDowntime ||
      p!.config?.deploy?.service?.zeroDowntime,
  );
  for (const p of zdProjects) {
    try {
      const svcName = p!.config.deploy.service.name;
      const svcStatus = await unitup.status(svcName);
      if (svcStatus.generations && svcStatus.generations.length > 0) {
        lines.push('');
        lines.push(
          chalk.cyan.bold(
            `🚀 Zero-Downtime Generations for '${p!.name}' (Service: ${svcName}, Port: ${p!.config.deploy.port || p!.config.deploy.service.port || 'n/a'}):`,
          ),
        );
        for (const gen of svcStatus.generations) {
          const statusBadge =
            gen.status === 'active'
              ? chalk.green.bold(' ACTIVE ')
              : gen.status === 'canary'
                ? chalk.magenta.bold(
                    ` CANARY (${Math.round((gen.canaryWeight || 0.1) > 1 ? gen.canaryWeight! : gen.canaryWeight! * 100)}%) `,
                  )
                : chalk.gray(` ${gen.status} `);
          lines.push(
            `  • Generation #${gen.id} [${statusBadge}] PID: ${chalk.yellow(String(gen.pid))} │ Port: :${chalk.yellow(String(gen.internalPort))} │ Created: ${new Date(gen.createdAt).toLocaleTimeString()}`,
          );
        }
      }
    } catch {
      // ignore
    }
  }

  // Active / Running Deployments Section
  if (activeDeployments.length > 0) {
    lines.push('');
    lines.push(chalk.yellow.bold(`⚡ Active Pipelines in Progress (${activeDeployments.length}):`));
    for (const dep of activeDeployments) {
      const activeStep = dep.steps.find((s) => s.status === 'running')?.stepName || 'initializing';
      lines.push(
        `  • ${chalk.bold(dep.projectName)} (#${dep.id}) ➔ Step: ${chalk.cyan(activeStep)} (target SHA: ${dep.targetSha.substring(0, 7)}) [${dep.status}]`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

export async function statusCommand(
  projectName?: string,
  options: StatusCommandOptions = {},
): Promise<void> {
  const targetProject = resolveProjectName(projectName);
  const isWatch = Boolean(options.watch);

  try {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const unitup = new UnitupAdapter();

    if (!isWatch) {
      const output = await renderDashboard(targetProject, projRepo, depRepo, unitup);
      console.log(output);
      return;
    }

    // Live Watch Mode
    const intervalMs =
      typeof options.interval === 'number'
        ? options.interval
        : typeof options.interval === 'string'
          ? Number.parseInt(options.interval, 10)
          : 1500;

    let isRunning = true;

    const cleanup = () => {
      isRunning = false;
      closeDatabase();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    while (isRunning) {
      process.stdout.write('\x1Bc'); // Clear screen
      const output = await renderDashboard(targetProject, projRepo, depRepo, unitup);
      process.stdout.write(output);
      process.stdout.write(chalk.gray(`\n  Press Ctrl+C to exit dashboard...\n`));

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          clearTimeout(timer);
          resolve();
        }, intervalMs);
      });
    }
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to fetch status: ${err.message}`));
    process.exit(1);
  } finally {
    closeDatabase();
  }
}
