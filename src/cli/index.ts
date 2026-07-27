import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { addCommand } from './commands/add.js';
import { removeCommand } from './commands/remove.js';
import { listCommand } from './commands/list.js';
import { watchCommand } from './commands/watch.js';
import { checkCommand } from './commands/check.js';
import { deployCommand } from './commands/deploy.js';
import { cancelCommand } from './commands/cancel.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';
import { historyCommand } from './commands/history.js';
import { doctorCommand } from './commands/doctor.js';
import { serviceCommand } from './commands/service.js';
import { statsCommand } from './commands/stats.js';

const program = new Command();

program
  .name('gitship')
  .description('Lightweight, platform-independent VPS deployment orchestrator')
  .version('1.0.0');

program
  .command('init [path]')
  .description('Initialize a sample gitship.config.yaml file')
  .action((path) => {
    initCommand(path);
  });

program
  .command('add [configPath]')
  .description('Register a new project configuration')
  .action((configPath) => {
    addCommand(configPath);
  });

program
  .command('remove <projectName>')
  .description('Remove a project from Gitship registry')
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
  .command('deploy <projectName>')
  .description('Trigger a manual deployment for a project')
  .action(async (projectName) => {
    await deployCommand(projectName);
  });

program
  .command('cancel <target>')
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
  .command('history <projectName>')
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
  .command('service <action>')
  .description(
    'Manage Gitship daemon systemd service (install|start|stop|restart|status|uninstall)',
  )
  .action(async (action) => {
    await serviceCommand(action as any);
  });

program.parse(process.argv);
