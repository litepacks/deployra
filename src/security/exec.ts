import { type SpawnOptions, spawn } from 'node:child_process';
import fs from 'node:fs';
import { CommandExecutionError } from '../errors/deployra-error.js';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export async function safeExec(
  file: string,
  args: string[] = [],
  options: ExecOptions = {},
): Promise<ExecResult> {
  if (options.cwd && !fs.existsSync(options.cwd)) {
    throw new CommandExecutionError(`Working directory does not exist: '${options.cwd}'`);
  }

  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 600000; // default 10 minutes
  const maxBuffer = options.maxBufferBytes ?? 10 * 1024 * 1024; // default 10MB

  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false, // Prevents shell injection by avoiding shell execution
    };

    const child = spawn(file, args, spawnOptions);

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedByTimeout = false;

    let timer: NodeJS.Timeout | null = null;
    let escalationTimer: NodeJS.Timeout | null = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killedByTimeout = true;
        try {
          child.kill('SIGINT');
        } catch {
          // Ignore
        }
        // Escalate to SIGTERM after 2 seconds
        escalationTimer = setTimeout(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            // Ignore
          }
          // Escalate to SIGKILL after another 2 seconds
          setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // Ignore
            }
          }, 2000);
        }, 2000);
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) {
        stdout += chunk.toString('utf-8');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) {
        stderr += chunk.toString('utf-8');
      }
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      reject(new CommandExecutionError(`Failed to start command '${file}': ${err.message}`));
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);

      const durationMs = Date.now() - startTime;
      const exitCode = code ?? (killedByTimeout ? 124 : 1);

      if (killedByTimeout) {
        reject(
          new CommandExecutionError(
            `Command '${file}' timed out after ${timeoutMs}ms`,
            exitCode,
            stderr,
          ),
        );
        return;
      }

      if (exitCode !== 0) {
        const rawOutput = (stderr || stdout).trim();
        const outputSnippet = rawOutput
          ? `\n   Output:\n   ${rawOutput.slice(-1000).replace(/\n/g, '\n   ')}`
          : '';
        const cmdString = `${file}${args.length > 0 ? ` ${args.join(' ')}` : ''}`;
        reject(
          new CommandExecutionError(
            `Command '${cmdString}' failed with exit code ${exitCode}${outputSnippet}`,
            exitCode,
            stderr || stdout,
          ),
        );
        return;
      }

      resolve({
        stdout,
        stderr,
        exitCode,
        durationMs,
      });
    });
  });
}
