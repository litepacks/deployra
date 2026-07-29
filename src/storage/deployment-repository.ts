import { getDatabase } from './database.js';

export type DeploymentStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'rolling_back'
  | 'rolled_back'
  | 'rollback_failed';

export interface DeploymentStep {
  id: string;
  deploymentId: string;
  stepName: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
  startedAt?: number;
  completedAt?: number;
  duration?: number;
  exitCode?: number;
  error?: string;
}

export interface DeploymentRecord {
  id: string;
  projectName: string;
  previousSha?: string;
  targetSha: string;
  status: DeploymentStatus;
  triggerType: 'poll' | 'manual' | 'webhook';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  steps: DeploymentStep[];
  readyCheck?: any;
  error?: string;
}

export class DeploymentRepository {
  public createDeployment(data: {
    id: string;
    projectName: string;
    previousSha?: string;
    targetSha: string;
    status?: DeploymentStatus;
    triggerType: 'poll' | 'manual' | 'webhook';
    steps?: string[];
  }): DeploymentRecord {
    const db = getDatabase();
    const createdAt = Date.now();
    const status = data.status || 'queued';

    db.prepare(`
      INSERT INTO deployments (id, project_name, previous_sha, target_sha, status, trigger_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.id,
      data.projectName,
      data.previousSha || null,
      data.targetSha,
      status,
      data.triggerType,
      createdAt,
    );

    const defaultSteps = data.steps || [
      'acquire-lock',
      'validate-repository',
      'fetch',
      'resolve-target',
      'prepare',
      'install',
      'build',
      'service-action',
      'ready-check',
      'complete',
      'release-lock',
    ];

    const insertStep = db.prepare(`
      INSERT INTO deployment_steps (id, deployment_id, step_name, status)
      VALUES (?, ?, ?, 'pending')
    `);

    for (const stepName of defaultSteps) {
      insertStep.run(`${data.id}_${stepName}`, data.id, stepName);
    }

    return this.getDeployment(data.id)!;
  }

  public updateStatus(id: string, status: DeploymentStatus, error?: string): void {
    const db = getDatabase();
    const now = Date.now();

    if (status === 'running') {
      db.prepare(`UPDATE deployments SET status = ?, started_at = ? WHERE id = ?`).run(
        status,
        now,
        id,
      );
    } else if (
      ['success', 'failed', 'cancelled', 'rolled_back', 'rollback_failed'].includes(status)
    ) {
      db.prepare(`UPDATE deployments SET status = ?, completed_at = ?, error = ? WHERE id = ?`).run(
        status,
        now,
        error || null,
        id,
      );
    } else {
      db.prepare(`UPDATE deployments SET status = ?, error = ? WHERE id = ?`).run(
        status,
        error || null,
        id,
      );
    }
  }

  public updateStep(
    deploymentId: string,
    stepName: string,
    update: {
      status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
      startedAt?: number;
      completedAt?: number;
      duration?: number;
      exitCode?: number;
      error?: string;
    },
  ): void {
    const db = getDatabase();
    const stepId = `${deploymentId}_${stepName}`;

    db.prepare(`
      UPDATE deployment_steps
      SET status = ?,
          started_at = COALESCE(?, started_at),
          completed_at = COALESCE(?, completed_at),
          duration = COALESCE(?, duration),
          exit_code = COALESCE(?, exit_code),
          error = COALESCE(?, error)
      WHERE id = ?
    `).run(
      update.status,
      update.startedAt || null,
      update.completedAt || null,
      update.duration || null,
      update.exitCode !== undefined ? update.exitCode : null,
      update.error || null,
      stepId,
    );
  }

  public updateReadyCheckResult(id: string, result: any): void {
    const db = getDatabase();
    db.prepare(`UPDATE deployments SET ready_check_json = ? WHERE id = ?`).run(
      JSON.stringify(result),
      id,
    );
  }

  public getDeployment(id: string): DeploymentRecord | null {
    const db = getDatabase();
    const row = db.prepare(`SELECT * FROM deployments WHERE id = ?`).get(id) as any;
    if (!row) return null;

    const stepRows = db
      .prepare(`SELECT * FROM deployment_steps WHERE deployment_id = ? ORDER BY rowid ASC`)
      .all(id) as any[];

    const steps: DeploymentStep[] = stepRows.map((s) => ({
      id: s.id,
      deploymentId: s.deployment_id,
      stepName: s.step_name,
      status: s.status,
      startedAt: s.started_at || undefined,
      completedAt: s.completed_at || undefined,
      duration: s.duration || undefined,
      exitCode: s.exit_code !== null ? s.exit_code : undefined,
      error: s.error || undefined,
    }));

    return {
      id: row.id,
      projectName: row.project_name,
      previousSha: row.previous_sha || undefined,
      targetSha: row.target_sha,
      status: row.status,
      triggerType: row.trigger_type,
      createdAt: row.created_at,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
      steps,
      readyCheck: row.ready_check_json ? JSON.parse(row.ready_check_json) : undefined,
      error: row.error || undefined,
    };
  }

  public getLatestDeployment(projectName: string): DeploymentRecord | null {
    const db = getDatabase();
    const row = db
      .prepare(`SELECT id FROM deployments WHERE project_name = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(projectName) as any;
    return row ? this.getDeployment(row.id) : null;
  }

  public getDeploymentsByProject(projectName: string, limit = 20): DeploymentRecord[] {
    const db = getDatabase();
    const rows = db
      .prepare(`SELECT id FROM deployments WHERE project_name = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(projectName, limit) as any[];
    return rows.map((r) => this.getDeployment(r.id)!);
  }

  public getActiveDeployments(projectName?: string): DeploymentRecord[] {
    const db = getDatabase();
    let query = `SELECT id FROM deployments WHERE status IN ('queued', 'running', 'rolling_back')`;
    const params: any[] = [];
    if (projectName) {
      query += ` AND project_name = ?`;
      params.push(projectName);
    }
    query += ` ORDER BY created_at ASC`;

    const rows = db.prepare(query).all(...params) as any[];
    return rows.map((r) => this.getDeployment(r.id)!);
  }

  public getStats(projectName?: string): {
    total: number;
    success: number;
    failed: number;
    rolledBack: number;
    cancelled: number;
    running: number;
    queued: number;
    avgDurationMs: number;
  } {
    const db = getDatabase();
    let query = `SELECT status, started_at, completed_at FROM deployments`;
    const params: any[] = [];
    if (projectName) {
      query += ` WHERE project_name = ?`;
      params.push(projectName);
    }

    const rows = db.prepare(query).all(...params) as any[];

    let success = 0;
    let failed = 0;
    let rolledBack = 0;
    let cancelled = 0;
    let running = 0;
    let queued = 0;
    let totalDurationMs = 0;
    let completedCount = 0;

    for (const r of rows) {
      if (r.status === 'success') success++;
      else if (r.status === 'failed') failed++;
      else if (r.status === 'rolled_back' || r.status === 'rollback_failed') rolledBack++;
      else if (r.status === 'cancelled') cancelled++;
      else if (r.status === 'running' || r.status === 'rolling_back') running++;
      else if (r.status === 'queued') queued++;

      if (r.started_at && r.completed_at) {
        totalDurationMs += r.completed_at - r.started_at;
        completedCount++;
      }
    }

    return {
      total: rows.length,
      success,
      failed,
      rolledBack,
      cancelled,
      running,
      queued,
      avgDurationMs: completedCount > 0 ? Math.round(totalDurationMs / completedCount) : 0,
    };
  }
}
