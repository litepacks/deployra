import chalk from 'chalk';
import { maskSecrets } from './masker.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'pretty' | 'json' | 'jsonl';

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

  constructor(format: LogFormat = 'pretty') {
    this.format = format;
  }

  public setFormat(format: LogFormat): void {
    this.format = format;
  }

  public log(entry: Omit<LogEntry, 'timestamp'>): void {
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
    }

    const projectStr = entry.project ? chalk.cyan(`[${entry.project}]`) : '';
    const depStr = entry.deploymentId ? chalk.dim(`(#${entry.deploymentId})`) : '';
    const stepStr = entry.step ? chalk.bold(`[${entry.step}]`) : '';
    const durationStr = entry.durationMs !== undefined ? chalk.gray(`(${entry.durationMs}ms)`) : '';

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
