import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeExec } from '../src/security/exec.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { createSampleServer } from './fixtures/sample-server.js';

describe('Deployra Real CLI Daemon & App Integration E2E Test', () => {
  let tmpDir: string;
  let remoteRepoPath: string;
  let workDir: string;
  let targetPath: string;
  const cliPath = path.resolve('./dist/cli/index.js');

  beforeEach(async () => {
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
    // 1. Start live sample Node.js HTTP server fixture on port 3995
    const fixtureServer = createSampleServer('v1.0.0', 3995);
    await new Promise<void>((resolve) => fixtureServer.server.listen(3995, '127.0.0.1', resolve));

    // 2. Create .deployra.json config inside workDir
    const configPath = path.join(workDir, '.deployra.json');
    const configContent = JSON.stringify(
      {
        project: {
          name: 'real-cli-app',
          path: targetPath,
        },
        source: {
          remote: 'origin',
          branch: 'main',
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
    const daemonProcess = spawn(process.execPath, [cliPath, 'watch'], {
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

    // Wait 1 second for daemon startup
    await new Promise((r) => setTimeout(r, 1000));

    try {
      // 4. Run `deployra add .` via CLI to register the app in SQLite DB
      const addRes = await safeExec(process.execPath, [cliPath, 'add', '.'], {
        cwd: workDir,
        env: {
          ...process.env,
          DEPLOYRA_DB_PATH: path.join(tmpDir, 'deployra.db'),
          WORKMATIC_DB_PATH: path.join(tmpDir, 'workmatic.db'),
        },
      });
      expect(addRes.stdout).toContain('Registered project');

      // 5. Commit & Push v2.0.0 code update to remote Git repository
      fs.writeFileSync(path.join(workDir, 'server.js'), 'const version = "v2.0.0";');
      await safeExec('git', ['add', '.'], { cwd: workDir });
      await safeExec('git', ['commit', '-m', 'Release real cli app v2.0.0'], { cwd: workDir });
      await safeExec('git', ['push', 'origin', 'HEAD:main'], { cwd: workDir });

      // Update fixture server version
      fixtureServer.setVersion('v2.0.0');

      // 6. Trigger manual deployment via `deployra deploy real-cli-app`
      const deployRes = await safeExec(process.execPath, [cliPath, 'deploy', 'real-cli-app'], {
        env: {
          ...process.env,
          DEPLOYRA_DB_PATH: path.join(tmpDir, 'deployra.db'),
          WORKMATIC_DB_PATH: path.join(tmpDir, 'workmatic.db'),
        },
      });
      expect(deployRes.stdout).toContain('Manual deployment queued');

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

      expect(finalStatus).toBe('success');

      // Verify deployed target files
      const targetServerJs = fs.readFileSync(path.join(targetPath, 'server.js'), 'utf-8');
      expect(targetServerJs).toContain('v2.0.0');
    } finally {
      daemonProcess.kill('SIGTERM');
      await fixtureServer.close();
    }
  }, 45000);
});
