import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { DeploymentPipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { safeExec } from '../src/security/exec.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';

describe("Zero-Downtime Atomic Symlink Deployments (strategy: 'release')", () => {
  let tmpDir: string;
  let remoteRepoPath: string;
  let workDir: string;
  let targetPath: string;
  let releaseRoot: string;

  const getHeadSha = async (dir: string) =>
    (await safeExec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-release-'));
    process.env.DEPLOYRA_DB_PATH = path.join(tmpDir, 'deployra.db');
    process.env.WORKMATIC_DB_PATH = path.join(tmpDir, 'workmatic.db');
    resetDatabase();

    remoteRepoPath = path.join(tmpDir, 'remote.git');
    workDir = path.join(tmpDir, 'work');
    targetPath = path.join(tmpDir, 'target');
    releaseRoot = path.join(tmpDir, 'srv-release-app');

    fs.mkdirSync(remoteRepoPath, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(targetPath, { recursive: true });
    fs.mkdirSync(releaseRoot, { recursive: true });

    // Initialize bare remote git repository
    await safeExec('git', ['init', '--bare'], { cwd: remoteRepoPath });

    // Initialize working repo, commit initial files, and push to remote
    await safeExec('git', ['init'], { cwd: workDir });
    await safeExec('git', ['config', 'user.name', 'Deployra Release Tester'], { cwd: workDir });
    await safeExec('git', ['config', 'user.email', 'release@deployra.local'], { cwd: workDir });
    await safeExec('git', ['remote', 'add', 'origin', remoteRepoPath], { cwd: workDir });

    fs.writeFileSync(path.join(workDir, 'version.txt'), '1.0.0');
    fs.writeFileSync(path.join(workDir, 'index.js'), 'console.log("Release v1.0.0");');
    await safeExec('git', ['add', '.'], { cwd: workDir });
    await safeExec('git', ['commit', '-m', 'feat: release v1.0.0'], { cwd: workDir });
    await safeExec('git', ['branch', '-M', 'main'], { cwd: workDir });
    await safeExec('git', ['push', '-u', 'origin', 'main'], { cwd: workDir });

    // Clone into targetPath as base repo
    await safeExec('git', ['clone', remoteRepoPath, targetPath]);
    await safeExec('git', ['config', 'user.name', 'Deployra Release Tester'], { cwd: targetPath });
    await safeExec('git', ['config', 'user.email', 'release@deployra.local'], { cwd: targetPath });
  });

  afterEach(() => {
    closeDatabase();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('deploys initial version into isolated releases/<id> and atomically links current', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const runner = new DeploymentPipelineRunner();

    const config = normalizeAndValidateConfig({
      project: {
        name: 'atomic-app',
        path: targetPath,
      },
      source: {
        remote: 'origin',
        branch: 'main',
      },
      deploy: {
        strategy: 'release',
        workspacePath: releaseRoot,
        releasesToKeep: 5,
        service: {
          name: 'atomic-svc',
          action: 'none',
        },
      },
    });

    projRepo.saveProject(config);
    const targetSha = await getHeadSha(workDir);

    const depId = 'dep_rel_1';
    depRepo.createDeployment({
      id: depId,
      projectName: 'atomic-app',
      targetSha,
      triggerType: 'manual',
    });

    await runner.runDeployment({
      deploymentId: depId,
      projectName: 'atomic-app',
      targetSha,
      triggerType: 'manual',
      dryRun: false,
      triggeredAt: Date.now(),
    });

    const completed = depRepo.getDeployment(depId);
    expect(completed?.status).toBe('success');

    // Verify release folder exists
    const releaseDir = path.join(releaseRoot, 'releases', depId);
    expect(fs.existsSync(releaseDir)).toBe(true);
    expect(fs.readFileSync(path.join(releaseDir, 'version.txt'), 'utf8').trim()).toBe('1.0.0');

    // Verify current symlink exists and points to releaseDir
    const currentLink = path.join(releaseRoot, 'current');
    expect(fs.existsSync(currentLink)).toBe(true);
    expect(fs.lstatSync(currentLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(currentLink)).toBe(fs.realpathSync(releaseDir));

    // Verify current symlink content
    expect(fs.readFileSync(path.join(currentLink, 'version.txt'), 'utf8').trim()).toBe('1.0.0');
  });

  it('atomically switches current symlink on new release without modifying previous release', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const runner = new DeploymentPipelineRunner();

    const config = normalizeAndValidateConfig({
      project: {
        name: 'atomic-app-2',
        path: targetPath,
      },
      source: {
        remote: 'origin',
        branch: 'main',
      },
      deploy: {
        strategy: 'release',
        workspacePath: releaseRoot,
        releasesToKeep: 5,
        service: {
          name: 'atomic-svc',
          action: 'none',
        },
      },
    });

    projRepo.saveProject(config);

    // 1. Deploy Release 1 (v1.0.0)
    const targetSha1 = await getHeadSha(workDir);
    const depId1 = 'dep_rel_10';
    depRepo.createDeployment({
      id: depId1,
      projectName: 'atomic-app-2',
      targetSha: targetSha1,
      triggerType: 'manual',
    });

    await runner.runDeployment({
      deploymentId: depId1,
      projectName: 'atomic-app-2',
      targetSha: targetSha1,
      triggerType: 'manual',
      dryRun: false,
      triggeredAt: Date.now(),
    });

    const currentLink = path.join(releaseRoot, 'current');
    expect(fs.realpathSync(currentLink)).toBe(
      fs.realpathSync(path.join(releaseRoot, 'releases', depId1)),
    );

    // 2. Commit and push v2.0.0
    fs.writeFileSync(path.join(workDir, 'version.txt'), '2.0.0');
    await safeExec('git', ['add', '.'], { cwd: workDir });
    await safeExec('git', ['commit', '-m', 'feat: release v2.0.0'], { cwd: workDir });
    await safeExec('git', ['push', 'origin', 'main'], { cwd: workDir });
    const targetSha2 = await getHeadSha(workDir);

    // 3. Deploy Release 2 (v2.0.0)
    const depId2 = 'dep_rel_20';
    depRepo.createDeployment({
      id: depId2,
      projectName: 'atomic-app-2',
      targetSha: targetSha2,
      previousSha: targetSha1,
      triggerType: 'manual',
    });

    await runner.runDeployment({
      deploymentId: depId2,
      projectName: 'atomic-app-2',
      targetSha: targetSha2,
      previousSha: targetSha1,
      triggerType: 'manual',
      dryRun: false,
      triggeredAt: Date.now(),
    });

    // Verify current symlink now points to depId2
    const release2Dir = path.join(releaseRoot, 'releases', depId2);
    expect(fs.realpathSync(currentLink)).toBe(fs.realpathSync(release2Dir));
    expect(fs.readFileSync(path.join(currentLink, 'version.txt'), 'utf8').trim()).toBe('2.0.0');

    // Verify previous release is intact and untouched
    const release1Dir = path.join(releaseRoot, 'releases', depId1);
    expect(fs.existsSync(release1Dir)).toBe(true);
    expect(fs.readFileSync(path.join(release1Dir, 'version.txt'), 'utf8').trim()).toBe('1.0.0');
  });

  it('prunes older releases according to releasesToKeep retention policy', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const runner = new DeploymentPipelineRunner();

    const config = normalizeAndValidateConfig({
      project: {
        name: 'atomic-app-retention',
        path: targetPath,
      },
      source: {
        remote: 'origin',
        branch: 'main',
      },
      deploy: {
        strategy: 'release',
        workspacePath: releaseRoot,
        releasesToKeep: 2, // Keep only last 2 releases
        service: {
          name: 'atomic-svc',
          action: 'none',
        },
      },
    });

    projRepo.saveProject(config);

    // Deploy release 1
    const sha1 = await getHeadSha(workDir);
    const depId1 = 'rel_ret_1';
    depRepo.createDeployment({
      id: depId1,
      projectName: 'atomic-app-retention',
      targetSha: sha1,
      triggerType: 'manual',
    });
    await runner.runDeployment({
      deploymentId: depId1,
      projectName: 'atomic-app-retention',
      targetSha: sha1,
      triggerType: 'manual',
      dryRun: false,
      triggeredAt: Date.now(),
    });

    await new Promise((res) => setTimeout(res, 50));

    // Commit 2 and deploy release 2
    fs.writeFileSync(path.join(workDir, 'version.txt'), '1.1.0');
    await safeExec('git', ['commit', '-am', 'feat: v1.1.0'], { cwd: workDir });
    await safeExec('git', ['push', 'origin', 'main'], { cwd: workDir });
    const sha2 = await getHeadSha(workDir);

    const depId2 = 'rel_ret_2';
    depRepo.createDeployment({
      id: depId2,
      projectName: 'atomic-app-retention',
      targetSha: sha2,
      triggerType: 'manual',
    });
    await runner.runDeployment({
      deploymentId: depId2,
      projectName: 'atomic-app-retention',
      targetSha: sha2,
      triggerType: 'manual',
      dryRun: false,
      triggeredAt: Date.now(),
    });

    await new Promise((res) => setTimeout(res, 50));

    // Commit 3 and deploy release 3
    fs.writeFileSync(path.join(workDir, 'version.txt'), '1.2.0');
    await safeExec('git', ['commit', '-am', 'feat: v1.2.0'], { cwd: workDir });
    await safeExec('git', ['push', 'origin', 'main'], { cwd: workDir });
    const sha3 = await getHeadSha(workDir);

    const depId3 = 'rel_ret_3';
    depRepo.createDeployment({
      id: depId3,
      projectName: 'atomic-app-retention',
      targetSha: sha3,
      triggerType: 'manual',
    });
    await runner.runDeployment({
      deploymentId: depId3,
      projectName: 'atomic-app-retention',
      targetSha: sha3,
      triggerType: 'manual',
      dryRun: false,
      triggeredAt: Date.now(),
    });

    const releasesDir = path.join(releaseRoot, 'releases');
    const existingDirs = fs.readdirSync(releasesDir);

    // releasesToKeep: 2 -> rel_ret_1 should be pruned, while rel_ret_2 and rel_ret_3 should remain
    expect(existingDirs).not.toContain(depId1);
    expect(existingDirs).toContain(depId2);
    expect(existingDirs).toContain(depId3);
    const currentLink = path.join(releaseRoot, 'current');
    expect(fs.realpathSync(currentLink)).toBe(fs.realpathSync(path.join(releasesDir, depId3)));
  }, 20000);

  it('performs instant symlink rollback when build or check fails in release mode', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const runner = new DeploymentPipelineRunner();

    const config = normalizeAndValidateConfig({
      project: {
        name: 'atomic-app-rollback',
        path: targetPath,
      },
      source: {
        remote: 'origin',
        branch: 'main',
      },
      deploy: {
        strategy: 'release',
        workspacePath: releaseRoot,
        rollback: {
          enabled: true,
        },
        service: {
          name: 'atomic-svc',
          action: 'none',
        },
      },
    });

    projRepo.saveProject(config);

    // 1. Successful release 1
    const goodSha = await getHeadSha(workDir);
    const depId1 = 'rel_good_1';
    depRepo.createDeployment({
      id: depId1,
      projectName: 'atomic-app-rollback',
      targetSha: goodSha,
      triggerType: 'manual',
    });
    await runner.runDeployment({
      deploymentId: depId1,
      projectName: 'atomic-app-rollback',
      targetSha: goodSha,
      triggerType: 'manual',
      dryRun: false,
      triggeredAt: Date.now(),
    });

    const currentLink = path.join(releaseRoot, 'current');
    const goodDir = path.join(releaseRoot, 'releases', depId1);
    expect(fs.realpathSync(currentLink)).toBe(fs.realpathSync(goodDir));

    // 2. Configure failing command on second deployment
    const failingConfig = normalizeAndValidateConfig({
      project: {
        name: 'atomic-app-rollback',
        path: targetPath,
      },
      source: {
        remote: 'origin',
        branch: 'main',
      },
      deploy: {
        strategy: 'release',
        workspacePath: releaseRoot,
        rollback: {
          enabled: true,
        },
        retry: {
          attempts: 0,
          backoff: '10ms',
        },
        commands: {
          build: ['sh -c "exit 42"'], // intentional build failure
        },
        service: {
          name: 'atomic-svc',
          action: 'none',
        },
      },
    });
    projRepo.saveProject(failingConfig);

    fs.writeFileSync(path.join(workDir, 'version.txt'), 'bad');
    await safeExec('git', ['commit', '-am', 'feat: bad build'], { cwd: workDir });
    await safeExec('git', ['push', 'origin', 'main'], { cwd: workDir });
    const badSha = await getHeadSha(workDir);

    const depId2 = 'rel_bad_2';
    depRepo.createDeployment({
      id: depId2,
      projectName: 'atomic-app-rollback',
      targetSha: badSha,
      previousSha: goodSha,
      triggerType: 'manual',
    });

    await runner.runDeployment({
      deploymentId: depId2,
      projectName: 'atomic-app-rollback',
      targetSha: badSha,
      previousSha: goodSha,
      triggerType: 'manual',
      dryRun: false,
      triggeredAt: Date.now(),
    });

    const badDep = depRepo.getDeployment(depId2);
    expect(badDep?.status).toBe('rolled_back');

    // Verify current symlink still points to goodDir
    expect(fs.realpathSync(currentLink)).toBe(fs.realpathSync(goodDir));
    expect(fs.readFileSync(path.join(currentLink, 'version.txt'), 'utf8').trim()).toBe('1.0.0');

    // Verify failed release folder was cleaned up
    const badDir = path.join(releaseRoot, 'releases', depId2);
    expect(fs.existsSync(badDir)).toBe(false);
  }, 20000);

  it('runs safely in dry-run mode without creating releases or symlinks', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const runner = new DeploymentPipelineRunner();

    const config = normalizeAndValidateConfig({
      project: {
        name: 'atomic-app-dry',
        path: targetPath,
      },
      source: {
        remote: 'origin',
        branch: 'main',
      },
      deploy: {
        strategy: 'release',
        workspacePath: releaseRoot,
        service: {
          name: 'atomic-svc',
          action: 'none',
        },
      },
    });

    projRepo.saveProject(config);

    const depId = 'dep_dry_rel';
    depRepo.createDeployment({
      id: depId,
      projectName: 'atomic-app-dry',
      targetSha: 'main',
      triggerType: 'manual',
      dryRun: true,
    });

    await runner.runDeployment({
      deploymentId: depId,
      projectName: 'atomic-app-dry',
      targetSha: 'main',
      triggerType: 'manual',
      dryRun: true,
      triggeredAt: Date.now(),
    });

    const completed = depRepo.getDeployment(depId);
    expect(completed?.status).toBe('success');
    expect(completed?.dryRun).toBe(true);

    // Verify no releases or symlinks created on disk
    expect(fs.existsSync(path.join(releaseRoot, 'releases', depId))).toBe(false);
    expect(fs.existsSync(path.join(releaseRoot, 'current'))).toBe(false);
  });
});
