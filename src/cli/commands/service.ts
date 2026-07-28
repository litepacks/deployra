import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import Table from 'cli-table3';
import { createService, removeService } from 'unitup';
import { UnitupAdapter } from '../../runtime/unitup-adapter.js';

export function printServiceHelp(): void {
  console.log(chalk.bold('\n⚙  Deployra Daemon Service Management\n'));
  console.log(`${chalk.yellow('Usage:')} deployra service <action>\n`);

  const table = new Table({
    head: [chalk.cyan('Action'), chalk.cyan('Description')],
  });

  table.push(
    [chalk.bold('install'), 'Install systemd background service for Deployra daemon'],
    [chalk.bold('start'), 'Start the Deployra daemon background service'],
    [chalk.bold('stop'), 'Stop the Deployra daemon background service'],
    [chalk.bold('restart'), 'Restart the Deployra daemon background service'],
    [chalk.bold('status'), 'Display active status, PID, and health of Deployra daemon service'],
    [chalk.bold('uninstall'), 'Remove the Deployra daemon background service from systemd'],
  );

  console.log(table.toString());
  console.log(`\n${chalk.yellow('Examples:')}`);
  console.log(`  $ ${chalk.green('deployra service install')}   # Install systemd service`);
  console.log(`  $ ${chalk.green('deployra service start')}     # Start daemon service`);
  console.log(`  $ ${chalk.green('deployra service status')}    # View service status`);
  console.log(`  $ ${chalk.green('deployra service restart')}   # Restart daemon service\n`);
}

export async function serviceCommand(
  action?: 'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall',
): Promise<void> {
  if (!action) {
    printServiceHelp();
    return;
  }

  const adapter = new UnitupAdapter();
  const serviceName = 'deployra-daemon';

  try {
    switch (action) {
      case 'install': {
        const rawScript = process.argv[1];
        const scriptPath =
          rawScript && fs.existsSync(rawScript) ? path.resolve(rawScript) : undefined;

        if (scriptPath) {
          await createService({
            name: serviceName,
            command: process.execPath,
            args: [scriptPath, 'watch'],
            cwd: process.cwd(),
            restartSec: '3s',
            force: true,
          });
        } else {
          await createService({
            name: serviceName,
            command: 'deployra',
            args: ['watch'],
            cwd: process.cwd(),
            restartSec: '3s',
            force: true,
          });
        }
        console.log(chalk.green(`✔ Installed systemd service '${serviceName}' via Unitup.`));
        break;
      }
      case 'start':
        await adapter.start(serviceName);
        console.log(chalk.green(`✔ Started systemd service '${serviceName}'.`));
        break;
      case 'stop':
        await adapter.stop(serviceName);
        console.log(chalk.green(`✔ Stopped systemd service '${serviceName}'.`));
        break;
      case 'restart':
        await adapter.restart(serviceName);
        console.log(chalk.green(`✔ Restarted systemd service '${serviceName}'.`));
        break;
      case 'status': {
        const res = await adapter.status(serviceName);
        console.log(
          chalk.bold(`Service '${serviceName}': `) +
            (res.active ? chalk.green('Active') : chalk.red('Inactive')) +
            chalk.gray(` (${res.subState || 'unknown'})`),
        );
        break;
      }
      case 'uninstall':
        await removeService(serviceName);
        console.log(chalk.green(`✔ Uninstalled systemd service '${serviceName}'.`));
        break;
      default:
        console.log(chalk.red(`✖ Invalid service action '${action}'`));
        printServiceHelp();
        break;
    }
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to execute service action '${action}': ${err.message}`));
  }
}
