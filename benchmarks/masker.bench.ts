import { clearRegisteredSecrets, maskSecrets, registerSecrets } from '../src/logging/masker.js';

function setup() {
  clearRegisteredSecrets();
  registerSecrets({
    DB_PASSWORD: 'super_secret_db_password_12345!',
    API_TOKEN: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    GITLAB_TOKEN: 'glpat-abcdef1234567890wxyz',
    STRIPE_KEY: 'sk_live_51ABCDEF1234567890',
    AWS_SECRET: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    JWT_SECRET: 'jwt_signing_key_very_long_and_secret',
    SESSION_KEY: 'session_super_secret_cookie_token',
    REDIS_AUTH: 'redis_p@ssw0rd_complex!',
    SENTRY_DSN: 'https://user:pass1234@sentry.io/123456',
    SLACK_WEBHOOK: 'https://hooks.slack.com/services/T00/B00/X123456789',
  });
}

function generateLines(count: number): string[] {
  const templates = [
    'npm info using npm@10.8.2',
    'npm info using node@v20.18.0',
    'npm notice Beginning compilation of packages/core',
    'transforming src/index.ts (14 modules)',
    'node_modules/typescript/lib/tsc.js --emitDeclarationOnly',
    'export const config = { port: 3000, host: "127.0.0.1" };',
    'Connecting to database with password: super_secret_db_password_12345!',
    'Authorization: Bearer my_bearer_token_xyz.12345',
    'Authorization: Bearer secret_jwt_payload_here',
    'Cloning into https://git_user:glpat-abcdef1234567890wxyz@github.com/org/repo.git',
    'Fetched commit 7b8c9d0 from origin/main',
    'export API_KEY="sk_live_51ABCDEF1234567890"',
    'Build completed in 1.42s with 0 errors and 0 warnings',
    'Writing output bundle to dist/index.js (142.4 kB)',
    'Writing output bundle to dist/index.d.ts (24.1 kB)',
    'Health check probe sent to http://127.0.0.1:3000/health (status: 200 OK)',
    'Service api.service restarted via systemctl --user restart',
  ];

  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(templates[i % templates.length]!);
  }
  return lines;
}

function runBenchmark() {
  setup();
  const lines = generateLines(20000);
  const start = performance.now();
  let maskedCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const masked = maskSecrets(lines[i]!);
    if (masked.includes('[REDACTED]')) {
      maskedCount++;
    }
  }
  const duration = performance.now() - start;
  console.log(
    `[Masker Benchmark] Processed ${lines.length} lines in ${duration.toFixed(2)}ms (Redactions: ${maskedCount})`,
  );
}

runBenchmark();
