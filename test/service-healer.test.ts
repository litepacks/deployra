import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import type { NormalizedDeployraConfig } from '../src/config/types.js';
import { BASE_BACKOFF_MS, MAX_BACKOFF_MS, ServiceHealer } from '../src/repair/service-healer.js';
import { closeDatabase, getDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository, type StoredProject } from '../src/storage/project-repository.js';

const project = (overrides: Record<string, unknown> = {}, sha = 'sha_good_1'): StoredProject => {
  const config = normalizeAndValidateConfig({
    project: { name: 'heal-app', path: '/tmp/heal-app' },
    deploy: { service: { name: 'heal-svc' } },
    ...overrides,
  });
  return {
    name: 'heal-app',
    path: '/tmp/heal-app',
    remote: 'origin',
    branch: 'main',
    lastSuccessfulSha: sha,
    config,
    configHash: config.configHash,
    configVersion: 1,
    updatedAt: Date.now(),
  };
};

const setup = (opts: { active?: boolean; recoverError?: Error; healthy?: boolean } = {}) => {
  let clock = 1_000_000;
  const state = { active: opts.active ?? false, healthy: opts.healthy ?? true };
  const unitupAdapter = {
    status: vi.fn(async () => ({
      service: 'heal-svc',
      active: state.active,
      subState: state.active ? 'running' : 'failed',
    })),
    recover: vi.fn(async () => {
      if (opts.recoverError) throw opts.recoverError;
      state.active = true;
      state.healthy = true;
    }),
  };
  const readyAdapter = {
    probe: vi.fn(async () => ({ healthy: state.healthy, checks: [] })),
    wait: vi.fn(async () => {
      if (!state.healthy) throw new Error('not ready');
      return { ready: true, attempts: 1, duration: 0, checks: [] };
    }),
  };
  const notificationService = { sendDeploymentNotification: vi.fn(async () => {}) };
  const healer = new ServiceHealer({
    unitupAdapter: unitupAdapter as any,
    readyAdapter: readyAdapter as any,
    deploymentRepo: new DeploymentRepository(),
    notificationService: notificationService as any,
    now: () => clock,
  });
  return {
    healer,
    unitupAdapter,
    readyAdapter,
    notificationService,
    state,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe('ServiceHealer (self-repair watchdog)', () => {
  beforeEach(() => {
    process.env.DEPLOYRA_DB_PATH = ':memory:';
    resetDatabase();
  });

  afterAll(() => {
    closeDatabase();
  });

  it('recovers a crashed service without re-registering its unit', async () => {
    const { healer, unitupAdapter } = setup({ active: false });

    expect(await healer.check(project())).toBe('healed');
    expect(unitupAdapter.recover).toHaveBeenCalledWith('heal-svc', {
      zeroDowntime: false,
      restart: false,
    });
  });

  it('keeps zero-downtime services in supervisor mode when recovering', async () => {
    const { healer, unitupAdapter } = setup({ active: false });

    await healer.check(
      project({ deploy: { strategy: 'zero-downtime', service: { name: 'heal-svc' } } }),
    );

    expect(unitupAdapter.recover).toHaveBeenCalledWith('heal-svc', {
      zeroDowntime: true,
      restart: false,
    });
  });

  it('backs off exponentially, then gives up and alerts exactly once', async () => {
    const { healer, unitupAdapter, notificationService, advance } = setup({
      active: false,
      recoverError: new Error('start request repeated too quickly'),
    });
    const proj = project({ selfRepair: { maxRestarts: 3 } });

    expect(await healer.check(proj)).toBe('failed');
    expect(await healer.check(proj)).toBe('backoff');
    advance(BASE_BACKOFF_MS);
    expect(await healer.check(proj)).toBe('failed');
    advance(BASE_BACKOFF_MS); // second backoff is 2x: still waiting
    expect(await healer.check(proj)).toBe('backoff');
    advance(BASE_BACKOFF_MS);
    expect(await healer.check(proj)).toBe('gave_up');

    advance(MAX_BACKOFF_MS);
    expect(await healer.check(proj)).toBe('skipped');
    expect(unitupAdapter.recover).toHaveBeenCalledTimes(3);
    expect(notificationService.sendDeploymentNotification).toHaveBeenCalledOnce();
    expect(notificationService.sendDeploymentNotification.mock.calls[0]?.[1]).toMatchObject({
      status: 'failed',
      triggerType: 'self-repair',
    });
  });

  it('starts fresh after a new successful deployment', async () => {
    const { healer, unitupAdapter } = setup({
      active: false,
      recoverError: new Error('boom'),
    });
    const repair = { selfRepair: { maxRestarts: 1 } };

    expect(await healer.check(project(repair, 'sha_old'))).toBe('gave_up');
    expect(await healer.check(project(repair, 'sha_old'))).toBe('skipped');
    expect(await healer.check(project(repair, 'sha_new'))).toBe('gave_up');
    expect(unitupAdapter.recover).toHaveBeenCalledTimes(2);
  });

  it('restarts a running but unresponsive service only after the failure threshold', async () => {
    const { healer, unitupAdapter } = setup({ active: true, healthy: false });
    const proj = project({
      deploy: { service: { name: 'heal-svc' }, ready: { url: 'http://127.0.0.1:9/health' } },
      selfRepair: { healthFailureThreshold: 2 },
    });

    expect(await healer.check(proj)).toBe('degraded');
    expect(unitupAdapter.recover).not.toHaveBeenCalled();
    expect(await healer.check(proj)).toBe('healed');
    expect(unitupAdapter.recover).toHaveBeenCalledWith('heal-svc', {
      zeroDowntime: false,
      restart: true,
    });
  });

  it('leaves services alone when disabled, never deployed, or mid-deployment', async () => {
    const { healer, unitupAdapter } = setup({ active: false });

    expect(await healer.check(project({ selfRepair: { enabled: false } }))).toBe('skipped');
    expect(await healer.check({ ...project(), lastSuccessfulSha: undefined })).toBe('skipped');

    const repo = new DeploymentRepository();
    const proj = project();
    new ProjectRepository().saveProject(proj.config as NormalizedDeployraConfig);
    repo.createDeployment({
      id: 'dep_active',
      projectName: 'heal-app',
      targetSha: 'x',
      status: 'running',
      triggerType: 'manual',
    });
    expect(await healer.check(proj)).toBe('skipped');
    expect(unitupAdapter.recover).not.toHaveBeenCalled();
  });

  it('treats projects stored before selfRepair existed as enabled with defaults', async () => {
    const { healer } = setup({ active: false });
    const proj = project();
    delete (proj.config as any).selfRepair;

    expect(await healer.check(proj)).toBe('healed');
  });
});

describe('Watchdog deployment cleanup', () => {
  beforeEach(() => {
    process.env.DEPLOYRA_DB_PATH = ':memory:';
    resetDatabase();
  });

  const createAged = (id: string, status: 'running' | 'queued', ageMs: number) => {
    const repo = new DeploymentRepository();
    repo.createDeployment({ id, projectName: 'p', targetSha: id, status, triggerType: 'poll' });
    getDatabase()
      .prepare('UPDATE deployments SET created_at = ?, started_at = ? WHERE id = ?')
      .run(Date.now() - ageMs, status === 'running' ? Date.now() - ageMs : null, id);
  };

  it('never fails a long deployment the worker is still running', async () => {
    new ProjectRepository().saveProject(
      normalizeAndValidateConfig({ project: { name: 'p', path: '/tmp/p' } }),
    );
    createAged('dep_live', 'running', 60 * 60_000);
    createAged('dep_orphan', 'running', 60 * 60_000);

    const repo = new DeploymentRepository();
    expect(repo.cleanupStaleJobs(15 * 60_000, ['dep_live'])).toBe(1);
    expect(repo.getDeployment('dep_live')?.status).toBe('running');
    expect(repo.getDeployment('dep_orphan')?.status).toBe('failed');
  });

  it('fails queued deployments that were never picked up', async () => {
    new ProjectRepository().saveProject(
      normalizeAndValidateConfig({ project: { name: 'p', path: '/tmp/p' } }),
    );
    createAged('dep_lost', 'queued', 30 * 60_000);
    createAged('dep_fresh', 'queued', 60_000);

    const repo = new DeploymentRepository();
    expect(repo.failStaleQueuedDeployments(15 * 60_000)).toBe(1);
    expect(repo.getDeployment('dep_lost')?.status).toBe('failed');
    expect(repo.getDeployment('dep_fresh')?.status).toBe('queued');
  });
});
