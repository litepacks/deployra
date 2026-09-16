import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { logger } from '../logging/logger.js';
import { ProjectRepository } from '../storage/project-repository.js';
import type { SourceWatcher } from '../watcher/source-watcher.js';

export interface WebhookServerOptions {
  port?: number;
  host?: string;
  sourceWatcher: SourceWatcher;
  dryRun?: boolean;
}

export class WebhookServer {
  private server: http.Server | null = null;
  private projectRepo = new ProjectRepository();
  private sourceWatcher: SourceWatcher;
  private port: number;
  private host: string;
  private dryRun: boolean;

  constructor(options: WebhookServerOptions) {
    this.sourceWatcher = options.sourceWatcher;
    this.port = options.port ?? 3939;
    this.host = options.host ?? '0.0.0.0';
    this.dryRun = Boolean(options.dryRun);
  }

  public getPort(): number | undefined {
    if (!this.server) return undefined;
    const addr = this.server.address();
    if (typeof addr === 'object' && addr !== null) {
      return addr.port;
    }
    return this.port;
  }

  public async start(): Promise<number> {
    if (this.server) {
      return this.getPort()!;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          logger.error(`Unhandled error in webhook server: ${err.message}`, { error: err });
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal Server Error' }));
          }
        });
      });

      const onError = (err: Error) => {
        logger.error(`Webhook server error: ${err.message}`);
        reject(err);
      };

      this.server.once('error', onError);

      this.server.listen(this.port, this.host, () => {
        this.server?.off('error', onError);
        const boundPort = this.getPort()!;
        logger.info(`Deployra Webhook Receiver listening on ${this.host}:${boundPort}`);
        resolve(boundPort);
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      const srv = this.server!;
      srv.close(() => {
        srv.removeAllListeners();
        this.server = null;
        logger.info('Deployra Webhook Receiver stopped.');
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Health check endpoint
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/api/v1/health')) {
      this.sendJson(res, 200, { status: 'ok', service: 'deployra-webhook' });
      return;
    }

    // Match /api/v1/webhook/:projectName or /webhook/:projectName
    const webhookMatch =
      pathname.match(/^\/api\/v1\/webhook\/([^/]+)$/) || pathname.match(/^\/webhook\/([^/]+)$/);

    if (req.method === 'POST' && webhookMatch) {
      const projectName = decodeURIComponent(webhookMatch[1]);
      await this.processWebhook(projectName, req, res);
      return;
    }

    this.sendJson(res, 404, { error: 'Not Found' });
  }

  private async processWebhook(
    projectName: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const project = this.projectRepo.getProject(projectName);
    if (!project) {
      this.sendJson(res, 404, { error: `Project '${projectName}' not found` });
      return;
    }

    if (project.config.webhook?.enabled === false) {
      this.sendJson(res, 403, {
        error: `Webhook trigger is disabled for project '${projectName}'`,
      });
      return;
    }

    // Read payload body with 5MB size limit
    const rawBody = await this.readBody(req);
    if (rawBody === null) {
      this.sendJson(res, 413, { error: 'Payload Too Large' });
      return;
    }

    // Verify secret if configured on project or globally
    const configuredSecret = project.config.webhook?.secret || process.env.DEPLOYRA_WEBHOOK_SECRET;

    if (configuredSecret) {
      const isValid = this.verifySignature(configuredSecret, req.headers, rawBody);
      if (!isValid) {
        logger.warn(`Rejected webhook for project '${projectName}': invalid signature or token`);
        this.sendJson(res, 401, { error: 'Invalid webhook signature or secret token' });
        return;
      }
    }

    // Handle GitHub ping event
    const githubEvent = req.headers['x-github-event'];
    if (githubEvent === 'ping') {
      logger.info(`Received GitHub ping event for project '${projectName}'`);
      this.sendJson(res, 200, { message: 'pong', project: projectName });
      return;
    }

    let payload: Record<string, any> = {};
    if (rawBody.trim().length > 0) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        this.sendJson(res, 400, { error: 'Malformed JSON payload' });
        return;
      }
    }

    // Target branch filter
    const targetBranch = project.config.webhook?.branch || project.config.source.branch;
    const ref = payload.ref as string | undefined;

    if (ref) {
      const expectedRef = `refs/heads/${targetBranch}`;
      if (ref !== expectedRef && ref !== targetBranch) {
        logger.info(
          `Webhook ignored for project '${projectName}': push ref '${ref}' does not match target branch '${targetBranch}'`,
        );
        this.sendJson(res, 200, {
          status: 'ignored',
          message: `Ignored push for branch '${ref}'. Target branch is '${targetBranch}'`,
        });
        return;
      }
    }

    // Extract target commit SHA if available
    let targetSha: string | undefined;
    if (payload.after && payload.after !== '0000000000000000000000000000000000000000') {
      targetSha = String(payload.after);
    } else if (payload.checkout_sha) {
      targetSha = String(payload.checkout_sha);
    } else if (payload.head_commit?.id) {
      targetSha = String(payload.head_commit.id);
    }

    logger.info(
      `Accepted valid webhook for project '${projectName}'${targetSha ? ` (SHA: ${targetSha})` : ''}`,
    );

    try {
      const deploymentId = await this.sourceWatcher.checkProject(
        projectName,
        'webhook',
        this.dryRun,
        targetSha,
      );

      if (deploymentId) {
        this.sendJson(res, 202, {
          status: 'enqueued',
          deploymentId,
          project: projectName,
          targetSha,
        });
      } else {
        this.sendJson(res, 200, {
          status: 'skipped',
          message: 'Deployment was skipped (already up to date or rejected by queue mode)',
          project: projectName,
        });
      }
    } catch (err: any) {
      logger.error(`Failed to trigger webhook deployment for '${projectName}': ${err.message}`);
      this.sendJson(res, 500, {
        error: `Failed to trigger deployment: ${err.message}`,
      });
    }
  }

  private verifySignature(
    secret: string,
    headers: http.IncomingHttpHeaders,
    rawBody: string,
  ): boolean {
    // 1. GitHub HMAC-SHA256 signature
    const ghSignature = headers['x-hub-signature-256'] as string | undefined;
    if (ghSignature) {
      const expectedPrefix = 'sha256=';
      if (!ghSignature.startsWith(expectedPrefix)) return false;
      const signatureHex = ghSignature.slice(expectedPrefix.length);

      const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      try {
        const sigBuffer = Buffer.from(signatureHex, 'hex');
        const hmacBuffer = Buffer.from(hmac, 'hex');
        if (sigBuffer.length !== hmacBuffer.length) return false;
        return crypto.timingSafeEqual(sigBuffer, hmacBuffer);
      } catch {
        return false;
      }
    }

    // 2. GitLab Secret Token
    const glToken = headers['x-gitlab-token'] as string | undefined;
    if (glToken) {
      try {
        const tokenBuffer = Buffer.from(glToken);
        const secretBuffer = Buffer.from(secret);
        if (tokenBuffer.length !== secretBuffer.length) return false;
        return crypto.timingSafeEqual(tokenBuffer, secretBuffer);
      } catch {
        return false;
      }
    }

    // 3. Generic Bearer Token or Custom Header
    const authHeader = headers.authorization as string | undefined;
    const customHeader = headers['x-webhook-secret'] as string | undefined;
    const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : customHeader;

    if (provided) {
      try {
        const providedBuffer = Buffer.from(provided);
        const secretBuffer = Buffer.from(secret);
        if (providedBuffer.length !== secretBuffer.length) return false;
        return crypto.timingSafeEqual(providedBuffer, secretBuffer);
      } catch {
        return false;
      }
    }

    return false;
  }

  private readBody(req: IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<string | null> {
    return new Promise((resolve) => {
      let data = '';
      let bytesRead = 0;

      const onData = (chunk: Buffer | string) => {
        bytesRead += chunk.length;
        if (bytesRead > maxBytes) {
          cleanup();
          req.destroy();
          resolve(null);
          return;
        }
        data += chunk;
      };

      const onEnd = () => {
        cleanup();
        resolve(data);
      };

      const onError = () => {
        cleanup();
        resolve(null);
      };

      const cleanup = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
      };

      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onError);
    });
  }

  private sendJson(res: ServerResponse, status: number, body: Record<string, any>): void {
    if (res.headersSent) return;
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
