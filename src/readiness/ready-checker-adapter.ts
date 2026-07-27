import fs from 'node:fs';
import net from 'node:net';
import { performHealthCheck } from 'ready-checker';
import type { IndividualCheckConfig, NormalizedDeployraConfig } from '../config/types.js';
import { ReadinessError } from '../errors/deployra-error.js';
import { safeExec } from '../security/exec.js';

export interface SingleCheckResult {
  type: string;
  success: boolean;
  duration: number;
  error?: string;
}

export interface ReadyCheckResult {
  ready: boolean;
  attempts: number;
  duration: number;
  checks: Array<{
    type: string;
    success: boolean;
    duration: number;
    error?: string;
  }>;
}

export class ReadyCheckerAdapter {
  private async executeCheck(
    check: IndividualCheckConfig,
    timeoutMs: number,
  ): Promise<SingleCheckResult> {
    const startTime = Date.now();

    try {
      switch (check.type) {
        case 'http':
        case 'https': {
          // Delegate HTTP/HTTPS health checks directly to ready-checker package
          const res = await performHealthCheck(check.url, {
            timeout: timeoutMs,
            retries: 0,
            retryDelay: 500,
          });

          return {
            type: check.type,
            success: res.success,
            duration: res.elapsed || Date.now() - startTime,
            error: res.error,
          };
        }

        case 'tcp': {
          return new Promise<SingleCheckResult>((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(timeoutMs);

            socket.connect(check.port, check.host, () => {
              const duration = Date.now() - startTime;
              socket.destroy();
              resolve({ type: 'tcp', success: true, duration });
            });

            socket.on('error', (err) => {
              socket.destroy();
              resolve({
                type: 'tcp',
                success: false,
                duration: Date.now() - startTime,
                error: `TCP failed to ${check.host}:${check.port} - ${err.message}`,
              });
            });

            socket.on('timeout', () => {
              socket.destroy();
              resolve({
                type: 'tcp',
                success: false,
                duration: Date.now() - startTime,
                error: `TCP connection timeout to ${check.host}:${check.port}`,
              });
            });
          });
        }

        case 'command': {
          const parts = check.command.split(' ');
          const cmd = parts[0];
          const args = parts.slice(1);
          const expectedExitCode = check.expectedExitCode ?? 0;

          try {
            const res = await safeExec(cmd, args, { timeoutMs });
            const duration = Date.now() - startTime;
            if (res.exitCode === expectedExitCode) {
              return { type: 'command', success: true, duration };
            }
            return {
              type: 'command',
              success: false,
              duration,
              error: `Command exit code ${res.exitCode}, expected ${expectedExitCode}`,
            };
          } catch (err: any) {
            return {
              type: 'command',
              success: false,
              duration: Date.now() - startTime,
              error: err.message,
            };
          }
        }

        case 'process': {
          if (check.pidFile) {
            const exists = fs.existsSync(check.pidFile);
            return {
              type: 'process',
              success: exists,
              duration: Date.now() - startTime,
              error: exists ? undefined : `PID file '${check.pidFile}' not found`,
            };
          }
          return { type: 'process', success: true, duration: Date.now() - startTime };
        }

        case 'file': {
          const exists = fs.existsSync(check.path);
          return {
            type: 'file',
            success: exists,
            duration: Date.now() - startTime,
            error: exists ? undefined : `File '${check.path}' not found`,
          };
        }
      }
    } catch (err: any) {
      return {
        type: (check as any).type || 'unknown',
        success: false,
        duration: Date.now() - startTime,
        error: err.message,
      };
    }
  }

  public async wait(
    readyConfig: NormalizedDeployraConfig['deploy']['ready'],
  ): Promise<ReadyCheckResult> {
    const startTime = Date.now();
    const { timeoutMs, intervalMs, mode, checks } = readyConfig;

    if (!checks || checks.length === 0) {
      return {
        ready: true,
        attempts: 1,
        duration: 0,
        checks: [],
      };
    }

    let attempts = 0;
    let lastCheckResults: SingleCheckResult[] = [];

    while (Date.now() - startTime < timeoutMs) {
      attempts++;
      lastCheckResults = [];

      if (mode === 'sequence') {
        let sequenceSuccess = true;
        for (const check of checks) {
          const res = await this.executeCheck(check, intervalMs);
          lastCheckResults.push(res);
          if (!res.success) {
            sequenceSuccess = false;
            break;
          }
        }
        if (sequenceSuccess) {
          return {
            ready: true,
            attempts,
            duration: Date.now() - startTime,
            checks: lastCheckResults,
          };
        }
      } else {
        lastCheckResults = await Promise.all(
          checks.map((check) => this.executeCheck(check, intervalMs)),
        );

        if (mode === 'all') {
          const allOk = lastCheckResults.every((c) => c.success);
          if (allOk) {
            return {
              ready: true,
              attempts,
              duration: Date.now() - startTime,
              checks: lastCheckResults,
            };
          }
        } else if (mode === 'any') {
          const anyOk = lastCheckResults.some((c) => c.success);
          if (anyOk) {
            return {
              ready: true,
              attempts,
              duration: Date.now() - startTime,
              checks: lastCheckResults,
            };
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    const failedChecks = lastCheckResults.filter((c) => !c.success);
    const errorMsg = failedChecks.map((c) => `[${c.type}]: ${c.error || 'Failed'}`).join('; ');

    const finalResult: ReadyCheckResult = {
      ready: false,
      attempts,
      duration: Date.now() - startTime,
      checks: lastCheckResults,
    };

    throw new ReadinessError(
      `Ready-check failed after ${attempts} attempts (${finalResult.duration}ms). Failures: ${errorMsg}`,
    );
  }
}
