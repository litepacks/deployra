declare module 'ready-checker' {
  export interface HealthCheckOptions {
    health?: string;
    timeout?: number;
    retries?: number;
    retryDelay?: number;
    onRetry?: (attempt: number, maxAttempts: number, retryDelay: number) => void;
  }

  export interface HealthCheckResult {
    success: boolean;
    statusCode: number | null;
    elapsed: number;
    attempts: number;
    error?: string;
    port?: number;
  }

  export function performHealthCheck(
    url: string,
    options: HealthCheckOptions,
  ): Promise<HealthCheckResult>;
  export function checkServer(
    filePath: string,
    options?: HealthCheckOptions,
  ): Promise<HealthCheckResult>;
}
