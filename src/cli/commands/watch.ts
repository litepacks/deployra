import chalk from 'chalk';
import { resolveProjectName } from '../../config/parser.js';
import { DeployraDaemon } from '../../daemon.js';

export async function watchCommand(targetProjectName?: string): Promise<void> {
  const resolvedTarget = resolveProjectName(targetProjectName);
  try {
    const daemon = new DeployraDaemon();
    await daemon.start(resolvedTarget);
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to start Deployra daemon: ${err.message}`));
    process.exit(1);
  }
}
