import { parseCommandString, UnitupAdapter } from '../src/runtime/unitup-adapter.js';

async function runBenchmark() {
  const adapter = new UnitupAdapter();

  const ITERATIONS = 10_000;
  const commands = [
    'node dist/index.js --port 3000 --production',
    'npm start',
    'python3 app.py --workers 4',
    'sh -c "bundle exec rails server"',
    'gunicorn -w 4 -b 127.0.0.1:8000 wsgi:application',
    'echo "hello world"',
    'node "app with spaces/server.js" --arg',
  ];

  const start = performance.now();

  // 1. Benchmark command parsing
  for (let i = 0; i < ITERATIONS; i++) {
    const cmd = commands[i % commands.length];
    parseCommandString(cmd);
  }

  // 2. Benchmark status and generation queries
  for (let i = 0; i < 500; i++) {
    await adapter.status('my-service');
  }

  const elapsed = performance.now() - start;
  console.log(`[Unitup Benchmark] Completed in ${elapsed.toFixed(2)}ms`);
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
