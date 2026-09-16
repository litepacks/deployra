import fs from 'node:fs';
import net from 'node:net';
import type { IndividualCheckConfig, NormalizedDeployraConfig } from '../config/types.js';
import { ReadinessError } from '../errors/deployra-error.js';
import { parseCommandString } from '../runtime/unitup-adapter.js';
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
          try {
            const res = await fetch(check.url, {
              signal: AbortSignal.timeout(timeoutMs),
              headers: check.expect?.headers,
            });

            const expectedStatus = check.expect?.status ?? 200;
            if (res.status !== expectedStatus) {
              return {
                type: check.type,
                success: false,
                duration: Date.now() - startTime,
                error: `HTTP status ${res.status}, expected ${expectedStatus}`,
              };
            }

            if (check.expect?.bodyIncludes) {
              const body = await res.text();
              if (!body.includes(check.expect.bodyIncludes)) {
                return {
                  type: check.type,
                  success: false,
                  duration: Date.now() - startTime,
                  error: `Response body does not contain expected '${check.expect.bodyIncludes}'`,
                };
              }
            }

            return {
              type: check.type,
              success: true,
              duration: Date.now() - startTime,
            };
          } catch (err: any) {
            return {
              type: check.type,
              success: false,
              duration: Date.now() - startTime,
              error: err.message || 'Health check request failed',
            };
          }
        }

        case 'tcp': {
          return new Promise<SingleCheckResult>((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(timeoutMs);

            const cleanup = () => {
              socket.removeAllListeners();
              socket.destroy();
            };

            socket.once('connect', () => {
              const duration = Date.now() - startTime;
              cleanup();
              resolve({ type: 'tcp', success: true, duration });
            });

            socket.once('error', (err) => {
              const duration = Date.now() - startTime;
              cleanup();
              resolve({
                type: 'tcp',
                success: false,
                duration,
                error: `TCP failed to ${check.host}:${check.port} - ${err.message}`,
              });
            });

            socket.once('timeout', () => {
              const duration = Date.now() - startTime;
              cleanup();
              resolve({
                type: 'tcp',
                success: false,
                duration,
                error: `TCP connection timeout to ${check.host}:${check.port}`,
              });
            });

            socket.connect(check.port, check.host);
          });
        }

        case 'command': {
          const parsed = parseCommandString(check.command);
          const cmd = parsed.command;
          const args = parsed.args || [];
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
    const checkTimeoutMs = Math.max(intervalMs, 2000);

    while (Date.now() - startTime < timeoutMs) {
      attempts++;
      lastCheckResults = [];

      if (mode === 'sequence') {
        let sequenceSuccess = true;
        for (const check of checks) {
          const res = await this.executeCheck(check, checkTimeoutMs);
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
          checks.map((check) => this.executeCheck(check, checkTimeoutMs)),
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

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          clearTimeout(timer);
          resolve();
        }, intervalMs);
      });
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
