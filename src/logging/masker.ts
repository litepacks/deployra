const SECRET_PATTERNS = [
  /bearer\s+[a-zA-Z0-9_\-\.\~]+(?:\:[a-zA-Z0-9_\-\.\~]+)?/gi,
  /password\s*[:=]\s*["']?[^"'\s\n,]+["']?/gi,
  /secret\s*[:=]\s*["']?[^"'\s\n,]+["']?/gi,
  /token\s*[:=]\s*["']?[^"'\s\n,]+["']?/gi,
  /api[_-]?key\s*[:=]\s*["']?[^"'\s\n,]+["']?/gi,
  /-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /glpat-[a-zA-Z0-9\-]{20,}/g,
  /https?:\/\/([^:]+):([^@]+)@/g, // URLs with user:password
];

export function maskSecrets(input: string): string {
  if (!input) return input;
  let masked = input;

  // Mask basic patterns
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
