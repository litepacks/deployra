import type { NormalizedDeployraConfig } from '../config/types.js';

export function isZeroDowntimeEnabled(config: NormalizedDeployraConfig): boolean {
  return Boolean(
    config.deploy.strategy === 'zero-downtime' ||
      config.deploy.zeroDowntime ||
      config.deploy.service.zeroDowntime,
  );
}

/**
 * What a deployment has already changed by the time it fails or is cancelled.
 * Rollback only undoes what actually happened.
 */
export interface DeploymentProgress {
  /** The working tree was reset to the target commit. */
  workspaceMutated: boolean;
  /** The service was stopped (install / stopBeforeBuild). */
  serviceStopped: boolean;
  /** The release symlink was switched to the new release. */
  releaseActivated: boolean;
  /** The service action (restart / zero-downtime deploy) began. */
  serviceActionStarted: boolean;
}

export function createDeploymentProgress(): DeploymentProgress {
  return {
    workspaceMutated: false,
    serviceStopped: false,
    releaseActivated: false,
    serviceActionStarted: false,
  };
}

/** True once the running service may differ from the last successful deployment. */
export function isServiceAffected(progress: DeploymentProgress): boolean {
  return progress.serviceStopped || progress.releaseActivated || progress.serviceActionStarted;
}
