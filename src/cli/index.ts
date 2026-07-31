import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { addCommand } from './commands/add.js';
import { cancelCommand } from './commands/cancel.js';
import { checkCommand } from './commands/check.js';
import { deployCommand } from './commands/deploy.js';
import { doctorCommand } from './commands/doctor.js';
import { historyCommand } from './commands/history.js';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import { logsCommand } from './commands/logs.js';
import { removeCommand } from './commands/remove.js';
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
  return '0.0.8';
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
  .action(async (configPath) => {
    await addCommand(configPath);
  });

program
  .command('remove [projectName]')
  .description('Remove a project from Deployra registry')
  .action((projectName) => {
    removeCommand(projectName);
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
  .action(async (projectName) => {
    await watchCommand(projectName);
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
  .action(async (projectName) => {
    await deployCommand(projectName);
  });

program
  .command('cancel [target]')
  .description('Cancel an active or queued deployment')
  .action((target) => {
    cancelCommand(target);
  });

program
  .command('status [projectName]')
  .description('Display status summary for projects')
  .action((projectName) => {
    statusCommand(projectName);
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
  .action((projectName, options) => {
    logsCommand(projectName, options);
  });

program
  .command('history [projectName]')
  .description('View deployment history for a project')
  .option('-l, --limit <number>', 'Number of past deployments to show', '10')
  .action((projectName, options) => {
    historyCommand(projectName, parseInt(options.limit, 10));
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
  .action(async (options) => {
    await uninstallCommand(options);
  });

program.parse(process.argv);
