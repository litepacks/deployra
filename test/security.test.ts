import { describe, expect, it } from 'vitest';
import { maskSecrets } from '../src/logging/masker.js';
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

  it('validates safe paths and blocks path traversal attempts', () => {
    const safe = assertSafePath('/var/www/app/src', '/var/www/app');
    expect(safe).toBe('/var/www/app/src');

    expect(() => assertSafePath('/var/www/other', '/var/www/app')).toThrow();
  });
});
