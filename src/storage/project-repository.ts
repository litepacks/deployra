import { computeConfigHash } from '../config/parser.js';
import { isUrlLike, sanitizeProjectName } from '../config/schema.js';
import type { NormalizedDeployraConfig } from '../config/types.js';
import { getDatabase } from './database.js';

export interface StoredProject {
  name: string;
  path: string;
  remote: string;
  branch: string;
  lastSeenSha?: string;
  lastSuccessfulSha?: string;
  config: NormalizedDeployraConfig;
  configHash: string;
  configVersion: number;
  updatedAt: number;
}

export class ProjectRepository {
  public cleanupLegacyUrlProjects(): void {
    try {
      const db = getDatabase();
      const rows = db.prepare(`SELECT name FROM projects`).all() as any[];
      for (const row of rows) {
        if (isUrlLike(row.name) || /[/:\\]/.test(row.name)) {
          db.prepare(`DELETE FROM projects WHERE name = ?`).run(row.name);
        }
      }
    } catch {
      // Ignore database errors during cleanup
    }
  }

  public saveProject(config: NormalizedDeployraConfig): StoredProject {
    this.cleanupLegacyUrlProjects();
    const db = getDatabase();
    const now = Date.now();

    const computedHash = config.configHash || computeConfigHash(config);
    const existing = this.getProject(config.project.name);

    let newVersion = 1;
    if (existing) {
      if (existing.configHash && existing.configHash !== computedHash) {
        newVersion = (existing.configVersion || 1) + 1;
      } else {
        newVersion = existing.configVersion || 1;
      }
    }

    config.configHash = computedHash;
    config.configVersion = newVersion;

    const stmt = db.prepare(`
      INSERT INTO projects (name, path, remote, branch, config_json, config_hash, config_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        path = excluded.path,
        remote = excluded.remote,
        branch = excluded.branch,
        config_json = excluded.config_json,
        config_hash = excluded.config_hash,
        config_version = excluded.config_version,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      config.project.name,
      config.project.path,
      config.source.remote,
      config.source.branch,
      JSON.stringify(config),
      computedHash,
      newVersion,
      now,
    );

    return this.getProject(config.project.name)!;
  }

  public getProject(name: string): StoredProject | null {
    const db = getDatabase();
    const sanitized = sanitizeProjectName(name);
    let row = db.prepare(`SELECT * FROM projects WHERE name = ?`).get(sanitized) as any;
    if (!row) {
      row = db.prepare(`SELECT * FROM projects WHERE name = ?`).get(name) as any;
    }
    if (!row) return null;

    const parsedConfig = JSON.parse(row.config_json) as NormalizedDeployraConfig;
    const hash = row.config_hash || parsedConfig.configHash || computeConfigHash(parsedConfig);
    const version = row.config_version || parsedConfig.configVersion || 1;

    parsedConfig.configHash = hash;
    parsedConfig.configVersion = version;

    return {
      name: row.name,
      path: row.path,
      remote: row.remote,
      branch: row.branch,
      lastSeenSha: row.last_seen_sha || undefined,
      lastSuccessfulSha: row.last_successful_sha || undefined,
      config: parsedConfig,
      configHash: hash,
      configVersion: version,
      updatedAt: row.updated_at,
    };
  }

  public getAllProjects(): StoredProject[] {
    this.cleanupLegacyUrlProjects();
    const db = getDatabase();
    const rows = db.prepare(`SELECT * FROM projects ORDER BY name ASC`).all() as any[];
    return rows.map((row) => {
      const parsedConfig = JSON.parse(row.config_json) as NormalizedDeployraConfig;
      const hash = row.config_hash || parsedConfig.configHash || computeConfigHash(parsedConfig);
      const version = row.config_version || parsedConfig.configVersion || 1;

      parsedConfig.configHash = hash;
      parsedConfig.configVersion = version;

      return {
        name: row.name,
        path: row.path,
        remote: row.remote,
        branch: row.branch,
        lastSeenSha: row.last_seen_sha || undefined,
        lastSuccessfulSha: row.last_successful_sha || undefined,
        config: parsedConfig,
        configHash: hash,
        configVersion: version,
        updatedAt: row.updated_at,
      };
    });
  }

  public deleteProject(name: string): boolean {
    this.cleanupLegacyUrlProjects();
    const db = getDatabase();
    const sanitized = sanitizeProjectName(name);
    const result = db
      .prepare(`DELETE FROM projects WHERE name = ? OR name = ?`)
      .run(name, sanitized);
    return result.changes > 0;
  }

  public updateLastSeenSha(name: string, sha: string): void {
    const db = getDatabase();
    const sanitized = sanitizeProjectName(name);
    db.prepare(
      `UPDATE projects SET last_seen_sha = ?, updated_at = ? WHERE name = ? OR name = ?`,
    ).run(sha, Date.now(), name, sanitized);
  }

  public updateLastSuccessfulSha(name: string, sha: string): void {
    const db = getDatabase();
    const sanitized = sanitizeProjectName(name);
    db.prepare(
      `UPDATE projects SET last_successful_sha = ?, last_seen_sha = ?, updated_at = ? WHERE name = ? OR name = ?`,
    ).run(sha, sha, Date.now(), name, sanitized);
  }
}
