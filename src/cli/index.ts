import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { addCommand } from './commands/add.js';
import { cancelCommand } from './commands/cancel.js';
import { checkCommand } from './commands/check.js';
import { cleanCommand } from './commands/clean.js';
import { deployCommand } from './commands/deploy.js';
import { doctorCommand } from './commands/doctor.js';
import { historyCommand } from './commands/history.js';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import { logsCommand } from './commands/logs.js';
import { notifyTestCommand } from './commands/notify-test.js';
import { promoteCommand } from './commands/promote.js';
import { removeCommand } from './commands/remove.js';
import { rollbackCommand } from './commands/rollback.js';
import { serviceCommand } from './commands/service.js';
import { statsCommand } from './commands/stats.js';
import { statusCommand } from './commands/status.js';
import { uninstallCommand } from './commands/uninstall.js';
import { upgradeCommand } from './commands/upgrade.js';
import { watchCommand } from './commands/watch.js';

function getVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    let dir = path.dirname(__filename);

    for (let i = 0; i < 5; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'deployra' && pkg.version) {
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fallback if filesystem read fails
  }
  return '0.3.0';
}

const program = new Command();

program
  .name('deployra')
  .description('Lightweight, platform-independent VPS deployment orchestrator')
  .version(getVersion());

program
  .command('init [path]')
  .description('Initialize a sample deployra.config.yaml file')
  .action((path) => {
    initCommand(path);
  });

program
  .command('add [configPath]')
  .description('Register a new project configuration')
  .option('-e, --env <name>', 'Environment profile to apply (e.g. staging, production)')
  .action(async (configPath, options) => {
    await addCommand(configPath, options);
  });

program
  .command('remove [projectName]')
  .description('Remove a project from Deployra registry and stop associated systemd service')
  .action(async (projectName) => {
    await removeCommand(projectName);
  });

program
  .command('list')
  .alias('ls')
  .description('List all registered projects')
  .action(() => {
    listCommand();
  });

program
  .command('watch [projectName]')
  .description('Start long-running deployment watcher daemon')
  .option('-d, --dry-run', 'Run daemon in simulation mode without executing real commands')
  .option(
    '-c, --concurrency <number>',
    'Maximum number of concurrent project deployments (default: 4)',
  )
  .option(
    '-p, --webhook-port <number>',
    'Port to listen on for incoming Git webhooks (default: 3939)',
  )
  .action(async (projectName, options) => {
    await watchCommand(projectName, options);
  });

program
  .command('check [projectName]')
  .description('Perform a one-shot remote repository check')
  .action(async (projectName) => {
    await checkCommand(projectName);
  });

program
  .command('deploy [projectName]')
  .description('Trigger a manual deployment for a project')
  .option('-e, --env <name>', 'Environment profile to deploy (e.g. staging, production)')
  .option(
    '-d, --dry-run',
    'Simulate deployment pipeline without executing shell or service commands',
  )
  .option(
    '-i, --inline',
    'Run deployment pipeline directly in the current process (ideal for CI/CD or testing)',
  )
  .option('--canary', 'Deploy as canary generation without replacing active generation')
  .option('--weight <number>', 'Canary traffic percentage or decimal (e.g. 10% or 0.1)')
  .action(async (projectName, options) => {
    await deployCommand(projectName, options);
  });

program
  .command('promote [projectName]')
  .description('Promote active canary generation to 100% primary traffic')
  .action(async (projectName) => {
    await promoteCommand(projectName);
  });

program
  .command('rollback [projectName]')
  .description('Interactive or targeted rollback to a previous successful deployment')
  .option('-t, --to <deploymentId>', 'Specific deployment ID or target SHA to rollback to')
  .action(async (projectName, options) => {
    await rollbackCommand(projectName, options);
  });

program
  .command('cancel [target]')
  .description('Cancel an active or queued deployment')
  .action((target) => {
    cancelCommand(target);
  });

program
  .command('status [projectName]')
  .description('Display status summary or live TUI dashboard for projects')
  .option('-w, --watch', 'Live updating dashboard mode')
  .option('-i, --interval <number>', 'Refresh interval in milliseconds (default: 1500)')
  .action(async (projectName, options) => {
    await statusCommand(projectName, options);
  });

program
  .command('stats [projectName]')
  .description('Display deployment metrics and statistics')
  .action((projectName) => {
    statsCommand(projectName);
  });

program
  .command('logs [projectName]')
  .description('View deployment logs')
  .option('-f, --follow', 'Follow log stream')
  .option('-d, --deployment <id>', 'Deployment ID')
  .option('-s, --step <name>', 'Filter logs for a specific step')
  .option('--format <type>', 'Output format (pretty | json | jsonl)', 'pretty')
  .action(async (projectName, options) => {
    await logsCommand(projectName, options);
  });

program
  .command('history [projectName]')
  .description('View deployment history for a project')
  .option('-l, --limit <number>', 'Number of past deployments to show', '10')
  .action((projectName, options) => {
    historyCommand(projectName, parseInt(options.limit, 10));
  });

program
  .command('clean [projectName]')
  .alias('prune')
  .description('Clean up old deployment history and optimize database with retention policy')
  .option('-k, --keep <number>', 'Number of recent deployments to retain per project', '50')
  .option('-d, --days <number>', 'Prune deployments older than specified number of days')
  .option('--no-vacuum', 'Skip SQLite VACUUM optimization')
  .action(async (projectName, options) => {
    await cleanCommand(projectName, options);
  });

program
  .command('notify-test [projectName]')
  .description('Send a test alert to verify configured notification channels')
  .action(async (projectName) => {
    await notifyTestCommand(projectName);
  });

program
  .command('doctor [configPath]')
  .description('Run system diagnostic checks')
  .action(async (configPath) => {
    await doctorCommand(configPath);
  });

program
  .command('service [action]')
  .description(
    'Manage Deployra daemon systemd service (install | start | stop | restart | status | uninstall)',
  )
  .action(async (action) => {
    await serviceCommand(action as any);
  });

program
  .command('upgrade')
  .description('Check and upgrade Deployra CLI to the latest version')
  .option('-c, --check', 'Check for updates without installing')
  .option('-f, --force', 'Force reinstall of the latest version')
  .action(async (options) => {
    await upgradeCommand(options);
  });

program
  .command('uninstall')
  .description('Completely uninstall Deployra, systemd daemon service, and data directory')
  .option('-k, --keep-data', 'Preserve Deployra database and configuration directory (~/.deployra)')
  .option('-p, --purge', 'Purge Deployra database and configuration directory (~/.deployra)')
  .option('-g, --global', 'Uninstall global npm package')
  .action(async (options) => {
    await uninstallCommand(options);
  });

program.parse(process.argv);
