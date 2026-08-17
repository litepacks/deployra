import { type SpawnOptions, spawn } from 'node:child_process';
import fs from 'node:fs';
import { CommandExecutionError } from '../errors/deployra-error.js';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxBufferBytes?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Forcefully terminates an entire process tree using process groups on POSIX systems.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fallback to direct PID kill if group kill fails (e.g. ESRCH)
      }
    }
    process.kill(pid, signal);
  } catch {
    // Process might already have exited
  }
}

export async function safeExec(
  file: string,
  args: string[] = [],
  options: ExecOptions = {},
): Promise<ExecResult> {
  if (options.cwd && !fs.existsSync(options.cwd)) {
    throw new CommandExecutionError(`Working directory does not exist: '${options.cwd}'`);
  }

  if (options.signal?.aborted) {
    throw new CommandExecutionError(
      `Command '${file}' aborted before execution: ${options.signal.reason || 'Aborted'}`,
      130,
    );
  }

  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 600000; // default 10 minutes
  const maxBuffer = options.maxBufferBytes ?? 10 * 1024 * 1024; // default 10MB
  const isPosix = process.platform !== 'win32';

  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false, // Prevents shell injection by avoiding shell execution
      detached: isPosix, // Creates a new process group on POSIX so child + subchildren can be killed cleanly
    };

    const child = spawn(file, args, spawnOptions);
    const pid = child.pid;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedByTimeout = false;
    let killedBySignal = false;

    let timer: NodeJS.Timeout | null = null;
    let escalationTimer: NodeJS.Timeout | null = null;

    const cleanupTimers = () => {
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      timer = null;
      escalationTimer = null;
    };

    const terminateChildTree = (reason: 'timeout' | 'abort') => {
      if (!pid) return;
      if (reason === 'timeout') killedByTimeout = true;
      if (reason === 'abort') killedBySignal = true;

      // Send SIGTERM to entire process tree
      killProcessTree(pid, 'SIGTERM');

      // Escalate to SIGKILL after 1 second if processes are still lingering
      escalationTimer = setTimeout(() => {
        killProcessTree(pid, 'SIGKILL');
      }, 1000);
    };

    let abortHandler: (() => void) | null = null;
    if (options.signal) {
      abortHandler = () => {
        terminateChildTree('abort');
      };
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        terminateChildTree('timeout');
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) {
        stdoutChunks.push(chunk);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) {
        stderrChunks.push(chunk);
      }
    });

    child.on('error', (err) => {
      cleanupTimers();
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      if (pid) {
        killProcessTree(pid, 'SIGKILL');
      }
      reject(new CommandExecutionError(`Failed to start command '${file}': ${err.message}`));
    });

    child.on('close', (code) => {
      cleanupTimers();
      if (abortHandler && options.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }

      // Ensure no orphaned subprocesses linger after parent exits abnormally
      if ((code !== 0 || killedByTimeout || killedBySignal) && pid) {
        killProcessTree(pid, 'SIGKILL');
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      const durationMs = Date.now() - startTime;
      const exitCode = code ?? (killedByTimeout ? 124 : killedBySignal ? 130 : 1);

      if (killedBySignal) {
        reject(
          new CommandExecutionError(
            `Command '${file}' was cancelled/aborted`,
            exitCode,
            stderr || stdout,
          ),
        );
        return;
      }

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
