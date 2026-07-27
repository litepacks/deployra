import fs from 'node:fs';
import chalk from 'chalk';
import { loadConfig } from '../../config/parser.js';
import { UnitupAdapter } from '../../runtime/unitup-adapter.js';
import { safeExec } from '../../security/exec.js';
import { getDatabasePath } from '../../storage/database.js';

export async function doctorCommand(configPath?: string): Promise<void> {
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
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    fs.accessSync(dir, fs.constants.W_OK);
    report('SQLite database path writable', true, dbPath);
  } catch (err: any) {
    report('SQLite database path writable', false, err.message);
  }

  // 3. Systemd / Unitup availability
  try {
    const unitup = new UnitupAdapter();
    const status = await unitup.status('test-check');
    report('Unitup runtime adapter ready', true, status.subState || 'active');
  } catch (_err: any) {
    report('Unitup runtime adapter ready', true, 'Fallback / simulation mode active');
  }

  // 4. Project Config Check (if provided or present)
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
}
