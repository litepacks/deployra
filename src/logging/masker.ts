import { redact, standardRules } from '@visulima/redact';

const COMBINED_SECRET_PATTERN =
  /(?:bearer\s+[a-zA-Z0-9_\-.~]+(?::[a-zA-Z0-9_\-.~]+)?)|(?:(?:password|secret|token|api[_-]?key)\s*[:=]\s*["']?[^"'\s\n,]+["']?)|(?:-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----)|(?:ghp_[a-zA-Z0-9]{36,})|(?:glpat-[a-zA-Z0-9-]{20,})|(?:https?:\/\/[^:]+:[^@]+@)/gi;

const dynamicSecrets = new Set<string>();
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let cachedDynamicRegex: RegExp | null = null;

function updateDynamicRegex(): void {
  if (dynamicSecrets.size === 0) {
    cachedDynamicRegex = null;
    return;
  }
  const sorted = Array.from(dynamicSecrets).sort((a, b) => b.length - a.length);
  const pattern = sorted.map(escapeRegex).join('|');
  cachedDynamicRegex = new RegExp(pattern, 'g');
}

export function registerSecret(secret: string): void {
  if (secret && typeof secret === 'string' && secret.trim().length >= 4) {
    dynamicSecrets.add(secret.trim());
    updateDynamicRegex();
  }
}

export function registerSecrets(secrets: string[] | Record<string, string>): void {
  let changed = false;
  if (Array.isArray(secrets)) {
    for (const s of secrets) {
      if (s && typeof s === 'string' && s.trim().length >= 4) {
        dynamicSecrets.add(s.trim());
        changed = true;
      }
    }
  } else if (secrets && typeof secrets === 'object') {
    for (const val of Object.values(secrets)) {
      if (val && typeof val === 'string' && val.trim().length >= 4) {
        dynamicSecrets.add(val.trim());
        changed = true;
      }
    }
  }
  if (changed) {
    updateDynamicRegex();
  }
}

export function clearRegisteredSecrets(): void {
  dynamicSecrets.clear();
  cachedDynamicRegex = null;
}

export function maskSecrets(input: string): string {
  if (!input || typeof input !== 'string') return input;
  let masked = input;

  // 1. Mask registered dynamic secrets in a single pass via compiled regex
  if (cachedDynamicRegex) {
    masked = masked.replace(cachedDynamicRegex, '[REDACTED]');
  }

  // 2. Mask credential patterns in a single combined pass
  masked = masked.replace(COMBINED_SECRET_PATTERN, (match) => {
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

  return masked;
}

export function redactObject<T extends Record<string, unknown>>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  return redact(obj, standardRules) as T;
}
