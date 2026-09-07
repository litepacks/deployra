import chalk from 'chalk';
import { DeployraDaemon } from '../../daemon.js';

export async function watchCommand(
  targetProjectName?: string,
  options?: {
    dryRun?: boolean;
    concurrency?: string | number;
    webhookPort?: string | number;
  },
): Promise<void> {
  const target = targetProjectName?.trim() || undefined;
  const isDryRun = Boolean(options?.dryRun);
  const concurrency = options?.concurrency
    ? Number.parseInt(String(options.concurrency), 10)
    : undefined;
  const webhookPort = options?.webhookPort
    ? Number.parseInt(String(options.webhookPort), 10)
    : undefined;
  try {
    const daemon = new DeployraDaemon({ concurrency, webhookPort });
    await daemon.start(target, isDryRun);
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to start Deployra daemon: ${err.message}`));
    process.exit(1);
  }
}
