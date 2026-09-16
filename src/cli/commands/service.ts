import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import Table from 'cli-table3';
import { createService, removeService } from 'unitup';
import { UnitupAdapter } from '../../runtime/unitup-adapter.js';
import { safeExec } from '../../security/exec.js';

export function printServiceHelp(): void {
  console.log(chalk.bold('\n⚙  Deployra Daemon Service Management\n'));
  console.log(`${chalk.yellow('Usage:')} deployra service <action>\n`);

  const table = new Table({
    head: [chalk.cyan('Action'), chalk.cyan('Description')],
  });

  table.push(
    [
      chalk.bold('install'),
      'Install systemd background service for Deployra daemon & enable boot auto-start',
    ],
    [chalk.bold('start'), 'Start the Deployra daemon background service'],
    [chalk.bold('stop'), 'Stop the Deployra daemon background service'],
    [chalk.bold('restart'), 'Restart the Deployra daemon background service'],
    [
      chalk.bold('status'),
      'Display active status, PID, lingering, and health of Deployra daemon service',
    ],
    [chalk.bold('uninstall'), 'Remove the Deployra daemon background service from systemd'],
  );

  console.log(table.toString());
  console.log(`\n${chalk.yellow('Examples:')}`);
  console.log(
    `  $ ${chalk.green('deployra service install')}   # Install systemd service with boot autostart`,
  );
  console.log(`  $ ${chalk.green('deployra service start')}     # Start daemon service`);
  console.log(`  $ ${chalk.green('deployra service status')}    # View service status & lingering`);
  console.log(`  $ ${chalk.green('deployra service restart')}   # Restart daemon service\n`);
}

async function tryEnableLinger(): Promise<{ enabled: boolean; note?: string }> {
  if (process.platform !== 'linux') {
    return { enabled: true, note: 'Non-Linux platform (simulated / native)' };
  }

  const currentUser = process.env.USER || process.env.LOGNAME;
  if (!currentUser) {
    return { enabled: false, note: 'Could not determine current username' };
  }

  try {
    const check = await safeExec('loginctl', ['show-user', currentUser, '--property=Linger']);
    if (check.stdout.includes('Linger=yes')) {
      return { enabled: true, note: 'Linger is already active' };
    }

    await safeExec('loginctl', ['enable-linger', currentUser]);
    return { enabled: true, note: 'Enabled loginctl user lingering' };
  } catch (err: any) {
    return {
      enabled: false,
      note: `Run 'sudo loginctl enable-linger ${currentUser}' to allow daemon to start on reboot without login. (${err.message})`,
    };
  }
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
            restart: 'always',
            force: true,
          });
        } else {
          await createService({
            name: serviceName,
            command: 'deployra',
            args: ['watch'],
            cwd: process.cwd(),
            restart: 'always',
            force: true,
          });
        }
        console.log(
          chalk.green(`✔ Installed systemd service '${serviceName}' via Unitup (Restart=always).`),
        );

        // Enable user lingering on Linux so service starts automatically on system reboot without SSH login
        const lingerResult = await tryEnableLinger();
        if (lingerResult.enabled) {
          console.log(
            chalk.green(
              `✔ Boot Auto-Start: Systemd user lingering is enabled (service starts on reboot and stays running 24/7).`,
            ),
          );
        } else {
          console.log(chalk.yellow(`⚠ Boot Auto-Start Note: ${lingerResult.note}`));
        }
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
        if (res.mainPid) {
          console.log(chalk.gray(`  PID: ${res.mainPid}`));
        }

        if (process.platform === 'linux') {
          const lingerCheck = await tryEnableLinger();
          console.log(
            chalk.bold(`Boot Autostart (Linger): `) +
              (lingerCheck.enabled
                ? chalk.green('Enabled')
                : chalk.yellow('Disabled / Needs setup')) +
              chalk.gray(` (${lingerCheck.note})`),
          );
        }
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
