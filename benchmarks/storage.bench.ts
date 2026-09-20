import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';

function runBenchmark() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-storage-bench-'));
  process.env.DEPLOYRA_DB_PATH = path.join(tmpDir, 'bench.db');
  resetDatabase();

  const repo = new DeploymentRepository();
  const projRepo = new ProjectRepository();
  for (let p = 0; p < 5; p++) {
    projRepo.saveProject({
      project: { name: `app-${p}`, path: `/tmp/app-${p}` },
      source: { remote: 'origin', branch: 'main' },
      watch: { intervalMs: 30000 },
      deploy: {
        strategy: 'in-place',
        concurrency: 1,
        queueMode: 'latest',
        dirtyWorkspace: 'reject',
        timeoutMs: 600000,
        retry: { attempts: 2, backoffMs: 10000 },
        preflight: { diskCheck: true },
        service: { name: `app-${p}`, action: 'restart' },
        commands: {},
        ready: { checks: [], timeoutMs: 45000, intervalMs: 2000, mode: 'all' },
        rollback: { enabled: true, on: ['build-failure', 'service-failure', 'ready-failure'] },
      },
    });
  }
  const count = 100;

  console.log(
    `[Storage Benchmark] Creating & updating ${count} deployments (8 steps each = ${count * 16} step updates)...`,
  );
  const start = performance.now();

  for (let i = 0; i < count; i++) {
    const dep = repo.createDeployment({
      projectName: `app-${i % 5}`,
      targetSha: `sha_${i}`,
      triggerType: 'manual',
      steps: ['validate', 'fetch', 'prepare', 'build', 'service', 'ready', 'cleanup', 'finish'],
    });

    repo.updateStatus(dep.id, 'running');

    for (const step of [
      'validate',
      'fetch',
      'prepare',
      'build',
      'service',
      'ready',
      'cleanup',
      'finish',
    ]) {
      repo.updateStep(dep.id, step, {
        status: 'running',
        startedAt: Date.now(),
      });
      repo.updateStep(dep.id, step, {
        status: 'success',
        completedAt: Date.now(),
        duration: 10,
        exitCode: 0,
        output: 'step completed ok',
      });
    }

    repo.updateStatus(dep.id, 'success');
  }

  const duration = performance.now() - start;
  console.log(`[Storage Benchmark] Completed ${count} full pipelines in ${duration.toFixed(2)}ms`);

  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

runBenchmark();
