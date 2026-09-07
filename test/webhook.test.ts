import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { DeployraDaemon } from '../src/daemon.js';
import { WorkmaticEngine } from '../src/jobs/workmatic-engine.js';
import { WebhookServer } from '../src/server/webhook-server.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';
import { SourceWatcher } from '../src/watcher/source-watcher.js';

describe('Webhook Receiver & Security', () => {
  let tempDir: string;
  let workmaticDbPath: string;
  let server: WebhookServer | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployra-webhook-test-'));
    process.env.DEPLOYRA_DB_PATH = path.join(tempDir, 'test-deployra.db');
    workmaticDbPath = path.join(tempDir, 'test-workmatic.db');
    process.env.WORKMATIC_DB_PATH = workmaticDbPath;
    resetDatabase();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves /health check endpoint', async () => {
    const engine = new WorkmaticEngine({ dbPath: workmaticDbPath });
    const watcher = new SourceWatcher(engine);
    server = new WebhookServer({ port: 0, sourceWatcher: watcher });
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('deployra-webhook');
  });

  it('returns 404 for unknown project webhook endpoint', async () => {
    const engine = new WorkmaticEngine({ dbPath: workmaticDbPath });
    const watcher = new SourceWatcher(engine);
    server = new WebhookServer({ port: 0, sourceWatcher: watcher });
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/webhook/non-existent-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  it('returns 403 when webhook is disabled for a project', async () => {
    const projRepo = new ProjectRepository();
    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'disabled-webhook-app', path: path.join(tempDir, 'disabled') },
        webhook: { enabled: false },
      }),
    );

    const engine = new WorkmaticEngine({ dbPath: workmaticDbPath });
    const watcher = new SourceWatcher(engine);
    server = new WebhookServer({ port: 0, sourceWatcher: watcher });
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/webhook/disabled-webhook-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('disabled');
  });

  it('handles GitHub ping event with pong', async () => {
    const projRepo = new ProjectRepository();
    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'ping-app', path: path.join(tempDir, 'ping') },
      }),
    );

    const engine = new WorkmaticEngine({ dbPath: workmaticDbPath });
    const watcher = new SourceWatcher(engine);
    server = new WebhookServer({ port: 0, sourceWatcher: watcher });
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/webhook/ping-app`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
      },
      body: JSON.stringify({ zen: 'Keep it logically awesome.' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('pong');
  });

  it('verifies GitHub HMAC-SHA256 signature and triggers webhook deployment', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const secret = 'super-secret-github-key-12345';

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'gh-app', path: path.join(tempDir, 'gh') },
        source: { remote: 'origin', branch: 'main' },
        webhook: { enabled: true, secret },
      }),
    );

    const engine = new WorkmaticEngine({ dbPath: workmaticDbPath });
    const watcher = new SourceWatcher(engine);
    server = new WebhookServer({ port: 0, sourceWatcher: watcher });
    const port = await server.start();

    const payloadObj = {
      ref: 'refs/heads/main',
      after: 'a1b2c3d4e5f6789012345678901234567890abcd',
      repository: { name: 'gh-app' },
    };
    const rawPayload = JSON.stringify(payloadObj);
    const validHmac = crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/webhook/gh-app`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${validHmac}`,
      },
      body: rawPayload,
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; deploymentId: string; targetSha: string };
    expect(body.status).toBe('enqueued');
    expect(body.deploymentId).toMatch(/^dep_/);
    expect(body.targetSha).toBe('a1b2c3d4e5f6789012345678901234567890abcd');

    const dep = depRepo.getDeployment(body.deploymentId);
    expect(dep).toBeDefined();
    expect(dep?.triggerType).toBe('webhook');
    expect(dep?.targetSha).toBe('a1b2c3d4e5f6789012345678901234567890abcd');
  });

  it('rejects invalid or missing HMAC-SHA256 signature with 401 Unauthorized', async () => {
    const projRepo = new ProjectRepository();
    const secret = 'super-secret-github-key-12345';

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'secure-app', path: path.join(tempDir, 'secure') },
        webhook: { enabled: true, secret },
      }),
    );

    const engine = new WorkmaticEngine({ dbPath: workmaticDbPath });
    const watcher = new SourceWatcher(engine);
    server = new WebhookServer({ port: 0, sourceWatcher: watcher });
    const port = await server.start();

    const rawPayload = JSON.stringify({ ref: 'refs/heads/main', after: 'deadbeef' });

    // 1. Missing signature
    const resNoSig = await fetch(`http://127.0.0.1:${port}/api/v1/webhook/secure-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawPayload,
    });
    expect(resNoSig.status).toBe(401);

    // 2. Tampered / wrong signature
    const resBadSig = await fetch(`http://127.0.0.1:${port}/api/v1/webhook/secure-app`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256':
          'sha256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      },
      body: rawPayload,
    });
    expect(resBadSig.status).toBe(401);
  });

  it('verifies GitLab token header (X-Gitlab-Token) and triggers deployment', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const token = 'gitlab-secret-token-xyz';

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'gl-app', path: path.join(tempDir, 'gl') },
        source: { remote: 'origin', branch: 'main' },
        webhook: { enabled: true, secret: token },
      }),
    );

    const engine = new WorkmaticEngine({ dbPath: workmaticDbPath });
    const watcher = new SourceWatcher(engine);
    server = new WebhookServer({ port: 0, sourceWatcher: watcher });
    const port = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/webhook/gl-app`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gitlab-Token': token,
      },
      body: JSON.stringify({
        ref: 'refs/heads/main',
        checkout_sha: 'c1d2e3f4a5b6789012345678901234567890cdef',
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; deploymentId: string };
    expect(body.status).toBe('enqueued');

    const dep = depRepo.getDeployment(body.deploymentId);
    expect(dep?.triggerType).toBe('webhook');
  });

  it('ignores pushes to non-target branches', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();

    projRepo.saveProject(
      normalizeAndValidateConfig({
        project: { name: 'branch-filter-app', path: path.join(tempDir, 'filter') },
        source: { remote: 'origin', branch: 'production' },
      }),
    );

    const engine = new WorkmaticEngine({ dbPath: workmaticDbPath });
    const watcher = new SourceWatcher(engine);
    server = new WebhookServer({ port: 0, sourceWatcher: watcher });
    const port = await server.start();

    // Push event to feature branch
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/webhook/branch-filter-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: 'refs/heads/feat/add-payments',
        after: '9999888877776666555544443333222211110000',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; message: string };
    expect(body.status).toBe('ignored');
    expect(body.message).toContain('production');

    // No deployment should be created
    const deps = depRepo.getDeploymentsByProject('branch-filter-app');
    expect(deps.length).toBe(0);
  });

  it('integrates webhook server inside DeployraDaemon lifecycle', async () => {
    const daemon = new DeployraDaemon({ webhookPort: 0 });
    await daemon.start('non-existent-filter-target', true);

    const webhookPort = daemon.getWebhookPort();
    expect(webhookPort).toBeDefined();
    expect(webhookPort).toBeGreaterThan(0);

    const healthRes = await fetch(`http://127.0.0.1:${webhookPort}/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { status: string };
    expect(healthJson.status).toBe('ok');

    await daemon.shutdown();
    expect(daemon.getWebhookPort()).toBeUndefined();
  });
});
