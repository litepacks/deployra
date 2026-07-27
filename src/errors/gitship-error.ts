export class GitshipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitshipError';
  }
}

export class RepositoryError extends GitshipError {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryError';
  }
}

export class CommandExecutionError extends GitshipError {
  public exitCode?: number;
  public stderr?: string;

  constructor(message: string, exitCode?: number, stderr?: string) {
    super(message);
    this.name = 'CommandExecutionError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class RuntimeError extends GitshipError {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

export class ReadinessError extends GitshipError {
  constructor(message: string) {
    super(message);
    this.name = 'ReadinessError';
  }
}

export class RollbackError extends GitshipError {
  constructor(message: string) {
    super(message);
    this.name = 'RollbackError';
  }
}

export class ConfigValidationError extends GitshipError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export class LockError extends GitshipError {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}
