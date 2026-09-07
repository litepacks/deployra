import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeAndValidateConfig } from '../src/config/schema.js';
import { NotificationService } from '../src/notifications/notification-service.js';
import { DeploymentPipelineRunner } from '../src/pipeline/pipeline-runner.js';
import { closeDatabase, resetDatabase } from '../src/storage/database.js';
import { DeploymentRepository } from '../src/storage/deployment-repository.js';
import { ProjectRepository } from '../src/storage/project-repository.js';

describe('Notifications & Alerting System', () => {
  let server: http.Server;
  let serverUrl: string;
  let receivedRequests: Array<{
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    body: any;
  }> = [];

  beforeEach(async () => {
    process.env.DEPLOYRA_DB_PATH = ':memory:';
    resetDatabase();

    receivedRequests = [];
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        let parsed: any = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        receivedRequests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: parsed,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    closeDatabase();
    if (server) {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('formats and dispatches Slack incoming webhook notifications with Block Kit', async () => {
    const notifier = new NotificationService();
    const config = normalizeAndValidateConfig({
      project: { name: 'slack-app', path: '/tmp/slack-app' },
      notifications: {
        slack: { url: `${serverUrl}/slack-webhook` },
      },
    });

    await notifier.sendDeploymentNotification(config, {
      projectName: 'slack-app',
      deploymentId: 'dep_slack_1',
      status: 'success',
      targetSha: '1a2b3c4d5e6f7g8h9i0j',
      durationMs: 4500,
    });

    expect(receivedRequests.length).toBe(1);
    const req = receivedRequests[0];
    expect(req.url).toBe('/slack-webhook');
    expect(req.body.text).toContain('[slack-app] Deployment #dep_slack_1: SUCCESS');
    expect(req.body.attachments).toHaveLength(1);
    expect(req.body.attachments[0].color).toBe('#2eb886'); // green
    expect(JSON.stringify(req.body.attachments[0].blocks)).toContain('slack-app');
    expect(JSON.stringify(req.body.attachments[0].blocks)).toContain('4.5s');
  });

  it('formats and dispatches Discord embed notifications', async () => {
    const notifier = new NotificationService();
    const config = normalizeAndValidateConfig({
      project: { name: 'discord-app', path: '/tmp/discord-app' },
      notifications: {
        discord: { url: `${serverUrl}/discord-webhook` },
      },
    });

    await notifier.sendDeploymentNotification(config, {
      projectName: 'discord-app',
      deploymentId: 'dep_discord_1',
      status: 'failed',
      targetSha: 'deadbeef1234567890ab',
      durationMs: 8200,
      error: 'Compile error at line 42',
    });

    expect(receivedRequests.length).toBe(1);
    const req = receivedRequests[0];
    expect(req.url).toBe('/discord-webhook');
    expect(req.body.username).toBe('Deployra');
    expect(req.body.embeds).toHaveLength(1);
    const embed = req.body.embeds[0];
    expect(embed.title).toContain('[discord-app] Deployment #dep_discord_1: failed');
    expect(embed.color).toBe(0xe74c3c); // red
    expect(embed.fields.some((f: any) => f.name === 'Status' && f.value === 'failed')).toBe(true);
    expect(embed.fields.some((f: any) => f.name === 'Error' && f.value.includes('Compile error'))).toBe(true);
  });

  it('formats and dispatches Telegram Bot API notifications', async () => {
    const notifier = new NotificationService();
    const config = normalizeAndValidateConfig({
      project: { name: 'telegram-app', path: '/tmp/telegram-app' },
      notifications: {
        telegram: {
          token: '123456:FAKE-BOT-TOKEN',
          chatId: '-100987654321',
        },
      },
    });

    // Point the telegram channel to our local test server
    config.notifications[0].url = `${serverUrl}/telegram-bot`;

    await notifier.sendDeploymentNotification(config, {
      projectName: 'telegram-app',
      deploymentId: 'dep_tg_1',
      status: 'rolled_back',
      targetSha: 'fedcba0987654321fedc',
      durationMs: 3100,
      error: 'Health check timed out',
    });

    expect(receivedRequests.length).toBe(1);
    const req = receivedRequests[0];
    expect(req.url).toBe('/telegram-bot');
    expect(req.body.chat_id).toBe('-100987654321');
    expect(req.body.parse_mode).toBe('Markdown');
    expect(req.body.text).toContain('telegram-app');
    expect(req.body.text).toContain('rolled_back');
    expect(req.body.text).toContain('Health check timed out');
  });

  it('formats and dispatches Generic Webhooks with custom headers and payload', async () => {
    const notifier = new NotificationService();
    const config = normalizeAndValidateConfig({
      project: { name: 'generic-app', path: '/tmp/generic-app' },
      notifications: {
        webhook: {
          url: `${serverUrl}/custom-webhook`,
          headers: {
            'x-auth-token': 'super-secret-token',
            'x-cluster': 'us-east-1',
          },
        },
      },
    });

    await notifier.sendDeploymentNotification(config, {
      projectName: 'generic-app',
      deploymentId: 'dep_gen_1',
      status: 'success',
      targetSha: 'abc123def456',
      durationMs: 1200,
      triggerType: 'webhook',
    });

    expect(receivedRequests.length).toBe(1);
    const req = receivedRequests[0];
    expect(req.url).toBe('/custom-webhook');
    expect(req.headers['x-auth-token']).toBe('super-secret-token');
    expect(req.headers['x-cluster']).toBe('us-east-1');
    expect(req.body.event).toBe('deployment.success');
    expect(req.body.projectName).toBe('generic-app');
    expect(req.body.deploymentId).toBe('dep_gen_1');
    expect(req.body.status).toBe('success');
    expect(req.body.durationMs).toBe(1200);
  });

  it('filters notifications based on configured events', async () => {
    const notifier = new NotificationService();
    const config = normalizeAndValidateConfig({
      project: { name: 'filter-app', path: '/tmp/filter-app' },
      notifications: [
        {
          type: 'webhook',
          url: `${serverUrl}/only-failures`,
          events: ['failure', 'rollback'],
        },
      ],
    });

    // 1. Send success -> should NOT trigger webhook
    await notifier.sendDeploymentNotification(config, {
      projectName: 'filter-app',
      deploymentId: 'dep_ok',
      status: 'success',
      targetSha: 'sha1',
    });
    expect(receivedRequests.length).toBe(0);

    // 2. Send failure -> should trigger webhook
    await notifier.sendDeploymentNotification(config, {
      projectName: 'filter-app',
      deploymentId: 'dep_fail',
      status: 'failed',
      targetSha: 'sha2',
      error: 'Build failed',
    });
    expect(receivedRequests.length).toBe(1);
    expect(receivedRequests[0].body.event).toBe('deployment.failure');
  });

  it('handles remote HTTP failures gracefully without disrupting caller', async () => {
    // Reconfigure mock server to return 500 Internal Server Error
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    });

    const notifier = new NotificationService();
    const config = normalizeAndValidateConfig({
      project: { name: 'fault-tolerant-app', path: '/tmp/fault-tolerant-app' },
      notifications: {
        slack: { url: `${serverUrl}/slack` },
      },
    });

    // Should NOT throw an error despite HTTP 500
    await expect(
      notifier.sendDeploymentNotification(config, {
        projectName: 'fault-tolerant-app',
        deploymentId: 'dep_err',
        status: 'success',
        targetSha: 'sha_test',
      }),
    ).resolves.not.toThrow();
  });

  it('skips network dispatch in dry-run mode', async () => {
    const notifier = new NotificationService();
    const config = normalizeAndValidateConfig({
      project: { name: 'dry-app', path: '/tmp/dry-app' },
      notifications: {
        webhook: { url: `${serverUrl}/dry-run-webhook` },
      },
    });

    await notifier.sendDeploymentNotification(config, {
      projectName: 'dry-app',
      deploymentId: 'dep_dry',
      status: 'success',
      targetSha: 'sha_dry',
      dryRun: true,
    });

    expect(receivedRequests.length).toBe(0);
  });

  it('integrates seamlessly with DeploymentPipelineRunner on completion', async () => {
    const projRepo = new ProjectRepository();
    const depRepo = new DeploymentRepository();
    const runner = new DeploymentPipelineRunner();

    const config = normalizeAndValidateConfig({
      project: { name: 'pipe-notify-app', path: '/tmp/pipe-notify-app' },
      deploy: {
        service: { name: 'pipe-notify-app', action: 'none' },
      },
      notifications: {
        webhook: { url: `${serverUrl}/pipeline-finish` },
      },
    });

    projRepo.saveProject(config);

    const depId = 'dep_pipe_notify_1';
    depRepo.createDeployment({
      id: depId,
      projectName: 'pipe-notify-app',
      targetSha: 'commit_sha_123',
      triggerType: 'manual',
      dryRun: true,
    });

    await runner.runDeployment({
      deploymentId: depId,
      projectName: 'pipe-notify-app',
      targetSha: 'commit_sha_123',
      triggerType: 'manual',
      dryRun: false,
      triggeredAt: Date.now(),
    });

    // In non-dryRun pipeline with simulated git/steps in test, verify webhook was triggered
    // If target repo doesn't exist, validate-repository fails and triggers failure notification!
    expect(receivedRequests.length).toBeGreaterThan(0);
    const lastRequest = receivedRequests[receivedRequests.length - 1];
    expect(lastRequest.url).toBe('/pipeline-finish');
    expect(lastRequest.body.projectName).toBe('pipe-notify-app');
    expect(['deployment.success', 'deployment.failure', 'deployment.rollback']).toContain(
      lastRequest.body.event,
    );
  });
});
