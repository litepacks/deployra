import { computeConfigHash } from '../src/config/parser.js';
import { normalizeAndValidateConfig } from '../src/config/schema.js';

function createSampleConfig(i: number) {
  return {
    project: {
      name: `api-service-${i % 10}`,
      path: `/var/www/api-${i % 10}`,
    },
    source: {
      remote: 'origin',
      branch: 'main',
    },
    watch: {
      interval: '30s',
    },
    deploy: {
      strategy: 'zero-downtime' as const,
      port: 8080 + (i % 10),
      drainTimeout: '15s',
      canary: {
        enabled: true,
        weight: '10%',
      },
      concurrency: 1,
      queueMode: 'latest' as const,
      timeout: '10m',
      retry: {
        attempts: 2,
        backoff: '5s',
      },
      commands: {
        install: ['npm ci'],
        build: ['npm run build', 'npm run test:fast'],
      },
      service: {
        name: `api-service-${i % 10}`,
        action: 'restart' as const,
        command: 'node dist/server.js',
      },
      ready: {
        url: `http://127.0.0.1:${8080 + (i % 10)}/health`,
        timeout: '30s',
        interval: '1s',
      },
      rollback: {
        enabled: true,
      },
    },
  };
}

function runBenchmark() {
  const count = 3000;
  console.log(`[Config Benchmark] Running ${count} validations & hash computations...`);

  const start = performance.now();
  let hashSum = 0;

  for (let i = 0; i < count; i++) {
    const raw = createSampleConfig(i);
    const normalized = normalizeAndValidateConfig(raw);
    const hash = computeConfigHash(normalized);
    hashSum += hash.length;
  }

  const duration = performance.now() - start;
  console.log(
    `[Config Benchmark] Completed in ${duration.toFixed(2)}ms (Total hash length: ${hashSum})`,
  );
}

runBenchmark();
