import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { UnitupAdapter } from '../../runtime/unitup-adapter.js';
import { safeExec } from '../../security/exec.js';

export function getCurrentVersion(): string {
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
    // Fallback
  }
  return '0.0.8';
}

export async function fetchLatestVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      'https://registry.npmjs.org/deployra/latest',
      {
        headers: { 'User-Agent': 'deployra-cli-updater' },
        timeout: 10000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`NPM Registry HTTP status ${res.statusCode}`));
        }
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json.version);
          } catch (e: any) {
            reject(new Error(`Failed to parse npm registry response: ${e.message}`));
          }
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('NPM Registry connection timeout'));
    });
  });
}

function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

export async function upgradeCommand(
  options: { check?: boolean; force?: boolean } = {},
): Promise<void> {
  const current = getCurrentVersion();
  console.log(chalk.cyan(`🔍 Checking latest Deployra version on npm... (current: v${current})`));

  let latest = '';
  try {
    latest = await fetchLatestVersion();
  } catch (err: any) {
    console.error(chalk.red(`✖ Failed to check npm registry: ${err.message}`));
    return;
  }

  const comparison = compareVersions(latest, current);

  if (comparison <= 0 && !options.force) {
    console.log(chalk.green(`✔ Deployra is already up to date! (v${current})`));
    return;
  }

  if (comparison > 0) {
    console.log(chalk.bold.yellow(`🚀 New version available: v${current} → v${latest}`));
  } else if (options.force) {
    console.log(chalk.yellow(`⚡ Force reinstalling Deployra v${latest}...`));
  }

  if (options.check) {
    console.log(chalk.gray('Run `deployra upgrade` without --check to perform the update.'));
    return;
  }

  console.log(chalk.blue(`📦 Installing deployra@${latest} globally via npm...`));

  try {
    const res = await safeExec('npm', ['install', '-g', `deployra@${latest}`], {
      timeoutMs: 120000,
    });

    if (res.exitCode !== 0) {
      console.error(chalk.red(`✖ Upgrade failed with exit code ${res.exitCode}: ${res.stderr}`));
      return;
    }

    console.log(chalk.green(`✔ Successfully upgraded Deployra to v${latest}!`));

    // Automatically restart daemon service if active
    const adapter = new UnitupAdapter();
    const serviceName = 'deployra-daemon';
    try {
      const statusRes = await adapter.status(serviceName);
      if (statusRes.active) {
        console.log(chalk.blue(`🔄 Restarting active systemd service '${serviceName}'...`));
        await adapter.restart(serviceName);
        console.log(chalk.green(`✔ Systemd service '${serviceName}' restarted successfully.`));
      }
    } catch {
      // Service not installed or inactive
    }
  } catch (err: any) {
    console.error(chalk.red(`✖ Upgrade command error: ${err.message}`));
  }
}
