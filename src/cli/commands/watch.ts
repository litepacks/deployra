import chalk from 'chalk';
import { DeployraDaemon } from '../../daemon.js';

export async function watchCommand(
  targetProjectName?: string,
  options?: { dryRun?: boolean },
): Promise<void> {
  const target = targetProjectName?.trim() || undefined;
  const isDryRun = Boolean(options?.dryRun);
  try {
    const daemon = new DeployraDaemon();
    await daemon.start(target, isDryRun);
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to start Deployra daemon: ${err.message}`));
    process.exit(1);
  }
}
