import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getUnitupDir } from 'unitup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appLogsCommand } from '../src/cli/commands/app-logs.js';
import { logsCommand } from '../src/cli/commands/logs.js';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { clearRegisteredSecrets } from '../src/logging/masker.js';
import { UnitupAdapter } from '../src/runtime/unitup-adapter.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { ProjectRepository } from '../src/storage/project-repository.js';

describe('Application & Service Logs (deployra app-logs / deployra logs --app)', () => {
  let tmpDir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-applogs-test-'));
    process.env.DEPLOYRA_DB_PATH = path.join(tmpDir, 'deployra.db');
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir;
    clearRegisteredSecrets();
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
    clearRegisteredSecrets();
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    vi.restoreAllMocks();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('retrieves stdout and stderr logs via UnitupAdapter.logs with filtering and line limits', async () => {
    const adapter = new UnitupAdapter();
    const serviceName = 'test-Order-Service';
    const [stdoutPath, stderrPath] = adapter.getServiceLogPaths(serviceName);

    fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
    fs.writeFileSync(
      stdoutPath,
      `${[
        '[INFO] Server listening on :3000',
        '[INFO] Processed order #101',
        '[INFO] Processed order #102',
      ].join('\n')}\n`,
    );
    fs.writeFileSync(stderrPath, '[ERROR] Database connection timeout on replica-2\n');

    // All logs
    const allLogs = await adapter.logs(serviceName, { lines: 10 });
    expect(typeof allLogs).toBe('string');
    expect(allLogs).toContain('Server listening on :3000');
    expect(allLogs).toContain('Database connection timeout on replica-2');

    // Only stdout
    const stdoutOnly = await adapter.logs(serviceName, { stdout: true });
    expect(stdoutOnly).toContain('Processed order #102');
    expect(stdoutOnly).not.toContain('Database connection timeout');

    // Only stderr
    const stderrOnly = await adapter.logs(serviceName, { stderr: true });
    expect(stderrOnly).toContain('Database connection timeout');
    expect(stderrOnly).not.toContain('Processed order #101');

    // Grep filter
    const filtered = await adapter.logs(serviceName, { grep: 'order #102' });
    expect(filtered).toContain('Processed order #102');
    expect(filtered).not.toContain('Processed order #101');

    // Line limit
    const tailOne = await adapter.logs(serviceName, { stdout: true, lines: 1 });
    expect(tailOne?.toString().trim()).toBe('[INFO] Processed order #102');
  });

  it('resolves project service.name from registry and masks configured secrets in appLogsCommand', async () => {
    const projRepo = new ProjectRepository();
    const config = normalizeAndValidateConfig({
      project: {
        name: 'billing-project',
        path: tmpDir,
      },
      deploy: {
        env: {
          STRIPE_API_KEY: 'sk_live_super_secret_token_999',
        },
        service: {
          name: 'billing-worker-svc',
          command: 'node worker.js',
        },
      },
    });
    projRepo.saveProject(config);

    const logsDir = path.join(getUnitupDir(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'billing-worker-svc.log'),
      'Initializing Stripe client with key sk_live_super_secret_token_999\nWorker ready!\n',
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await appLogsCommand('billing-project', { lines: 50 });

    const combinedOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combinedOutput).toContain('billing-worker-svc');
    expect(combinedOutput).toContain('Worker ready!');
    expect(combinedOutput).not.toContain('sk_live_super_secret_token_999');
  });

  it('supports --json and --cat output modes in appLogsCommand', async () => {
    const logsDir = path.join(getUnitupDir(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'json-svc.log'), 'Line A\nLine B\n');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await appLogsCommand('json-svc', { json: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([{ message: 'Line A' }, { message: 'Line B' }]);

    logSpy.mockClear();
    await appLogsCommand('json-svc', { cat: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toBe('Line A\nLine B');
  });

  it('delegates deployra logs <project> --app to appLogsCommand', async () => {
    const logsDir = path.join(getUnitupDir(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'delegated-app.log'), 'Hello from Unitup runtime!\n');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await logsCommand('delegated-app', { app: true, lines: 20 });

    const combinedOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combinedOutput).toContain('Hello from Unitup runtime!');
  });
});
