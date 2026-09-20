import crypto from 'node:crypto';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { WebhookServer } from '../src/server/webhook-server.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { ProjectRepository } from '../src/storage/project-repository.js';
import type { SourceWatcher } from '../src/watcher/source-watcher.js';

async function runBenchmark() {
  process.env.DEPLOYRA_DB_PATH = ':memory:';
  resetDatabase();

  const secret = 'super-secret-benchmark-key-12345';
  const projectRepo = new ProjectRepository();
  projectRepo.saveProject(
    normalizeAndValidateConfig({
      project: { name: 'bench-app', path: '/tmp/bench-app' },
      source: { remote: 'origin', branch: 'main' },
      webhook: { enabled: true, secret },
    }),
  );

  let checkProjectCalls = 0;
  const mockWatcher = {
    checkProject: async () => {
      checkProjectCalls++;
      return `dep_bench_${checkProjectCalls}`;
    },
  } as unknown as SourceWatcher;

  const server = new WebhookServer({ port: 0, sourceWatcher: mockWatcher });
  const port = await server.start();

  const payloadObj = {
    ref: 'refs/heads/main',
    after: 'a1b2c3d4e5f6789012345678901234567890abcd',
    repository: { name: 'bench-app' },
    commits: [
      { id: 'a1b2c3d4e5f6789012345678901234567890abcd', message: 'feat: optimize performance' },
    ],
  };
  const rawPayload = JSON.stringify(payloadObj);
  const validHmac = crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');

  const REQUEST_COUNT = 500;
  const start = performance.now();

  for (let i = 0; i < REQUEST_COUNT; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/webhook/bench-app`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${validHmac}`,
      },
      body: rawPayload,
    });
    if (res.status !== 202) {
      throw new Error(`Expected 202, got ${res.status}`);
    }
    await res.json();
  }

  const elapsed = performance.now() - start;
  console.log(
    `[Webhook Benchmark] Processed ${REQUEST_COUNT} requests in ${elapsed.toFixed(2)}ms (${(elapsed / REQUEST_COUNT).toFixed(3)}ms/req)`,
  );

  await server.stop();
  closeDatabase();
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
