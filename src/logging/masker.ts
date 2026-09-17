import { redact, standardRules } from '@visulima/redact';

const SECRET_PATTERNS = [
  /bearer\s+[a-zA-Z0-9_\-.~]+(?::[a-zA-Z0-9_\-.~]+)?/gi,
  /password\s*[:=]\s*["']?[^"'\s\n,]+["']?/gi,
  /secret\s*[:=]\s*["']?[^"'\s\n,]+["']?/gi,
  /token\s*[:=]\s*["']?[^"'\s\n,]+["']?/gi,
  /api[_-]?key\s*[:=]\s*["']?[^"'\s\n,]+["']?/gi,
  /-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /glpat-[a-zA-Z0-9-]{20,}/g,
  /https?:\/\/([^:]+):([^@]+)@/g, // URLs with user:password
];

const dynamicSecrets = new Set<string>();

export function registerSecret(secret: string): void {
  if (secret && typeof secret === 'string' && secret.trim().length >= 4) {
    dynamicSecrets.add(secret.trim());
  }
}

export function registerSecrets(secrets: string[] | Record<string, string>): void {
  if (Array.isArray(secrets)) {
    for (const s of secrets) {
      registerSecret(s);
    }
  } else if (secrets && typeof secrets === 'object') {
    for (const val of Object.values(secrets)) {
      if (typeof val === 'string') {
        registerSecret(val);
      }
    }
  }
}

export function clearRegisteredSecrets(): void {
  dynamicSecrets.clear();
}

export function maskSecrets(input: string): string {
  if (!input) return input;
  let masked = input;

  // Mask registered dynamic secrets (values from .env or config.env)
  for (const secret of dynamicSecrets) {
    if (masked.includes(secret)) {
      masked = masked.split(secret).join('[REDACTED]');
    }
  }

  // Mask specific credential patterns
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      if (match.startsWith('http://') || match.startsWith('https://')) {
        return match.replace(/:\/\/([^:]+):([^@]+)@/, '://***:***@');
      }
      if (match.includes('PRIVATE KEY')) {
        return '[REDACTED PRIVATE KEY]';
      }
      const parts = match.split(/[:=]/);
      if (parts.length > 1) {
        return `${parts[0]}: [REDACTED]`;
      }
      return '[REDACTED SECRET]';
    });
  }

  return masked;
}

export function redactObject<T extends Record<string, unknown>>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  return redact(obj, standardRules) as T;
}
