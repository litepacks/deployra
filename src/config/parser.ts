import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import parseYaml from 'yaml';
import { ConfigValidationError } from '../errors/deployra-error.js';
import { normalizeAndValidateConfig } from './schema.js';
import type { NormalizedDeployraConfig } from './types.js';

export function computeConfigHash(config: NormalizedDeployraConfig | object): string {
  const { configHash, configVersion, ...rest } = config as any;
  const jsonStr = JSON.stringify(rest);
  return `cfg_${crypto.createHash('sha256').update(jsonStr).digest('hex').slice(0, 12)}`;
}

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

function isPlainObject(item: any): boolean {
  return Boolean(item && typeof item === 'object' && !Array.isArray(item));
}

export function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Record<string, any>,
): T {
  const output = { ...target };
  if (isPlainObject(target) && isPlainObject(source)) {
    for (const key of Object.keys(source)) {
      if (isPlainObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          (output as any)[key] = deepMerge((target as any)[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    }
  }
  return output;
}

export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const result: Record<string, string> = {};
  const lines = content.split('\n');

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) {
      line = line.slice(7).trim();
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();

    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    val = val.replace(
      /\${([a-zA-Z0-9_]+)(?::-([^}]*))?}|\$([a-zA-Z0-9_]+)/g,
      (_, p1, defVal, p2) => {
        const varName = p1 || p2;
        const envVal = process.env[varName];
        if (envVal !== undefined && envVal !== '') {
          return envVal;
        }
        if (defVal !== undefined) {
          return defVal;
        }
        return envVal || '';
      },
    );

    if (key) {
      result[key] = val;
    }
  }

  return result;
}

export function loadConfig(
  configPath?: string,
  environmentName?: string,
): NormalizedDeployraConfig {
  const envName = environmentName || process.env.DEPLOYRA_ENV;
  const filePath = findConfigFile(configPath);
  const content = fs.readFileSync(filePath, 'utf-8');

  let parsed: any;
  try {
    if (filePath.endsWith('.json')) {
      parsed = JSON.parse(content);
    } else {
      parsed = parseYaml.parse(content);
    }
  } catch (err: any) {
    throw new ConfigValidationError(`Failed to parse config file '${filePath}': ${err.message}`);
  }

  if (envName && parsed && isPlainObject(parsed.environments) && parsed.environments[envName]) {
    const envOverrides = parsed.environments[envName];
    parsed = deepMerge(parsed, envOverrides);
  }

  const normalized = normalizeAndValidateConfig(parsed);
  if (envName) {
    normalized.environment = envName;
  }
  normalized.configHash = computeConfigHash(normalized);
  return normalized;
}

export function loadConfigFromDir(
  dirPath: string,
  environmentName?: string,
): NormalizedDeployraConfig | null {
  try {
    const configPath = findConfigFile(dirPath);
    if (configPath) {
      return loadConfig(configPath, environmentName);
    }
  } catch {
    // Config not found or invalid
  }
  return null;
}

export function resolveProjectName(
  projectName?: string,
  cwd: string = process.cwd(),
): string | undefined {
  if (projectName?.trim()) {
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
