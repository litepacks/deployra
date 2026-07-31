import fs from 'node:fs';
import path from 'node:path';
import parseYaml from 'yaml';
import { ConfigValidationError } from '../errors/deployra-error.js';
import { normalizeAndValidateConfig } from './schema.js';
import type { NormalizedDeployraConfig } from './types.js';

export function findConfigFile(targetPath?: string): string {
  if (targetPath) {
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) {
      throw new ConfigValidationError(`Config file not found at: '${targetPath}'`);
    }
    if (fs.statSync(resolved).isDirectory()) {
      const candidates = [
        path.join(resolved, '.deployra.json'),
        path.join(resolved, 'deployra.json'),
        path.join(resolved, 'deployra.config.yaml'),
        path.join(resolved, 'deployra.config.yml'),
        path.join(resolved, 'deployra.config.json'),
      ];
      for (const loc of candidates) {
        if (fs.existsSync(loc)) {
          return loc;
        }
      }
      throw new ConfigValidationError(
        `No configuration file (.deployra.json, deployra.config.yaml) found in directory '${targetPath}'`,
      );
    }
    return resolved;
  }

  const defaultLocations = [
    path.resolve(process.cwd(), '.deployra.json'),
    path.resolve(process.cwd(), 'deployra.json'),
    path.resolve(process.cwd(), 'deployra.config.yaml'),
    path.resolve(process.cwd(), 'deployra.config.yml'),
    path.resolve(process.cwd(), 'deployra.config.json'),
    path.resolve(process.env.HOME || '~', '.config/deployra/config.yaml'),
    '/etc/deployra/config.yaml',
  ];

  for (const loc of defaultLocations) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }

  throw new ConfigValidationError(
    'No deployra configuration file (.deployra.json, deployra.config.yaml) found in current directory or standard configuration paths.',
  );
}

export function loadConfig(configPath?: string): NormalizedDeployraConfig {
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

export function resolveProjectName(
  projectName?: string,
  cwd: string = process.cwd(),
): string | undefined {
  if (projectName && projectName.trim()) {
    return projectName.trim();
  }

  try {
    const configPath = findConfigFile(cwd);
    if (configPath) {
      const config = loadConfig(configPath);
      if (config?.project?.name) {
        return config.project.name;
      }
    }
  } catch {
    // Ignore error if no local config exists
  }

  return undefined;
}
