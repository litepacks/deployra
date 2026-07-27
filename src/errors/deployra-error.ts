export class DeployraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployraError';
  }
}

export class RepositoryError extends DeployraError {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryError';
  }
}

export class CommandExecutionError extends DeployraError {
  public exitCode: number;
  public stderr: string;

  constructor(message: string, exitCode = 1, stderr = '') {
    super(message);
    this.name = 'CommandExecutionError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class RuntimeError extends DeployraError {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

export class ReadinessError extends DeployraError {
  constructor(message: string) {
    super(message);
    this.name = 'ReadinessError';
  }
}

export class RollbackError extends DeployraError {
  constructor(message: string) {
    super(message);
    this.name = 'RollbackError';
  }
}

export class ConfigValidationError extends DeployraError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export class LockError extends DeployraError {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}
