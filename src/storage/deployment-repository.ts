import { nanoid } from 'nanoid';
import type { DeployStrategy } from '../config/types.js';
import { getDatabase, getPreparedStatement } from './database.js';

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
  output?: string;
  error?: string;
}

export interface DeploymentRecord {
  id: string;
  projectName: string;
  previousSha?: string;
  targetSha: string;
  status: DeploymentStatus;
  triggerType: 'poll' | 'manual' | 'webhook';
  dryRun?: boolean;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  steps: DeploymentStep[];
  readyCheck?: any;
  error?: string;
}

export function computeDeploymentSteps(
  configCommands?: Record<string, string[]>,
  strategy?: DeployStrategy,
): string[] {
  const basePreSteps = [
    'acquire-lock',
    'validate-repository',
    'fetch',
    'resolve-target',
    'prepare',
  ];
  const basePostSteps =
    strategy === 'release'
      ? [
          'activate-release',
          'service-action',
          'ready-check',
          'cleanup-releases',
          'complete',
          'release-lock',
        ]
      : ['service-action', 'ready-check', 'complete', 'release-lock'];

  if (!configCommands) {
    return [...basePreSteps, 'install', 'build', ...basePostSteps];
  }

  const activeCommandSteps: string[] = [];
  for (const [stepName, cmdList] of Object.entries(configCommands)) {
    if (Array.isArray(cmdList) && cmdList.length > 0) {
      activeCommandSteps.push(stepName);
    }
  }

  return [...basePreSteps, ...activeCommandSteps, ...basePostSteps];
}

export class DeploymentRepository {
  public createDeployment(data: {
    id?: string;
    projectName: string;
    previousSha?: string;
    targetSha: string;
    status?: DeploymentStatus;
    triggerType: 'poll' | 'manual' | 'webhook';
    dryRun?: boolean;
    steps?: string[];
  }): DeploymentRecord {
    const db = getDatabase();
    const id = data.id || `dep_${nanoid(10)}`;
    const createdAt = Date.now();
    const status = data.status || 'queued';
    const defaultSteps = data.steps || computeDeploymentSteps();

    const insertDep = getPreparedStatement(`
      INSERT INTO deployments (id, project_name, previous_sha, target_sha, status, trigger_type, dry_run, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertStep = getPreparedStatement(`
      INSERT INTO deployment_steps (id, deployment_id, step_name, status)
      VALUES (?, ?, ?, 'pending')
    `);

    const createTx = db.transaction(() => {
      insertDep.run(
        id,
        data.projectName,
        data.previousSha || null,
        data.targetSha,
        status,
        data.triggerType,
        data.dryRun ? 1 : 0,
        createdAt,
      );

      for (const stepName of defaultSteps) {
        insertStep.run(`${id}_${stepName}`, id, stepName);
      }
    });

    createTx();
    return {
      id,
      projectName: data.projectName,
      previousSha: data.previousSha || undefined,
      targetSha: data.targetSha,
      status,
      triggerType: data.triggerType,
      dryRun: Boolean(data.dryRun),
      createdAt,
      steps: defaultSteps.map((s) => ({
        id: `${id}_${s}`,
        deploymentId: id,
        stepName: s,
        status: 'pending',
      })),
    };
  }

  public updateStatus(id: string, status: DeploymentStatus, error?: string): void {
    const now = Date.now();

    if (status === 'running') {
      getPreparedStatement(`UPDATE deployments SET status = ?, started_at = ? WHERE id = ?`).run(
        status,
        now,
        id,
      );
    } else if (
      ['success', 'failed', 'cancelled', 'rolled_back', 'rollback_failed'].includes(status)
    ) {
      getPreparedStatement(
        `UPDATE deployments SET status = ?, completed_at = ?, error = ? WHERE id = ?`,
      ).run(status, now, error || null, id);
    } else {
      getPreparedStatement(`UPDATE deployments SET status = ?, error = ? WHERE id = ?`).run(
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
      output?: string;
      error?: string;
    },
  ): void {
    const stepId = `${deploymentId}_${stepName}`;

    const updateStmt = getPreparedStatement(`
      UPDATE deployment_steps
      SET status = ?,
          started_at = COALESCE(?, started_at),
          completed_at = COALESCE(?, completed_at),
          duration = COALESCE(?, duration),
          exit_code = COALESCE(?, exit_code),
          output = COALESCE(?, output),
          error = ?
      WHERE id = ?
    `);

    const res = updateStmt.run(
      update.status,
      update.startedAt || null,
      update.completedAt || null,
      update.duration || null,
      update.exitCode !== undefined ? update.exitCode : null,
      update.output || null,
      update.error || null,
      stepId,
    );

    if (res.changes === 0) {
      getPreparedStatement(`
        INSERT INTO deployment_steps (id, deployment_id, step_name, status)
        VALUES (?, ?, ?, 'pending')
      `).run(stepId, deploymentId, stepName);

      updateStmt.run(
        update.status,
        update.startedAt || null,
        update.completedAt || null,
        update.duration || null,
        update.exitCode !== undefined ? update.exitCode : null,
        update.output || null,
        update.error || null,
        stepId,
      );
    }
  }

  public updateReadyCheckResult(id: string, result: any): void {
    getPreparedStatement(`UPDATE deployments SET ready_check_json = ? WHERE id = ?`).run(
      JSON.stringify(result),
      id,
    );
  }

  public getDeploymentStatus(id: string): DeploymentStatus | null {
    const row = getPreparedStatement(`SELECT status FROM deployments WHERE id = ?`).get(id) as
      | { status: DeploymentStatus }
      | undefined;
    return row ? row.status : null;
  }

  public getDeploymentStartedAt(id: string): number | undefined {
    const row = getPreparedStatement(`SELECT started_at FROM deployments WHERE id = ?`).get(id) as
      | { started_at: number | null }
      | undefined;
    return row?.started_at || undefined;
  }

  public getDeployment(id: string): DeploymentRecord | null {
    const row = getPreparedStatement(`SELECT * FROM deployments WHERE id = ?`).get(id) as any;
    if (!row) return null;

    const stepRows = getPreparedStatement(
      `SELECT * FROM deployment_steps WHERE deployment_id = ? ORDER BY rowid ASC`,
    ).all(id) as any[];

    const steps: DeploymentStep[] = stepRows.map((s) => ({
      id: s.id,
      deploymentId: s.deployment_id,
      stepName: s.step_name,
      status: s.status,
      startedAt: s.started_at || undefined,
      completedAt: s.completed_at || undefined,
      duration: s.duration || undefined,
      exitCode: s.exit_code !== null ? s.exit_code : undefined,
      output: s.output || undefined,
      error: s.error || undefined,
    }));

    return {
      id: row.id,
      projectName: row.project_name,
      previousSha: row.previous_sha || undefined,
      targetSha: row.target_sha,
      status: row.status,
      triggerType: row.trigger_type,
      dryRun: Boolean(row.dry_run),
      createdAt: row.created_at,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
      steps,
      readyCheck: row.ready_check_json ? JSON.parse(row.ready_check_json) : undefined,
      error: row.error || undefined,
    };
  }

  private hydrateDeployments(rows: any[]): DeploymentRecord[] {
    if (!rows || rows.length === 0) return [];
    const db = getDatabase();
    const deploymentIds = rows.map((r) => r.id);

    const placeholders = deploymentIds.map(() => '?').join(',');
    const stepRows = db
      .prepare(
        `SELECT * FROM deployment_steps WHERE deployment_id IN (${placeholders}) ORDER BY rowid ASC`,
      )
      .all(...deploymentIds) as any[];

    const stepsByDep = new Map<string, DeploymentStep[]>();
    for (const s of stepRows) {
      let list = stepsByDep.get(s.deployment_id);
      if (!list) {
        list = [];
        stepsByDep.set(s.deployment_id, list);
      }
      list.push({
        id: s.id,
        deploymentId: s.deployment_id,
        stepName: s.step_name,
        status: s.status,
        startedAt: s.started_at || undefined,
        completedAt: s.completed_at || undefined,
        duration: s.duration || undefined,
        exitCode: s.exit_code !== null ? s.exit_code : undefined,
        output: s.output || undefined,
        error: s.error || undefined,
      });
    }

    return rows.map((row) => ({
      id: row.id,
      projectName: row.project_name,
      previousSha: row.previous_sha || undefined,
      targetSha: row.target_sha,
      status: row.status,
      triggerType: row.trigger_type,
      dryRun: Boolean(row.dry_run),
      createdAt: row.created_at,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
      steps: stepsByDep.get(row.id) || [],
      readyCheck: row.ready_check_json ? JSON.parse(row.ready_check_json) : undefined,
      error: row.error || undefined,
    }));
  }

  public getLatestDeployment(projectName: string): DeploymentRecord | null {
    const row = getPreparedStatement(
      `SELECT * FROM deployments WHERE project_name = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(projectName) as any;
    return row ? this.hydrateDeployments([row])[0] : null;
  }

  public getDeploymentsByProject(projectName: string, limit = 20): DeploymentRecord[] {
    const rows = getPreparedStatement(
      `SELECT * FROM deployments WHERE project_name = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(projectName, limit) as any[];
    return this.hydrateDeployments(rows);
  }

  public countRecentFailures(projectName: string, targetSha: string, limit = 10): number {
    const rows = getPreparedStatement(
      `SELECT target_sha, status FROM deployments WHERE project_name = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(projectName, limit) as Array<{ target_sha: string; status: string }>;

    return rows.filter(
      (d) =>
        (d.target_sha === targetSha ||
          d.target_sha.startsWith(targetSha) ||
          targetSha.startsWith(d.target_sha)) &&
        ['failed', 'rolled_back', 'rollback_failed'].includes(d.status),
    ).length;
  }

  public getActiveDeployments(projectName?: string): DeploymentRecord[] {
    const db = getDatabase();
    let query = `SELECT * FROM deployments WHERE status IN ('queued', 'running', 'rolling_back')`;
    const params: any[] = [];
    if (projectName) {
      query += ` AND project_name = ?`;
      params.push(projectName);
    }
    query += ` ORDER BY created_at ASC`;

    const rows = db.prepare(query).all(...params) as any[];
    return this.hydrateDeployments(rows);
  }

  public hasActiveDeployments(projectName?: string): boolean {
    let query = `SELECT 1 FROM deployments WHERE status IN ('queued', 'running', 'rolling_back')`;
    const params: any[] = [];
    if (projectName) {
      query += ` AND project_name = ?`;
      params.push(projectName);
    }
    query += ` LIMIT 1`;
    const row = getPreparedStatement(query).get(...params);
    return Boolean(row);
  }

  public getActiveDeploymentSummaries(
    projectName?: string,
  ): Array<{ id: string; status: DeploymentStatus; targetSha: string }> {
    let query = `SELECT id, status, target_sha as targetSha FROM deployments WHERE status IN ('queued', 'running', 'rolling_back')`;
    const params: any[] = [];
    if (projectName) {
      query += ` AND project_name = ?`;
      params.push(projectName);
    }
    query += ` ORDER BY created_at ASC`;
    return getPreparedStatement(query).all(...params) as Array<{
      id: string;
      status: DeploymentStatus;
      targetSha: string;
    }>;
  }

  public cancelPendingDeployments(
    projectName: string,
    reason: string,
  ): Array<{ id: string; status: DeploymentStatus }> {
    const active = this.getActiveDeploymentSummaries(projectName).filter(
      (d) => d.status === 'queued' || d.status === 'running',
    );
    if (active.length === 0) return [];

    const now = Date.now();
    const updateStmt = getPreparedStatement(
      `UPDATE deployments SET status = 'cancelled', completed_at = ?, error = ? WHERE id = ?`,
    );
    const db = getDatabase();
    db.transaction(() => {
      for (const dep of active) {
        updateStmt.run(now, reason, dep.id);
      }
    })();

    return active;
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

  cleanupUnfinishedJobsOnStartup(): number {
    const db = getDatabase();
    const now = Date.now();
    const stmt = db.prepare(`
      UPDATE deployments 
      SET status = 'failed', completed_at = ?, error = 'Daemon restarted during active deployment' 
      WHERE status IN ('running', 'rolling_back', 'queued')
    `);
    const result = stmt.run(now);
    return result.changes;
  }

  cleanupStaleJobs(maxAgeMs = 15 * 60 * 1000): number {
    const db = getDatabase();
    const cutoff = Date.now() - maxAgeMs;
    const stmt = db.prepare(`
      UPDATE deployments 
      SET status = 'failed', completed_at = ?, error = 'Deployment timed out or process was restarted unexpectedly' 
      WHERE status IN ('running', 'rolling_back') AND (started_at < ? OR (started_at IS NULL AND created_at < ?))
    `);
    const result = stmt.run(Date.now(), cutoff, cutoff);
    return result.changes;
  }

  public pruneDeployments(options: {
    projectName?: string;
    keepCount?: number;
    maxAgeDays?: number;
  }): { deletedDeployments: number; deletedSteps: number } {
    const db = getDatabase();
    let deletedDeployments = 0;
    let deletedSteps = 0;

    // Prune by age if maxAgeDays is specified
    if (options.maxAgeDays !== undefined && options.maxAgeDays > 0) {
      const cutoff = Date.now() - options.maxAgeDays * 24 * 60 * 60 * 1000;
      let query = `
        SELECT id FROM deployments 
        WHERE created_at < ? AND status NOT IN ('running', 'queued', 'rolling_back')
      `;
      const params: any[] = [cutoff];
      if (options.projectName) {
        query += ` AND project_name = ?`;
        params.push(options.projectName);
      }
      const toDelete = db.prepare(query).all(...params) as { id: string }[];
      if (toDelete.length > 0) {
        const ids = toDelete.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(',');
        const stepRes = db
          .prepare(`DELETE FROM deployment_steps WHERE deployment_id IN (${placeholders})`)
          .run(...ids);
        const depRes = db
          .prepare(`DELETE FROM deployments WHERE id IN (${placeholders})`)
          .run(...ids);
        deletedSteps += stepRes.changes;
        deletedDeployments += depRes.changes;
      }
    }

    // Prune by keepCount if keepCount is specified (keep latest N finished deployments per project)
    if (options.keepCount !== undefined && options.keepCount >= 0) {
      let projectsQuery = `SELECT DISTINCT project_name FROM deployments`;
      const pParams: any[] = [];
      if (options.projectName) {
        projectsQuery += ` WHERE project_name = ?`;
        pParams.push(options.projectName);
      }
      const projects = db.prepare(projectsQuery).all(...pParams) as { project_name: string }[];

      for (const p of projects) {
        const rows = db
          .prepare(
            `
          SELECT id FROM deployments 
          WHERE project_name = ? AND status NOT IN ('running', 'queued', 'rolling_back')
          ORDER BY created_at DESC, id DESC
          LIMIT -1 OFFSET ?
        `,
          )
          .all(p.project_name, options.keepCount) as { id: string }[];

        if (rows.length > 0) {
          const ids = rows.map((r) => r.id);
          const placeholders = ids.map(() => '?').join(',');
          const stepRes = db
            .prepare(`DELETE FROM deployment_steps WHERE deployment_id IN (${placeholders})`)
            .run(...ids);
          const depRes = db
            .prepare(`DELETE FROM deployments WHERE id IN (${placeholders})`)
            .run(...ids);
          deletedSteps += stepRes.changes;
          deletedDeployments += depRes.changes;
        }
      }
    }

    return { deletedDeployments, deletedSteps };
  }
}
