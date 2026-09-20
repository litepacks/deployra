import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { DeploymentPipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';
import { StateRepository } from '../src/storage/state-repository.js';

async function runBenchmark() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-pipeline-bench-'));
  process.env.DEPLOYRA_DB_PATH = path.join(tempDir, 'test.db');
  process.env.WORKMATIC_DB_PATH = path.join(tempDir, 'workmatic.db');
  resetDatabase();

  const projRepo = new ProjectRepository();
  const depRepo = new DeploymentRepository();
  const stateRepo = new StateRepository();
  const runner = new DeploymentPipelineRunner();

  const projDir = path.join(tempDir, 'app');
  fs.mkdirSync(projDir, { recursive: true });

  const config = normalizeAndValidateConfig({
    project: { name: 'bench-app', path: projDir },
    source: { remote: 'origin', branch: 'main' },
    deploy: {
      strategy: 'in-place',
      commands: {
        build: ['echo "building"'],
      },
    },
  });
  projRepo.saveProject(config);

  const ITERATIONS = 100;

  // 1. Benchmark lock acquire & release (Step 2: Prepared statement caching)
  const lockStart = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const lockId = `dep_lock_${i}`;
    stateRepo.acquireLock('bench-app', lockId);
    stateRepo.isLocked('bench-app');
    stateRepo.releaseLock('bench-app', lockId);
  }
  const lockDuration = performance.now() - lockStart;

  // 2. Benchmark pipeline step execution & cancellation checks (Step 1 & Step 6)
  const pipeStart = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const depId = `dep_pipe_${i}`;
    depRepo.createDeployment({
      id: depId,
      projectName: 'bench-app',
      targetSha: `sha_${i}`,
      status: 'queued',
      triggerType: 'manual',
    });

    // Run simulated dry-run deployment through runner
    await runner.runDeployment({
      deploymentId: depId,
      projectName: 'bench-app',
      targetSha: `sha_${i}`,
      triggerType: 'manual',
      dryRun: true,
      triggeredAt: Date.now(),
    });
  }
  const pipeDuration = performance.now() - pipeStart;

  // 3. Benchmark query checks: hasActiveDeployments, getActiveDeploymentSummaries, countRecentFailures (Steps 4, 5, 6)
  const queryStart = performance.now();
  for (let i = 0; i < 500; i++) {
    depRepo.hasActiveDeployments('bench-app');
    depRepo.getActiveDeploymentSummaries('bench-app');
    depRepo.countRecentFailures('bench-app', 'sha_50', 10);
  }
  const queryDuration = performance.now() - queryStart;

  // 4. Benchmark config file mtime stat check vs parsing (Step 4)
  const cfgFile = path.join(projDir, 'deployra.config.yaml');
  fs.writeFileSync(cfgFile, 'project:\n  name: bench-app\nsource:\n  remote: origin\n');
  const mtimeStart = performance.now();
  let _mtimeCount = 0;
  let lastMtime = 0;
  for (let i = 0; i < 1000; i++) {
    const stat = fs.statSync(cfgFile);
    if (stat.mtimeMs !== lastMtime) {
      lastMtime = stat.mtimeMs;
      _mtimeCount++;
    }
  }
  const mtimeDuration = performance.now() - mtimeStart;

  const totalDuration = lockDuration + pipeDuration + queryDuration + mtimeDuration;
  console.log(`=== Deployra Performance Benchmark Suite ===`);
  console.log(`1. Lock acquire/release (100 iters): ${lockDuration.toFixed(2)}ms`);
  console.log(`2. Pipeline runner execution (100 iters): ${pipeDuration.toFixed(2)}ms`);
  console.log(`3. Active query & failures checks (500 iters): ${queryDuration.toFixed(2)}ms`);
  console.log(`4. Config mtime check (1000 iters): ${mtimeDuration.toFixed(2)}ms`);
  console.log(`Total duration: ${totalDuration.toFixed(2)}ms`);

  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
