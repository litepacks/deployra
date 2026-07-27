import { getDatabase } from './database.js';
import type { NormalizedGitshipConfig } from '../config/types.js';

export interface StoredProject {
  name: string;
  path: string;
  remote: string;
  branch: string;
  lastSeenSha?: string;
  lastSuccessfulSha?: string;
  config: NormalizedGitshipConfig;
  updatedAt: number;
}

export class ProjectRepository {
  public saveProject(config: NormalizedGitshipConfig): StoredProject {
    const db = getDatabase();
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO projects (name, path, remote, branch, config_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        path = excluded.path,
        remote = excluded.remote,
        branch = excluded.branch,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      config.project.name,
      config.project.path,
      config.source.remote,
      config.source.branch,
      JSON.stringify(config),
      now,
    );

    return this.getProject(config.project.name)!;
  }

  public getProject(name: string): StoredProject | null {
    const db = getDatabase();
    const row = db.prepare(`SELECT * FROM projects WHERE name = ?`).get(name) as any;
    if (!row) return null;

    return {
      name: row.name,
      path: row.path,
      remote: row.remote,
      branch: row.branch,
      lastSeenSha: row.last_seen_sha || undefined,
      lastSuccessfulSha: row.last_successful_sha || undefined,
      config: JSON.parse(row.config_json),
      updatedAt: row.updated_at,
    };
  }

  public getAllProjects(): StoredProject[] {
    const db = getDatabase();
    const rows = db.prepare(`SELECT * FROM projects ORDER BY name ASC`).all() as any[];
    return rows.map((row) => ({
      name: row.name,
      path: row.path,
      remote: row.remote,
      branch: row.branch,
      lastSeenSha: row.last_seen_sha || undefined,
      lastSuccessfulSha: row.last_successful_sha || undefined,
      config: JSON.parse(row.config_json),
      updatedAt: row.updated_at,
    }));
  }

  public deleteProject(name: string): boolean {
    const db = getDatabase();
    const result = db.prepare(`DELETE FROM projects WHERE name = ?`).run(name);
    return result.changes > 0;
  }

  public updateLastSeenSha(name: string, sha: string): void {
    const db = getDatabase();
    db.prepare(`UPDATE projects SET last_seen_sha = ?, updated_at = ? WHERE name = ?`).run(
      sha,
      Date.now(),
      name,
    );
  }

  public updateLastSuccessfulSha(name: string, sha: string): void {
    const db = getDatabase();
    db.prepare(
      `UPDATE projects SET last_successful_sha = ?, last_seen_sha = ?, updated_at = ? WHERE name = ?`,
    ).run(sha, sha, Date.now(), name);
  }
}
