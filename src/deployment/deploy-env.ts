import fs from 'node:fs';
import path from 'node:path';
import { parseEnvFile } from '../config/parser.js';
import type { NormalizedDeployraConfig } from '../config/types.js';
import { registerSecrets } from '../logging/masker.js';

function resolveEnvFilePath(
  config: NormalizedDeployraConfig,
  preferredDir: string,
): string | undefined {
  const envFile = config.deploy.envFile;
  if (!envFile) return undefined;
  if (path.isAbsolute(envFile)) return envFile;
  const candidateInPreferred = path.resolve(preferredDir, envFile);
  const candidateInProject = path.resolve(config.project.path, envFile);
  return fs.existsSync(candidateInPreferred) ? candidateInPreferred : candidateInProject;
}

/**
 * Merges deploy.envFile and deploy.env (inline wins) for build/install commands.
 * All values are registered with the secret masker so they never reach the logs.
 */
export function resolveDeploymentEnv(
  workingDir: string,
  config: NormalizedDeployraConfig,
): Record<string, string> {
  const envFilePath = resolveEnvFilePath(config, workingDir);
  const fileEnv = envFilePath ? parseEnvFile(envFilePath) : {};
  const merged = { ...fileEnv, ...config.deploy.env };
  registerSecrets(merged);
  return merged;
}

/**
 * Environment for deployment commands (install, build, rollback rebuilds).
 */
export function buildCommandEnv(env: Record<string, string>): Record<string, string> {
  return {
    CI: 'true',
    FORCE_COLOR: '0',
    ...env,
  };
}

/**
 * Runtime environment handed to the managed service: inline deploy.env values plus the
 * absolute envFile path, which systemd loads itself so file secrets are not copied into
 * the unit file.
 */
export function resolveServiceEnv(
  config: NormalizedDeployraConfig,
  serviceCwd: string,
): { env?: Record<string, string>; envFile?: string } {
  const env = Object.keys(config.deploy.env).length > 0 ? { ...config.deploy.env } : undefined;
  const envFilePath = resolveEnvFilePath(config, serviceCwd);
  const envFile = envFilePath && fs.existsSync(envFilePath) ? envFilePath : undefined;
  return { env, envFile };
}
