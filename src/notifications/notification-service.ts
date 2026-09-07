import type {
  NormalizedDeployraConfig,
  NormalizedNotificationChannel,
  NotificationEvent,
} from '../config/types.js';
import { logger } from '../logging/logger.js';

export interface DeploymentNotificationPayload {
  projectName: string;
  deploymentId: string;
  status: 'success' | 'failed' | 'rolled_back';
  targetSha: string;
  previousSha?: string;
  durationMs?: number;
  error?: string;
  triggerType?: string;
  dryRun?: boolean;
}

export class NotificationService {
  public async sendDeploymentNotification(
    config: NormalizedDeployraConfig,
    payload: DeploymentNotificationPayload,
  ): Promise<void> {
    if (!config.notifications || config.notifications.length === 0) {
      return;
    }

    const event: NotificationEvent =
      payload.status === 'success'
        ? 'success'
        : payload.status === 'rolled_back'
          ? 'rollback'
          : 'failure';

    const matchingChannels = config.notifications.filter((ch) => ch.events.includes(event));

    if (matchingChannels.length === 0) {
      return;
    }

    for (const channel of matchingChannels) {
      try {
        await this.dispatchToChannel(channel, payload, event);
      } catch (err: any) {
        logger.warn(`Failed to dispatch ${event} notification to ${channel.type}: ${err.message}`, {
          project: payload.projectName,
          deploymentId: payload.deploymentId,
        });
      }
    }
  }

  private async dispatchToChannel(
    channel: NormalizedNotificationChannel,
    payload: DeploymentNotificationPayload,
    event: NotificationEvent,
  ): Promise<void> {
    if (payload.dryRun) {
      logger.info(
        `[DRY-RUN] Would dispatch ${event} notification to ${channel.type} (url: ${channel.url || 'n/a'})`,
        { project: payload.projectName, deploymentId: payload.deploymentId },
      );
      return;
    }

    switch (channel.type) {
      case 'slack':
        await this.sendSlack(channel, payload, event);
        break;
      case 'discord':
        await this.sendDiscord(channel, payload, event);
        break;
      case 'telegram':
        await this.sendTelegram(channel, payload, event);
        break;
      case 'webhook':
        await this.sendGenericWebhook(channel, payload, event);
        break;
    }
  }

  private async sendSlack(
    channel: NormalizedNotificationChannel,
    payload: DeploymentNotificationPayload,
    event: NotificationEvent,
  ): Promise<void> {
    if (!channel.url) {
      throw new Error('Slack notification channel requires a url');
    }

    const color = event === 'success' ? '#2eb886' : event === 'rollback' ? '#ecb22e' : '#e01e5a';
    const emoji = event === 'success' ? '✅' : event === 'rollback' ? '🔄' : '❌';
    const title = `${emoji} [${payload.projectName}] Deployment #${payload.deploymentId}: ${payload.status.toUpperCase()}`;

    const durationStr = payload.durationMs ? `${(payload.durationMs / 1000).toFixed(1)}s` : 'N/A';

    const body = {
      text: title,
      attachments: [
        {
          color,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: title,
                emoji: true,
              },
            },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Project:*\n${payload.projectName}` },
                { type: 'mrkdwn', text: `*Status:*\n${payload.status}` },
                { type: 'mrkdwn', text: `*Commit SHA:*\n\`${payload.targetSha.slice(0, 10)}\`` },
                { type: 'mrkdwn', text: `*Duration:*\n${durationStr}` },
              ],
            },
            ...(payload.error
              ? [
                  {
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `*Error Details:*\n\`\`\`${payload.error.slice(0, 500)}\`\`\``,
                    },
                  },
                ]
              : []),
          ],
        },
      ],
    };

    const res = await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`Slack webhook returned HTTP ${res.status}: ${await res.text()}`);
    }
  }

  private async sendDiscord(
    channel: NormalizedNotificationChannel,
    payload: DeploymentNotificationPayload,
    event: NotificationEvent,
  ): Promise<void> {
    if (!channel.url) {
      throw new Error('Discord notification channel requires a url');
    }

    const color = event === 'success' ? 0x2ecc71 : event === 'rollback' ? 0xf1c40f : 0xe74c3c;
    const emoji = event === 'success' ? '✅' : event === 'rollback' ? '🔄' : '❌';
    const durationStr = payload.durationMs ? `${(payload.durationMs / 1000).toFixed(1)}s` : 'N/A';

    const fields = [
      { name: 'Project', value: payload.projectName, inline: true },
      { name: 'Status', value: payload.status, inline: true },
      { name: 'Commit', value: `\`${payload.targetSha.slice(0, 10)}\``, inline: true },
      { name: 'Duration', value: durationStr, inline: true },
    ];

    if (payload.error) {
      fields.push({
        name: 'Error',
        value: `\`\`\`${payload.error.slice(0, 500)}\`\`\``,
        inline: false,
      });
    }

    const body = {
      username: 'Deployra',
      embeds: [
        {
          title: `${emoji} [${payload.projectName}] Deployment #${payload.deploymentId}: ${payload.status}`,
          color,
          fields,
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const res = await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`Discord webhook returned HTTP ${res.status}: ${await res.text()}`);
    }
  }

  private async sendTelegram(
    channel: NormalizedNotificationChannel,
    payload: DeploymentNotificationPayload,
    event: NotificationEvent,
  ): Promise<void> {
    if (!channel.chatId) {
      throw new Error('Telegram notification channel requires a chatId');
    }

    const endpoint =
      channel.url ||
      (channel.token ? `https://api.telegram.org/bot${channel.token}/sendMessage` : undefined);

    if (!endpoint) {
      throw new Error('Telegram notification channel requires a token or url');
    }

    const emoji = event === 'success' ? '✅' : event === 'rollback' ? '🔄' : '❌';
    const durationStr = payload.durationMs ? `${(payload.durationMs / 1000).toFixed(1)}s` : 'N/A';

    const lines = [
      `${emoji} *Deployra Alert: ${payload.projectName}*`,
      `*Deployment:* \`#${payload.deploymentId}\``,
      `*Status:* *${payload.status}*`,
      `*Commit:* \`${payload.targetSha.slice(0, 10)}\``,
      `*Duration:* ${durationStr}`,
    ];

    if (payload.error) {
      lines.push(`*Error:* \`${payload.error.slice(0, 250)}\``);
    }

    const body = {
      chat_id: channel.chatId,
      text: lines.join('\n'),
      parse_mode: 'Markdown',
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`Telegram API returned HTTP ${res.status}: ${await res.text()}`);
    }
  }

  private async sendGenericWebhook(
    channel: NormalizedNotificationChannel,
    payload: DeploymentNotificationPayload,
    event: NotificationEvent,
  ): Promise<void> {
    if (!channel.url) {
      throw new Error('Generic webhook notification channel requires a url');
    }

    const body = {
      event: `deployment.${event}`,
      projectName: payload.projectName,
      deploymentId: payload.deploymentId,
      status: payload.status,
      targetSha: payload.targetSha,
      previousSha: payload.previousSha,
      durationMs: payload.durationMs,
      error: payload.error || null,
      triggerType: payload.triggerType,
      timestamp: Date.now(),
    };

    const res = await fetch(channel.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Deployra-Notifier/1.0',
        ...(channel.headers || {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`Generic webhook returned HTTP ${res.status}: ${await res.text()}`);
    }
  }
}
