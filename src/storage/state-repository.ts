import { sanitizeProjectName } from '../config/schema.js';
import { getDatabase } from './database.js';

export class StateRepository {
  public acquireLock(rawProjectName: string, lockedBy: string, timeoutMs = 900000): boolean {
    const projectName = sanitizeProjectName(rawProjectName);
    const db = getDatabase();
    const now = Date.now();

    const existing = db
      .prepare(`SELECT * FROM project_locks WHERE project_name = ? OR project_name = ?`)
      .get(projectName, rawProjectName) as any;

    if (existing) {
      if (existing.locked_by === lockedBy) {
        return true;
      }

      const lockAge = now - (existing.locked_at || 0);

      const lockHolderDep = db
        .prepare(`SELECT status FROM deployments WHERE id = ?`)
        .get(existing.locked_by) as any;

      const isHolderActive =
        !lockHolderDep || ['queued', 'running', 'rolling_back'].includes(lockHolderDep.status);

      if (lockAge > timeoutMs || !isHolderActive) {
        db.prepare(`DELETE FROM project_locks WHERE project_name = ? OR project_name = ?`).run(
          projectName,
          rawProjectName,
        );
      } else {
        return false;
      }
    }

    try {
      db.prepare(`
        INSERT INTO project_locks (project_name, locked_by, locked_at)
        VALUES (?, ?, ?)
      `).run(projectName, lockedBy, now);
      return true;
    } catch {
      return false;
    }
  }

  public releaseLock(rawProjectName: string, lockedBy?: string): boolean {
    const projectName = sanitizeProjectName(rawProjectName);
    const db = getDatabase();
    if (lockedBy) {
      const res = db
        .prepare(
          `DELETE FROM project_locks WHERE (project_name = ? OR project_name = ?) AND locked_by = ?`,
        )
        .run(projectName, rawProjectName, lockedBy);
      return res.changes > 0;
    }
    const res = db
      .prepare(`DELETE FROM project_locks WHERE project_name = ? OR project_name = ?`)
      .run(projectName, rawProjectName);
    return res.changes > 0;
  }

  public isLocked(rawProjectName: string): boolean {
    const projectName = sanitizeProjectName(rawProjectName);
    const db = getDatabase();
    const row = db
      .prepare(`SELECT * FROM project_locks WHERE project_name = ? OR project_name = ?`)
      .get(projectName, rawProjectName);
    return !!row;
  }

  public getLockInfo(rawProjectName: string): { lockedBy: string; lockedAt: number } | null {
    const projectName = sanitizeProjectName(rawProjectName);
    const db = getDatabase();
    const row = db
      .prepare(`SELECT * FROM project_locks WHERE project_name = ? OR project_name = ?`)
      .get(projectName, rawProjectName) as any;
    if (!row) return null;
    return {
      lockedBy: row.locked_by,
      lockedAt: row.locked_at,
    };
  }

  public clearAllLocks(): void {
    const db = getDatabase();
    db.prepare(`DELETE FROM project_locks`).run();
  }
}
