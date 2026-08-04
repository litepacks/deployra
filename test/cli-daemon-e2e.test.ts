import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { safeExec } from '../src/security/exec.js';
import { closeDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { BROKEN_SERVER_CODE_SNIPPET } from './fixtures/broken-server.js';
import { createSampleServer, startSampleServer } from './fixtures/sample-server.js';

function getCLICommand(): { command: string; argsPrefix: string[] } {
  const distCli = path.resolve('./dist/cli/index.js');
  if (fs.existsSync(distCli)) {
    return { command: process.execPath, argsPrefix: [distCli] };
  }
  const tsxBin = path.resolve('./node_modules/.bin/tsx');
  const srcCli = path.resolve('./src/cli/index.ts');
  return { command: tsxBin, argsPrefix: [srcCli] };
}

describe('Deployra Real CLI Daemon & App Integration E2E Test', () => {
  let tmpDir: string;
  let remoteRepoPath: string;
  let workDir: string;
  let targetPath: string;

  beforeEach(async () => {
    closeDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-cli-e2e-'));
    process.env.DEPLOYRA_DB_PATH = path.join(tmpDir, 'deployra.db');
    process.env.WORKMATIC_DB_PATH = path.join(tmpDir, 'workmatic.db');

    remoteRepoPath = path.join(tmpDir, 'remote.git');
    workDir = path.join(tmpDir, 'work');
    targetPath = path.join(tmpDir, 'target');

    fs.mkdirSync(remoteRepoPath, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(targetPath, { recursive: true });

    // Initialize bare remote repo
    await safeExec('git', ['init', '--bare'], { cwd: remoteRepoPath });

    // Initialize working repo
    await safeExec('git', ['init'], { cwd: workDir });
    await safeExec('git', ['checkout', '-b', 'main'], { cwd: workDir });
    await safeExec('git', ['config', 'user.name', 'Deployra Real Test'], { cwd: workDir });
    await safeExec('git', ['config', 'user.email', 'test@deployra.local'], { cwd: workDir });
    await safeExec('git', ['remote', 'add', 'origin', remoteRepoPath], { cwd: workDir });

    fs.writeFileSync(path.join(workDir, 'build.sh'), 'echo "Build OK"');
    await safeExec('git', ['add', '.'], { cwd: workDir });
    await safeExec('git', ['commit', '-m', 'Initial commit'], { cwd: workDir });
    await safeExec('git', ['push', 'origin', 'HEAD:main'], { cwd: workDir });
  });

  it('runs real daemon process, registers app via CLI, and auto-deploys git commit update', async () => {
    const { command, argsPrefix } = getCLICommand();

    // 1. Start live sample Node.js HTTP server fixture on dynamic port
    const fixtureServer = await startSampleServer('v1.0.0');

    // 2. Create .deployra.json config inside workDir
    const configPath = path.join(workDir, '.deployra.json');
    const configContent = JSON.stringify(
      {
        project: {
          name: 'real-cli-app',
          path: workDir,
        },
        source: {
          remote: 'origin',
          branch: 'main',
        },
        watch: {
          intervalMs: 1000,
        },
        deploy: {
          strategy: 'in-place',
          commands: {
            install: ['echo "Installing..."'],
            build: ['echo "Building..."'],
          },
          service: {
            name: 'real-cli-app',
            action: 'none',
          },
          ready: {
            url: `${fixtureServer.url}/health`,
            timeout: '5s',
            interval: '500ms',
          },
        },
      },
      null,
      2,
    );
    fs.writeFileSync(configPath, configContent);

    // 3. Spawn real Deployra watch daemon as a background child process
    const daemonProcess = spawn(command, [...argsPrefix, 'watch'], {
      env: {
        ...process.env,
        DEPLOYRA_DB_PATH: path.join(tmpDir, 'deployra.db'),
        WORKMATIC_DB_PATH: path.join(tmpDir, 'workmatic.db'),
      },
      stdio: 'pipe',
    });

    let daemonLogs = '';
    daemonProcess.stdout.on('data', (d) => {
      daemonLogs += d.toString();
    });
    daemonProcess.stderr.on('data', (d) => {
      daemonLogs += d.toString();
    });

    // Wait 1.5 seconds for daemon startup
    await new Promise((r) => setTimeout(r, 1500));

    try {
      // 4. Run `deployra add .` via CLI to register the app in SQLite DB
      const addRes = await safeExec(command, [...argsPrefix, 'add', '.'], {
        cwd: workDir,
        env: {
          ...process.env,
          DEPLOYRA_DB_PATH: path.join(tmpDir, 'deployra.db'),
          WORKMATIC_DB_PATH: path.join(tmpDir, 'workmatic.db'),
        },
      });
      expect(addRes.stdout).toContain('Added project');

      // 5. Commit & Push v2.0.0 code update to remote Git repository
      fs.writeFileSync(path.join(workDir, 'server.js'), 'const version = "v2.0.0";');
      await safeExec('git', ['add', '.'], { cwd: workDir });
      await safeExec('git', ['commit', '-m', 'Release real cli app v2.0.0'], { cwd: workDir });
      await safeExec('git', ['push', 'origin', 'HEAD:main'], { cwd: workDir });

      // Update fixture server version
      fixtureServer.setVersion('v2.0.0');

      // 6. Trigger manual deployment via `deployra deploy real-cli-app`
      const deployRes = await safeExec(command, [...argsPrefix, 'deploy', 'real-cli-app'], {
        env: {
          ...process.env,
          DEPLOYRA_DB_PATH: path.join(tmpDir, 'deployra.db'),
          WORKMATIC_DB_PATH: path.join(tmpDir, 'workmatic.db'),
        },
      });
      expect(deployRes.stdout).toContain('Triggering manual deployment');

      // 7. Poll SQLite database until status becomes success
      const depRepo = new DeploymentRepository();
      let finalStatus = '';
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const deps = depRepo.getDeploymentsByProject('real-cli-app');
        const latest = deps[0];
        if (latest && (latest.status === 'success' || latest.status === 'failed')) {
          finalStatus = latest.status;
          break;
        }
      }

      if (finalStatus !== 'success') {
        console.error('DAEMON LOGS ON FAILURE:\n', daemonLogs);
      }
      expect(finalStatus).toBe('success');

      // Verify deployed target files
      const targetServerJs = fs.readFileSync(path.join(workDir, 'server.js'), 'utf-8');
      expect(targetServerJs).toContain('v2.0.0');
    } finally {
      daemonProcess.kill('SIGTERM');
      await fixtureServer.close();
    }
  }, 45000);

  it('does not crash daemon when build command fails on broken server code update and recovers on next valid commit', async () => {
    const { command, argsPrefix } = getCLICommand();

    // 1. Start live sample Node.js HTTP server fixture on dynamic port
    const fixtureServer = await startSampleServer('v1.0.0');

    // 2. Create .deployra.json config inside workDir with build script command
    const configPath = path.join(workDir, '.deployra.json');
    const configContent = JSON.stringify(
      {
        project: {
          name: 'broken-code-app',
          path: workDir,
        },
        source: {
          remote: 'origin',
          branch: 'main',
        },
        watch: {
          intervalMs: 1000,
        },
        deploy: {
          strategy: 'in-place',
          retry: {
            attempts: 0,
            backoff: '100ms',
          },
          commands: {
            install: ['echo "Installing..."'],
            build: ['sh build.sh'],
          },
          service: {
            name: 'broken-code-app',
            action: 'none',
          },
          ready: {
            url: `${fixtureServer.url}/health`,
            timeout: '5s',
            interval: '500ms',
          },
        },
      },
      null,
      2,
    );
    fs.writeFileSync(configPath, configContent);

    // 3. Spawn real Deployra watch daemon as background child process
    const daemonProcess = spawn(command, [...argsPrefix, 'watch'], {
      env: {
        ...process.env,
        DEPLOYRA_DB_PATH: path.join(tmpDir, 'deployra.db'),
        WORKMATIC_DB_PATH: path.join(tmpDir, 'workmatic.db'),
      },
      stdio: 'pipe',
    });

    let daemonLogs = '';
    daemonProcess.stdout.on('data', (d) => {
      daemonLogs += d.toString();
    });
    daemonProcess.stderr.on('data', (d) => {
      daemonLogs += d.toString();
    });

    await new Promise((r) => setTimeout(r, 1500));

    try {
      // 4. Add project via CLI
      await safeExec(command, [...argsPrefix, 'add', '.'], {
        cwd: workDir,
        env: {
          ...process.env,
          DEPLOYRA_DB_PATH: path.join(tmpDir, 'deployra.db'),
          WORKMATIC_DB_PATH: path.join(tmpDir, 'workmatic.db'),
        },
      });

      // 5. Push BROKEN server code snippet (build.sh contains syntax error & exit 1)
      fs.writeFileSync(path.join(workDir, 'server.js'), BROKEN_SERVER_CODE_SNIPPET);
      fs.writeFileSync(
        path.join(workDir, 'build.sh'),
        'echo "Syntax Error in Server Code" && exit 1',
      );
      await safeExec('git', ['add', '.'], { cwd: workDir });
      await safeExec('git', ['commit', '-m', 'Broken server code commit'], { cwd: workDir });
      await safeExec('git', ['push', 'origin', 'HEAD:main'], { cwd: workDir });

      // 6. Trigger manual deployment for broken code
      await safeExec(command, [...argsPrefix, 'deploy', 'broken-code-app'], {
        env: {
          ...process.env,
          DEPLOYRA_DB_PATH: path.join(tmpDir, 'deployra.db'),
          WORKMATIC_DB_PATH: path.join(tmpDir, 'workmatic.db'),
        },
      });

      // 7. Poll database for failed/rolled_back status
      const depRepo = new DeploymentRepository();
      let failedStatus = '';
      let failedDep: any = null;
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const deps = depRepo.getDeploymentsByProject('broken-code-app');
        failedDep = deps.find((d) => d.status === 'failed' || d.status === 'rolled_back');
        if (failedDep) {
          failedStatus = failedDep.status;
          break;
        }
      }

      if (!failedStatus) {
        console.error('DAEMON LOGS ON BROKEN CODE FAILURE:\n', daemonLogs);
      }
      expect(['failed', 'rolled_back']).toContain(failedStatus);

      // 8. VERIFY DAEMON IS STILL ALIVE & RUNNING (has not crashed)
      expect(daemonProcess.exitCode).toBeNull();
      expect(daemonProcess.killed).toBe(false);

      // 9. Fix broken server code, commit & push valid update
      await safeExec('git', ['checkout', '-B', 'main'], { cwd: workDir });
      fs.writeFileSync(path.join(workDir, 'server.js'), 'const version = "v2.0.0-fixed";');
      fs.writeFileSync(path.join(workDir, 'build.sh'), 'echo "Fixed Build OK"');
      await safeExec('git', ['add', '.'], { cwd: workDir });
      await safeExec('git', ['commit', '-m', 'Fix broken server code'], { cwd: workDir });
      await safeExec('git', ['push', '--force', 'origin', 'main'], { cwd: workDir });

      // 10. Trigger deployment again
      await safeExec(command, [...argsPrefix, 'deploy', 'broken-code-app'], {
        env: {
          ...process.env,
          DEPLOYRA_DB_PATH: path.join(tmpDir, 'deployra.db'),
          WORKMATIC_DB_PATH: path.join(tmpDir, 'workmatic.db'),
        },
      });

      // 11. Poll database for success status
      let recoveredStatus = '';
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const deps = depRepo.getDeploymentsByProject('broken-code-app');
        const successDep = deps.find(
          (d) => d.targetSha !== failedDep?.targetSha && d.status === 'success',
        );
        if (successDep) {
          recoveredStatus = successDep.status;
          break;
        }
      }

      if (recoveredStatus !== 'success') {
        console.error('DAEMON LOGS ON RECOVERY FAILURE:\n', daemonLogs);
      }
      expect(recoveredStatus).toBe('success');

      // 12. Verify daemon is still running
      expect(daemonProcess.exitCode).toBeNull();
    } finally {
      daemonProcess.kill('SIGTERM');
      await fixtureServer.close();
    }
  }, 90000);
});
