import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { doctorCommand } from '../src/cli/commands/doctor.js';
import { serviceCommand } from '../src/cli/commands/service.js';
import { maskSecrets, redactObject } from '../src/logging/masker.js';
import { assertNonRootUser, assertSafePath } from '../src/security/path-validator.js';

describe('Security & Masker Tests', () => {
  it('masks secret tokens, passwords, and private keys in logs', () => {
    const rawLog = 'Connecting with Bearer secret_token_12345 and password="super_secret_pass"';
    const masked = maskSecrets(rawLog);

    expect(masked).not.toContain('secret_token_12345');
    expect(masked).not.toContain('super_secret_pass');
    expect(masked).toContain('[REDACTED]');
  });

  it('masks private keys', () => {
    const key = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----`;
    const masked = maskSecrets(key);
    expect(masked).toBe('[REDACTED PRIVATE KEY]');
  });

  it('preserves valid file paths, project names, and git URLs without replacing them with <URL>', () => {
    const log = 'Command npm ci failed in /var/www/my-store-app for git@github.com:org/repo.git';
    const masked = maskSecrets(log);
    expect(masked).toContain('/var/www/my-store-app');
    expect(masked).toContain('git@github.com:org/repo.git');
    expect(masked).not.toContain('<URL>');
    expect(masked).not.toContain('<URL1>');
  });

  it('redacts secret properties from structured objects using @visulima/redact', () => {
    const data = {
      user: 'admin',
      password: 'super_secret_password',
      token: 'bearer_token_123',
    };
    const redacted = redactObject(data);
    expect(redacted.user).toBe('admin');
    expect(redacted.password).not.toBe('super_secret_password');
    expect(redacted.token).not.toBe('bearer_token_123');
  });

  it('validates safe paths and blocks path traversal attempts', () => {
    const safe = assertSafePath('/var/www/app/src', '/var/www/app');
    expect(safe).toBe('/var/www/app/src');

    expect(() => assertSafePath('/var/www/other', '/var/www/app')).toThrow();
  });

  describe('Root User Diagnostics & Safety Checks', () => {
    const originalGetuid = process.getuid;
    const originalAllowRoot = process.env.DEPLOYRA_ALLOW_ROOT;
    const originalDbPath = process.env.DEPLOYRA_DB_PATH;
    const originalXdgConfig = process.env.XDG_CONFIG_HOME;

    beforeEach(() => {
      process.env.DEPLOYRA_DB_PATH = ':memory:';
    });

    afterEach(() => {
      process.getuid = originalGetuid;
      if (originalAllowRoot === undefined) {
        delete process.env.DEPLOYRA_ALLOW_ROOT;
      } else {
        process.env.DEPLOYRA_ALLOW_ROOT = originalAllowRoot;
      }
      if (originalDbPath === undefined) {
        delete process.env.DEPLOYRA_DB_PATH;
      } else {
        process.env.DEPLOYRA_DB_PATH = originalDbPath;
      }
      if (originalXdgConfig === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdgConfig;
      }
      vi.restoreAllMocks();
    });

    it('assertNonRootUser throws when uid is 0 without DEPLOYRA_ALLOW_ROOT', () => {
      if (process.platform === 'win32') return;
      process.getuid = vi.fn().mockReturnValue(0);
      delete process.env.DEPLOYRA_ALLOW_ROOT;

      expect(() => assertNonRootUser()).toThrow(
        /Running Deployra directly as root is discouraged for security reasons/,
      );

      // Overriding with DEPLOYRA_ALLOW_ROOT=true should not throw
      process.env.DEPLOYRA_ALLOW_ROOT = 'true';
      expect(() => assertNonRootUser()).not.toThrow();
    });

    it('doctorCommand reports failure when running as root without DEPLOYRA_ALLOW_ROOT', async () => {
      if (process.platform === 'win32') return;
      process.getuid = vi.fn().mockReturnValue(0);
      delete process.env.DEPLOYRA_ALLOW_ROOT;

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await doctorCommand();
      expect(result.failed).toBeGreaterThanOrEqual(1);

      const logs = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logs).toContain('Running directly as root without DEPLOYRA_ALLOW_ROOT=true');
    });

    it('doctorCommand reports success when running as root with DEPLOYRA_ALLOW_ROOT=true', async () => {
      if (process.platform === 'win32') return;
      process.getuid = vi.fn().mockReturnValue(0);
      process.env.DEPLOYRA_ALLOW_ROOT = 'true';

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await doctorCommand();

      const logs = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logs).toContain('Running as root (DEPLOYRA_ALLOW_ROOT=true override active)');
    });

    it('doctorCommand checks systemd daemon service unit root configuration', async () => {
      if (process.platform === 'win32') return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-doc-test-'));
      process.env.XDG_CONFIG_HOME = tmpDir;

      const userDir = path.join(tmpDir, 'systemd', 'user');
      fs.mkdirSync(userDir, { recursive: true });
      const unitPath = path.join(userDir, 'unitup-deployra-daemon.service');

      // 1. Service unit missing DEPLOYRA_ALLOW_ROOT=true while root
      fs.writeFileSync(unitPath, '[Service]\nExecStart=/usr/bin/deployra watch\n');
      process.getuid = vi.fn().mockReturnValue(0);
      delete process.env.DEPLOYRA_ALLOW_ROOT;

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const resMissing = await doctorCommand();
      expect(resMissing.failed).toBeGreaterThanOrEqual(1);

      let logs = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logs).toContain('missing Environment="DEPLOYRA_ALLOW_ROOT=true"');

      // 2. Service unit contains DEPLOYRA_ALLOW_ROOT=true
      consoleSpy.mockClear();
      fs.writeFileSync(
        unitPath,
        '[Service]\nEnvironment="DEPLOYRA_ALLOW_ROOT=true"\nExecStart=/usr/bin/deployra watch\n',
      );
      process.env.DEPLOYRA_ALLOW_ROOT = 'true';
      await doctorCommand();

      logs = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logs).toContain('DEPLOYRA_ALLOW_ROOT=true is configured in service unit');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('serviceCommand install automatically injects DEPLOYRA_ALLOW_ROOT=true when running as root', async () => {
      if (process.platform === 'win32') return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-install-test-'));
      process.env.XDG_CONFIG_HOME = tmpDir;

      process.getuid = vi.fn().mockReturnValue(0);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await serviceCommand('install');

      const userDir = path.join(tmpDir, 'systemd', 'user');
      const unitPath = path.join(userDir, 'unitup-deployra-daemon.service');
      expect(fs.existsSync(unitPath)).toBe(true);

      const content = fs.readFileSync(unitPath, 'utf8');
      expect(content).toMatch(/DEPLOYRA_ALLOW_ROOT=["']?true["']?/);

      const logs = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logs).toContain('Root User Detected: Configured DEPLOYRA_ALLOW_ROOT=true');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
