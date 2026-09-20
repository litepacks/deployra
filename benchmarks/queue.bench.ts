import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { WorkmaticEngine } from '../src/jobs/workmatic-engine.js';
import type { DeploymentPipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';

async function runBenchmark() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-bench-queue-'));
  const deployraDbPath = path.join(tempDir, 'bench-deployra.db');
  const workmaticDbPath = path.join(tempDir, 'bench-workmatic.db');
  process.env.DEPLOYRA_DB_PATH = deployraDbPath;
  process.env.WORKMATIC_DB_PATH = workmaticDbPath;

  resetDatabase();
  const depRepo = new DeploymentRepository();
  const engine = new WorkmaticEngine({ concurrency: 4, dbPath: workmaticDbPath });

  const TOTAL_JOBS = 100;
  let completedCount = 0;
  let resolveDone: () => void;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const mockRunner = {
    runDeployment: async (payload: { deploymentId: string }) => {
      depRepo.updateStatus(payload.deploymentId, 'success');
      completedCount++;
      if (completedCount === TOTAL_JOBS) {
        resolveDone();
      }
    },
  } as unknown as DeploymentPipelineRunner;

  engine.setPipelineRunner(mockRunner);
  await engine.startWorker();

  const projectRepo = new ProjectRepository();
  const projectNames = ['project-a', 'project-b', 'project-c', 'project-d', 'project-e'];
  for (const name of projectNames) {
    projectRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name, path: path.join(tempDir, name) },
      }),
    );
  }

  // Seed deployments in DB first
  for (let i = 0; i < TOTAL_JOBS; i++) {
    const proj = projectNames[i % projectNames.length];
    depRepo.createDeployment({
      id: `dep_${i}`,
      projectName: proj,
      targetSha: `sha_${i}`,
      status: 'queued',
      triggerType: 'poll',
    });
  }

  const start = performance.now();

  // Enqueue jobs
  for (let i = 0; i < TOTAL_JOBS; i++) {
    const proj = projectNames[i % projectNames.length];
    await engine.enqueueDeployJob({
      deploymentId: `dep_${i}`,
      projectName: proj,
      targetSha: `sha_${i}`,
      triggerType: 'poll',
      triggeredAt: Date.now(),
    });
  }

  await donePromise;

  const duration = performance.now() - start;
  console.log(
    `[Queue Benchmark] Processed ${TOTAL_JOBS} jobs across 5 projects in ${duration.toFixed(2)}ms`,
  );

  await engine.stopWorker();
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
