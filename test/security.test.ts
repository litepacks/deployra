import { maskSecrets, redactObject } from '../src/logging/masker.js';
import { assertSafePath } from '../src/security/path-validator.js';

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
});
