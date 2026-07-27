import chalk from 'chalk';
import { createService, removeService } from 'unitup';
import { UnitupAdapter } from '../../runtime/unitup-adapter.js';

export async function serviceCommand(
  action: 'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall',
): Promise<void> {
  const adapter = new UnitupAdapter();
  const serviceName = 'deployra-daemon';

  try {
    switch (action) {
      case 'install': {
        const binPath = process.argv[1] || 'deployra';
        await createService({
          name: serviceName,
          command: `${binPath} watch`,
          cwd: process.cwd(),
        });
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
    }
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to execute service action '${action}': ${err.message}`));
  }
}
