import type { NormalizedSelfRepairConfig } from '../config/types.js';
import { isZeroDowntimeEnabled } from '../deployment/strategy.js';
import { logger } from '../logging/logger.js';
import { NotificationService } from '../notifications/notification-service.js';
import { ReadyCheckerAdapter } from '../readiness/ready-checker-adapter.js';
import { UnitupAdapter } from '../runtime/unitup-adapter.js';
import { DeploymentRepository } from '../storage/deployment-repository.js';
import type { StoredProject } from '../storage/project-repository.js';

export const DEFAULT_SELF_REPAIR: NormalizedSelfRepairConfig = {
  enabled: true,
  healthCheck: true,
  healthFailureThreshold: 3,
  maxRestarts: 5,
};

/** First retry after a failed recovery; doubles per failure up to MAX_BACKOFF_MS. */
export const BASE_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 15 * 60_000;

export type HealOutcome =
  | 'skipped'
  | 'healthy'
  | 'degraded'
  | 'backoff'
  | 'healed'
  | 'failed'
  | 'gave_up';

interface HealState {
  /** Consecutive failed recovery attempts. */
  failures: number;
  /** Consecutive failed health probes while the unit is active. */
  healthFailures: number;
  nextAttemptAt: number;
  gaveUp: boolean;
  /** Last successful deployment this state belongs to; a new deployment starts fresh. */
  sha?: string;
}

export interface ServiceHealerDeps {
  unitupAdapter?: UnitupAdapter;
  readyAdapter?: ReadyCheckerAdapter;
  deploymentRepo?: DeploymentRepository;
  notificationService?: NotificationService;
  now?: () => number;
}

/**
 * Watchdog service recovery: restarts crashed or unresponsive services with exponential
 * backoff, verifies the result, and alerts once when it gives up.
 */
export class ServiceHealer {
  private unitupAdapter: UnitupAdapter;
  private readyAdapter: ReadyCheckerAdapter;
  private deploymentRepo: DeploymentRepository;
  private notificationService: NotificationService;
  private now: () => number;
  private states = new Map<string, HealState>();

  constructor(deps: ServiceHealerDeps = {}) {
    this.unitupAdapter = deps.unitupAdapter ?? new UnitupAdapter();
    this.readyAdapter = deps.readyAdapter ?? new ReadyCheckerAdapter();
    this.deploymentRepo = deps.deploymentRepo ?? new DeploymentRepository();
    this.notificationService = deps.notificationService ?? new NotificationService();
    this.now = deps.now ?? Date.now;
  }

  public getState(projectName: string): Readonly<HealState> | undefined {
    return this.states.get(projectName);
  }

  public async check(proj: StoredProject): Promise<HealOutcome> {
    const config = proj.config;
    // Projects stored before selfRepair existed have no section: use the defaults
    const repair = { ...DEFAULT_SELF_REPAIR, ...(config.selfRepair ?? {}) };
    const svcName = config.deploy?.service?.name;

    if (!repair.enabled || !svcName || config.deploy.service.action === 'none') return 'skipped';
    // Never fight an in-progress deployment, and never resurrect a never-deployed service
    if (this.deploymentRepo.hasActiveDeployments(proj.name)) return 'skipped';
    if (!proj.lastSuccessfulSha) return 'skipped';

    const state = this.stateFor(proj.name, proj.lastSuccessfulSha);
    const status = await this.unitupAdapter.status(svcName);
    if (status.subState === 'query_failed') return 'skipped';

    let problem: 'down' | 'unhealthy' | null = null;
    if (!status.active) {
      problem = 'down';
    } else {
      const probeHealth = repair.healthCheck && config.deploy.ready.checks.length > 0;
      const healthy = probeHealth
        ? (await this.readyAdapter.probe(config.deploy.ready)).healthy
        : true;
      if (healthy) {
        if (state.failures > 0 || state.gaveUp || state.healthFailures > 0) {
          logger.info(`[SELF-REPAIR] Service '${svcName}' for '${proj.name}' is healthy again.`, {
            project: proj.name,
            service: svcName,
          });
        }
        this.resetState(state);
        return 'healthy';
      }
      state.healthFailures++;
      if (state.healthFailures < repair.healthFailureThreshold) {
        logger.warn(
          `[SELF-REPAIR] Health probe failed for '${svcName}' (${state.healthFailures}/${repair.healthFailureThreshold}).`,
          { project: proj.name, service: svcName },
        );
        return 'degraded';
      }
      problem = 'unhealthy';
    }

    if (state.gaveUp) return 'skipped';
    if (this.now() < state.nextAttemptAt) return 'backoff';

    const attempt = state.failures + 1;
    logger.warn(
      `[SELF-REPAIR] Service '${svcName}' for project '${proj.name}' is ${problem === 'down' ? `down (${status.subState || 'inactive'})` : 'not responding to health checks'}. Recovery attempt ${attempt}/${repair.maxRestarts}...`,
      { project: proj.name, service: svcName, attempt },
    );

    try {
      await this.unitupAdapter.recover(svcName, {
        zeroDowntime: isZeroDowntimeEnabled(config),
        restart: problem === 'unhealthy',
      });
      await this.verify(proj);
      logger.info(`[SELF-REPAIR] Recovered service '${svcName}' for '${proj.name}'.`, {
        project: proj.name,
        service: svcName,
        attempt,
      });
      this.resetState(state);
      return 'healed';
    } catch (err: any) {
      state.failures = attempt;
      state.healthFailures = 0;
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      state.nextAttemptAt = this.now() + backoff;

      if (attempt >= repair.maxRestarts) {
        state.gaveUp = true;
        const message = `Self-repair gave up on service '${svcName}' after ${attempt} failed recovery attempts: ${err.message}`;
        logger.error(`[SELF-REPAIR] ${message}`, { project: proj.name, service: svcName });
        await this.notificationService.sendDeploymentNotification(config, {
          projectName: proj.name,
          deploymentId: 'self-repair',
          status: 'failed',
          targetSha: proj.lastSuccessfulSha,
          triggerType: 'self-repair',
          error: message,
        });
        return 'gave_up';
      }

      logger.warn(
        `[SELF-REPAIR] Recovery attempt ${attempt}/${repair.maxRestarts} for '${svcName}' failed: ${err.message}. Next attempt in ${Math.round(backoff / 1000)}s.`,
        { project: proj.name, service: svcName, attempt },
      );
      return 'failed';
    }
  }

  private async verify(proj: StoredProject): Promise<void> {
    const svcName = proj.config.deploy.service.name;
    if (proj.config.deploy.ready.checks.length > 0) {
      await this.readyAdapter.wait(proj.config.deploy.ready);
      return;
    }
    const status = await this.unitupAdapter.status(svcName);
    if (!status.active) {
      throw new Error(`service is still ${status.subState || 'inactive'} after restart`);
    }
  }

  private stateFor(projectName: string, sha: string): HealState {
    const existing = this.states.get(projectName);
    if (existing && existing.sha === sha) return existing;
    const fresh: HealState = {
      failures: 0,
      healthFailures: 0,
      nextAttemptAt: 0,
      gaveUp: false,
      sha,
    };
    this.states.set(projectName, fresh);
    return fresh;
  }

  private resetState(state: HealState): void {
    state.failures = 0;
    state.healthFailures = 0;
    state.nextAttemptAt = 0;
    state.gaveUp = false;
  }
}
