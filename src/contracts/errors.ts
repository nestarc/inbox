export class InboxError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class InboxValidationError extends InboxError {
  constructor(message: string) {
    super("INVALID_ENVELOPE", message);
  }
}
export class InboxConflictError extends InboxError {
  constructor() {
    super(
      "IDENTITY_CONFLICT",
      "The message identity already exists with different content.",
    );
  }
}
export class InboxReplayConflictError extends InboxError {
  constructor() {
    super(
      "REPLAY_CONFLICT",
      "The replay request identity already exists with different parameters.",
    );
  }
}
export class InboxPermanentError extends InboxError {
  constructor(
    message = "The message cannot be processed.",
    code = "PERMANENT_ERROR",
  ) {
    super(code, message);
  }
}
export class InboxLeaseLostError extends InboxError {
  constructor() {
    super("LEASE_LOST", "The processing lease is no longer owned.");
  }
}
export class InboxStateConflictError extends InboxError {
  constructor() {
    super(
      "STATE_CONFLICT",
      "The record is absent from this scope or its state/version changed.",
    );
  }
}
export class InboxBackpressureError extends InboxError {
  constructor() {
    super(
      "BACKPRESSURE",
      "The configured inbox admission limit has been reached.",
    );
  }
}
export class InboxSchemaError extends InboxError {
  constructor() {
    super(
      "SCHEMA_MISMATCH",
      "Apply the inbox SQL migration before starting the application.",
    );
  }
}
export class InboxConfigurationError extends InboxError {
  constructor(message: string) {
    super("INVALID_CONFIGURATION", message);
  }
}
export class InboxTimeoutError extends InboxError {
  constructor() {
    super(
      "PROCESSING_TIMEOUT",
      "The handler exceeded its transaction deadline.",
    );
  }
}
