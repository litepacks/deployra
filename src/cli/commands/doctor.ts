import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../../config/parser.js';
import { UnitupAdapter } from '../../runtime/unitup-adapter.js';
import { safeExec } from '../../security/exec.js';
import { isRootUser } from '../../security/path-validator.js';
import { getDatabasePath } from '../../storage/database.js';

export async function doctorCommand(
  configPath?: string,
): Promise<{ passed: number; failed: number }> {
  console.log(chalk.bold('\n🔍 Running Deployra System Diagnostics...\n'));

  let checksPassed = 0;
  let checksFailed = 0;

  function report(name: string, ok: boolean, detail?: string) {
    if (ok) {
      checksPassed++;
      console.log(
        `  ${chalk.green('✔')} ${chalk.bold(name)}${detail ? chalk.gray(` - ${detail}`) : ''}`,
      );
    } else {
      checksFailed++;
      console.log(
        `  ${chalk.red('✖')} ${chalk.bold(name)}${detail ? chalk.yellow(` - ${detail}`) : ''}`,
      );
    }
  }

  // 1. Git Installation
  try {
    const res = await safeExec('git', ['--version']);
    report('Git CLI installed', true, res.stdout.trim());
  } catch (err: any) {
    report('Git CLI installed', false, err.message);
  }

  // 2. SQLite Database Writable
  try {
    const dbPath = getDatabasePath();
    if (dbPath === ':memory:') {
      report('SQLite database path writable', true, ':memory: (in-memory mode)');
    } else {
      const dir = path.dirname(dbPath);
      fs.accessSync(dir, fs.constants.W_OK);
      report('SQLite database path writable', true, dbPath);
    }
  } catch (err: any) {
    report('SQLite database path writable', false, err.message);
  }

  // 3. Systemd / Unitup availability & Linux Linger
  try {
    const unitup = new UnitupAdapter();
    const status = await unitup.status('test-check');
    report('Unitup runtime adapter ready', true, status.subState || 'active');
  } catch (_err: any) {
    report('Unitup runtime adapter ready', true, 'Fallback / simulation mode active');
  }

  if (process.platform === 'linux') {
    try {
      const currentUser = process.env.USER || process.env.LOGNAME || '';
      const check = await safeExec('loginctl', ['show-user', currentUser, '--property=Linger']);
      if (check.stdout.includes('Linger=yes')) {
        report('Linux systemd user lingering active (survives reboot)', true, 'Linger=yes');
      } else {
        report(
          'Linux systemd user lingering active (survives reboot)',
          false,
          `Linger=no (Run 'sudo loginctl enable-linger ${currentUser}' to enable 24/7 background operation on boot)`,
        );
      }
    } catch (err: any) {
      report('Linux systemd user lingering check', false, err.message);
    }
  }

  // 4. Root Privilege & Execution Safety Check
  const rootActive = isRootUser();
  const allowRootEnv = process.env.DEPLOYRA_ALLOW_ROOT === 'true';

  if (!rootActive) {
    report('Process privilege safety', true, 'Running as non-root user (recommended)');
  } else if (allowRootEnv) {
    report(
      'Process privilege safety',
      true,
      'Running as root (DEPLOYRA_ALLOW_ROOT=true override active)',
    );
  } else {
    report(
      'Process privilege safety',
      false,
      'Running directly as root without DEPLOYRA_ALLOW_ROOT=true. Daemon will fail to start. Switch to a non-root user or export DEPLOYRA_ALLOW_ROOT=true',
    );
  }

  // 5. Systemd Daemon Service Configuration Check (Linux / User service)
  if (process.platform === 'linux' || process.env.NODE_ENV === 'test') {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const unitPath = path.join(configHome, 'systemd', 'user', 'unitup-deployra-daemon.service');
    if (fs.existsSync(unitPath)) {
      try {
        const unitContent = fs.readFileSync(unitPath, 'utf8');
        if (rootActive) {
          const hasAllowRootInUnit = /DEPLOYRA_ALLOW_ROOT=["']?true["']?/i.test(unitContent);
          if (hasAllowRootInUnit) {
            report(
              'Deployra daemon service root configuration',
              true,
              'DEPLOYRA_ALLOW_ROOT=true is configured in service unit',
            );
          } else {
            report(
              'Deployra daemon service root configuration',
              false,
              `Service '${unitPath}' is missing Environment="DEPLOYRA_ALLOW_ROOT=true". Service will fail on startup as root. Reinstall via 'deployra service install' or add Environment="DEPLOYRA_ALLOW_ROOT=true" to unit.`,
            );
          }
        } else {
          report('Deployra daemon service unit found', true, unitPath);
        }
      } catch (err: any) {
        report('Deployra daemon service check', false, err.message);
      }
    }
  }

  // 6. Project Config Check (if provided or present)
  try {
    const config = loadConfig(configPath);
    report(
      'Project config valid',
      true,
      `Project '${config.project.name}' at '${config.project.path}'`,
    );

    // Check project directory write permissions
    try {
      fs.accessSync(config.project.path, fs.constants.W_OK);
      report('Project directory writable', true, config.project.path);
    } catch {
      report('Project directory writable', false, `Cannot write to '${config.project.path}'`);
    }

    // Check Git remote connectivity
    try {
      await safeExec(
        'git',
        ['ls-remote', config.source.remote, `refs/heads/${config.source.branch}`],
        {
          cwd: config.project.path,
        },
      );
      report(
        'Remote repository accessible',
        true,
        `${config.source.remote}/${config.source.branch}`,
      );
    } catch (err: any) {
      report('Remote repository accessible', false, err.message);
    }
  } catch (err: any) {
    if (configPath) {
      report('Project config valid', false, err.message);
    }
  }

  console.log(
    `\n${chalk.bold('Summary:')} ${chalk.green(`${checksPassed} passed`)}, ${checksFailed > 0 ? chalk.red(`${checksFailed} failed`) : chalk.gray('0 failed')}\n`,
  );

  return { passed: checksPassed, failed: checksFailed };
}
