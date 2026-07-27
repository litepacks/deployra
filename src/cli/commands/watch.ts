import chalk from 'chalk';
import { DeployraDaemon } from '../../daemon.js';

export async function watchCommand(targetProjectName?: string): Promise<void> {
  try {
    const daemon = new DeployraDaemon();
    await daemon.start(targetProjectName);
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to start Deployra daemon: ${err.message}`));
    process.exit(1);
  }
}
