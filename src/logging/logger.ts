import chalk from 'chalk';
import { maskSecrets } from './masker.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFormat = 'pretty' | 'json' | 'jsonl';

export const LOG_LEVEL_PRIORITIES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function resolveDefaultLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  if (envLevel && envLevel in LOG_LEVEL_PRIORITIES) {
    return envLevel;
  }
  if (process.env.DEBUG === 'true' || process.env.DEBUG === '1') {
    return 'debug';
  }
  // Default to 'info' in systemd or standard daemon environments to prevent journal log flooding
  return 'info';
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  project?: string;
  deploymentId?: string;
  step?: string;
  message: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

export class Logger {
  private format: LogFormat;
  private level: LogLevel;

  constructor(format: LogFormat = 'pretty', level?: LogLevel) {
    this.format = format;
    this.level = level || resolveDefaultLogLevel();
  }

  public setFormat(format: LogFormat): void {
    this.format = format;
  }

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public getLevel(): LogLevel {
    return this.level;
  }

  public log(entry: Omit<LogEntry, 'timestamp'>): void {
    const currentPriority = LOG_LEVEL_PRIORITIES[this.level] ?? 1;
    const entryPriority = LOG_LEVEL_PRIORITIES[entry.level] ?? 1;
    if (entryPriority < currentPriority) {
      return;
    }

    const timestamp = new Date().toISOString();
    const fullEntry: LogEntry = {
      level: entry.level,
      timestamp,
      project: entry.project,
      deploymentId: entry.deploymentId,
      step: entry.step,
      durationMs: entry.durationMs,
      message: maskSecrets(String(entry.message || '')),
      meta: entry.meta,
    };

    if (this.format === 'json' || this.format === 'jsonl') {
      const line = JSON.stringify(fullEntry);
      if (entry.level === 'error') {
        console.error(line);
      } else {
        console.log(line);
      }
      return;
    }

    // Pretty console format
    const timeStr = chalk.gray(`[${timestamp}]`);
    let levelStr = '';
    switch (entry.level) {
      case 'debug':
        levelStr = chalk.magenta('[DEBUG]');
        break;
      case 'info':
        levelStr = chalk.blue('[INFO]');
        break;
      case 'warn':
        levelStr = chalk.yellow('[WARN]');
        break;
      case 'error':
        levelStr = chalk.red('[ERROR]');
        break;
      default:
        levelStr = chalk.gray(`[${entry.level.toUpperCase()}]`);
        break;
    }

    const project = entry.project || (entry.meta?.project as string | undefined);
    const deploymentId = entry.deploymentId || (entry.meta?.deploymentId as string | undefined);
    const step = entry.step || (entry.meta?.step as string | undefined);
    const durationMs =
      entry.durationMs !== undefined
        ? entry.durationMs
        : (entry.meta?.durationMs as number | undefined);

    const projectStr = project ? chalk.cyan(`[${project}]`) : '';
    const depStr = deploymentId ? chalk.dim(`(#${deploymentId})`) : '';
    const stepStr = step ? chalk.bold(`[${step}]`) : '';
    const durationStr = durationMs !== undefined ? chalk.gray(`(${durationMs}ms)`) : '';

    const line = [timeStr, levelStr, projectStr, depStr, stepStr, fullEntry.message, durationStr]
      .filter(Boolean)
      .join(' ');

    if (entry.level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  public debug(message: string, meta: Record<string, unknown> = {}): void {
    this.log({ level: 'debug', message, meta });
  }

  public info(message: string, meta: Record<string, unknown> = {}): void {
    this.log({ level: 'info', message, meta });
  }

  public warn(message: string, meta: Record<string, unknown> = {}): void {
    this.log({ level: 'warn', message, meta });
  }

  public error(message: string, meta: Record<string, unknown> = {}): void {
    this.log({ level: 'error', message, meta });
  }
}

export const logger = new Logger('pretty');
