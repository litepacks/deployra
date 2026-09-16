import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { DeployraDaemon } from '../src/daemon.js';
import { GitClient } from '../src/git/git-client.js';
import { WorkmaticEngine } from '../src/jobs/workmatic-engine.js';
import { safeExec } from '../src/security/exec.js';
import { closeDatabase, getDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';
import { StateRepository } from '../src/storage/state-repository.js';
import { SourceWatcher } from '../src/watcher/source-watcher.js';

describe('Deployra Self-Repair & Auto-Recovery Mechanisms', () => {
  let tempDir: string;
  let repoDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-self-repair-'));
    repoDir = path.join(tempDir, 'repo');
    dbPath = path.join(tempDir, 'test.db');
    process.env.DEPLOYRA_DB_PATH = dbPath;
    process.env.WORKMATIC_DB_PATH = path.join(tempDir, 'workmatic.db');

    resetDatabase();

    // Initialize mock git repository
    fs.mkdirSync(repoDir, { recursive: true });
    await safeExec('git', ['init'], { cwd: repoDir });
    await safeExec('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await safeExec('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project');
    await safeExec('git', ['add', '.'], { cwd: repoDir });
    await safeExec('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });
  });

  afterEach(async () => {
    closeDatabase();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('automatically detects and repairs stale .git/index.lock files', async () => {
    const gitClient = new GitClient();
    const gitDir = path.join(repoDir, '.git');
    const indexLock = path.join(gitDir, 'index.lock');
    const fetchHeadLock = path.join(gitDir, 'FETCH_HEAD.lock');

    // Simulate leftover stale lock files from an unexpected reboot/crash
    fs.writeFileSync(indexLock, 'locked');
    fs.writeFileSync(fetchHeadLock, 'locked');
    expect(fs.existsSync(indexLock)).toBe(true);
    expect(fs.existsSync(fetchHeadLock)).toBe(true);

    const removed = gitClient.repairStaleLocks(repoDir);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(indexLock)).toBe(false);
    expect(fs.existsSync(fetchHeadLock)).toBe(false);

    // Verify git operations succeed normally after auto-repair
    const sha = await gitClient.getCurrentSha(repoDir);
    expect(sha).toBeDefined();
    expect(sha.length).toBe(40);
  });

  it('prunes stale project locks when previous deployment is finished or crashed', () => {
    const stateRepo = new StateRepository();
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'my-app', path: repoDir },
        source: { remote: 'origin', branch: 'main' },
      }),
    );

    // Create a finished deployment
    const dep = depRepo.createDeployment({
      projectName: 'my-app',
      targetSha: 'abc1234',
      triggerType: 'manual',
    });
    depRepo.updateStatus(dep.id, 'failed', 'Network timeout');

    // Simulate an existing lock left behind
    const db = getDatabase();
    db.prepare(
      `INSERT INTO project_locks (project_name, locked_by, locked_at) VALUES (?, ?, ?)`,
    ).run('my-app', dep.id, Date.now() - 60000);

    expect(stateRepo.isLocked('my-app')).toBe(true);

    // Self-repair prune should remove the lock because deployment status is 'failed'
    const pruned = stateRepo.pruneStaleLocks(new Set());
    expect(pruned).toBe(1);
    expect(stateRepo.isLocked('my-app')).toBe(false);

    // New lock should be acquired immediately without waiting
    const acquired = stateRepo.acquireLock('my-app', 'dep_new_123');
    expect(acquired).toBe(true);
  });

  it('cleans up unfinished and interrupted deployments on daemon startup', () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'interrupted-app-1', path: repoDir },
        source: { remote: 'origin', branch: 'main' },
      }),
    );
    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'interrupted-app-2', path: repoDir },
        source: { remote: 'origin', branch: 'main' },
      }),
    );

    // Create running and queued deployments as if interrupted by server restart
    const dep1 = depRepo.createDeployment({
      projectName: 'interrupted-app-1',
      targetSha: 'sha1',
      triggerType: 'poll',
    });
    depRepo.updateStatus(dep1.id, 'running');

    const dep2 = depRepo.createDeployment({
      projectName: 'interrupted-app-2',
      targetSha: 'sha2',
      triggerType: 'poll',
    });

    const cleaned = depRepo.cleanupUnfinishedJobsOnStartup();
    expect(cleaned).toBe(2);

    const updated1 = depRepo.getDeployment(dep1.id);
    const updated2 = depRepo.getDeployment(dep2.id);

    expect(updated1?.status).toBe('failed');
    expect(updated1?.error).toContain('Daemon restarted during active deployment');
    expect(updated2?.status).toBe('failed');
  });

  it('SourceWatcher self-heals by retrying failed commit deployments after cooldown', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const workmatic = new WorkmaticEngine();
    const watcher = new SourceWatcher(workmatic);

    const config = normalizeAndValidateConfig({
      project: { name: 'auto-heal-app', path: repoDir },
      source: { remote: 'origin', branch: 'main' },
      watch: { intervalMs: 5000 },
      deploy: { commands: { build: ['echo build'] } },
    });
    projRepo.saveProject(config);

    const headSha = await new GitClient().getCurrentSha(repoDir);

    // Simulate a failed previous deployment for headSha that finished 2 minutes ago
    const oldDep = depRepo.createDeployment({
      projectName: 'auto-heal-app',
      targetSha: headSha,
      triggerType: 'poll',
    });
    depRepo.updateStatus(oldDep.id, 'failed', 'Temporary npm network error');

    // Update completedAt to 2 minutes ago
    const db = getDatabase();
    db.prepare(`UPDATE deployments SET completed_at = ? WHERE id = ?`).run(
      Date.now() - 120000,
      oldDep.id,
    );

    // Polling check should auto-retry deploying the failed SHA
    const newDepId = await watcher.checkProject('auto-heal-app', 'poll', false, headSha);
    expect(newDepId).toBeDefined();
    expect(newDepId).not.toBe(oldDep.id);

    const newDep = depRepo.getDeployment(newDepId!);
    expect(newDep?.targetSha).toBe(headSha);
    expect(newDep?.status).toBe('queued');

    await workmatic.stopWorker();
  });

  it('Daemon Self-Repair Watchdog cycle auto-heals down services and prunes locks', async () => {
    const daemon = new DeployraDaemon({ watchdogIntervalMs: 10000 });
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const stateRepo = new StateRepository();

    const config = normalizeAndValidateConfig({
      project: { name: 'watchdog-app', path: repoDir },
      source: { remote: 'origin', branch: 'main' },
      deploy: {
        strategy: 'in-place',
        service: { name: 'watchdog-svc', action: 'restart' },
      },
    });

    // Save project and set lastSuccessfulSha
    projRepo.saveProject(config);
    projRepo.updateLastSuccessfulSha('watchdog-app', 'sha_success_123');

    // Create a finished deployment that left a lock
    const deadDep = depRepo.createDeployment({
      projectName: 'watchdog-app',
      targetSha: 'sha_failed_1',
      triggerType: 'poll',
    });
    depRepo.updateStatus(deadDep.id, 'failed', 'Process crashed');

    stateRepo.acquireLock('watchdog-app', deadDep.id);
    expect(stateRepo.isLocked('watchdog-app')).toBe(true);

    // Run self-repair cycle
    await daemon.runSelfRepairCycle(false);

    // Stale lock should have been pruned
    expect(stateRepo.isLocked('watchdog-app')).toBe(false);
  });
});
