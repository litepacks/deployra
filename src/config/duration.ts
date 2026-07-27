/**
 * Parses duration strings like '500ms', '30s', '5m', '1h' into milliseconds.
 */
export function parseDurationMs(duration: string | number): number {
  if (typeof duration === 'number') {
    return duration;
  }

  const trimmed = duration.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!match) {
    throw new Error(
      `Invalid duration format: '${duration}'. Expected formats like '500ms', '30s', '5m', '1h'.`,
    );
  }

  const val = parseFloat(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();

  switch (unit) {
    case 'ms':
      return Math.round(val);
    case 's':
      return Math.round(val * 1000);
    case 'm':
      return Math.round(val * 60 * 1000);
    case 'h':
      return Math.round(val * 60 * 60 * 1000);
    case 'd':
      return Math.round(val * 24 * 60 * 60 * 1000);
    default:
      return Math.round(val);
  }
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`.replace(/\.0s$/, 's');
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`.replace(/\.0m$/, 'm');
  return `${(ms / 3600000).toFixed(1)}h`.replace(/\.0h$/, 'h');
}
