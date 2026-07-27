import fs from 'node:fs';
import path from 'node:path';
import parseYaml from 'yaml';
import { normalizeAndValidateConfig } from './schema.js';
import { ConfigValidationError } from '../errors/gitship-error.js';
import type { NormalizedGitshipConfig } from './types.js';

export function findConfigFile(targetPath?: string): string {
  if (targetPath) {
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) {
      throw new ConfigValidationError(`Config file not found at: '${targetPath}'`);
    }
    return resolved;
  }

  const defaultLocations = [
    path.resolve(process.cwd(), 'gitship.config.yaml'),
    path.resolve(process.cwd(), 'gitship.config.yml'),
    path.resolve(process.cwd(), 'gitship.config.json'),
    path.resolve(process.env.HOME || '~', '.config/gitship/config.yaml'),
    '/etc/gitship/config.yaml',
  ];

  for (const loc of defaultLocations) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }

  throw new ConfigValidationError(
    'No gitship.config.yaml file found in current directory or standard configuration paths.',
  );
}

export function loadConfig(configPath?: string): NormalizedGitshipConfig {
  const filePath = findConfigFile(configPath);
  const content = fs.readFileSync(filePath, 'utf-8');

  let parsed: unknown;
  try {
    if (filePath.endsWith('.json')) {
      parsed = JSON.parse(content);
    } else {
      parsed = parseYaml.parse(content);
    }
  } catch (err: any) {
    throw new ConfigValidationError(`Failed to parse config file '${filePath}': ${err.message}`);
  }

  return normalizeAndValidateConfig(parsed);
}
