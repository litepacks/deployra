import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { removeService, unitFileExists } from 'unitup';
import { safeExec } from '../../security/exec.js';
import { closeDatabase } from '../../storage/database.js';

export async function uninstallCommand(
  options: { purge?: boolean; keepData?: boolean; global?: boolean } = {},
): Promise<void> {
  console.log(chalk.bold.yellow('\n🗑  Uninstalling Deployra...\n'));

  // 1. Close database connections
  try {
    closeDatabase();
  } catch {
    // Ignore if not open
  }

  // 2. Remove systemd background service if installed
  const serviceName = 'deployra-daemon';
  try {
    if (unitFileExists(serviceName)) {
      await removeService(serviceName);
      console.log(chalk.green(`✔ Stopped and removed systemd service '${serviceName}'.`));
    } else {
      console.log(chalk.gray(`• Systemd service '${serviceName}' is not installed.`));
    }
  } catch (err: any) {
    console.log(chalk.gray(`• Systemd service check: ${err.message}`));
  }

  // 3. Purge data directory (~/.deployra) unless keepData is explicitly specified
  const homeDir = os.homedir() || process.env.HOME || '/tmp';
  const dataDir = path.join(homeDir, '.deployra');

  if (!options.keepData && fs.existsSync(dataDir)) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      console.log(chalk.green(`✔ Removed Deployra data directory (${dataDir}).`));
    } catch (err: any) {
      console.error(chalk.red(`✖ Failed to remove data directory '${dataDir}': ${err.message}`));
    }
  } else if (options.keepData) {
    console.log(chalk.gray(`• Preserved Deployra data directory (${dataDir}).`));
  }

  // 4. Uninstall global npm package if requested or default
  if (options.global !== false) {
    console.log(chalk.blue('📦 Uninstalling deployra globally via npm...'));
    try {
      const res = await safeExec('npm', ['uninstall', '-g', 'deployra'], { timeoutMs: 60000 });
      if (res.exitCode === 0) {
        console.log(chalk.green("✔ Successfully uninstalled global package 'deployra'."));
      } else {
        console.log(
          chalk.yellow(`• Note: Global npm package uninstall output: ${res.stdout || res.stderr}`),
        );
      }
    } catch (err: any) {
      console.log(chalk.yellow(`• Note: Global npm uninstall error: ${err.message}`));
    }
  }

  console.log(chalk.bold.green('\n✔ Deployra has been completely uninstalled.\n'));
}
