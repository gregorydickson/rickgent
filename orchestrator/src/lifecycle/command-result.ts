/**
 * Embeddable lifecycle command completion contract.
 *
 * Lifecycle modules return completion data or throw `LifecycleCommandError`;
 * they never terminate the host process. The CLI is the sole owner of mapping
 * these values to stderr and numeric process exits.
 */
export interface LifecycleCommandResult {
  readonly status: "succeeded" | "failed";
  readonly exitCode: number;
}

const SUCCESS: LifecycleCommandResult = Object.freeze({
  status: "succeeded",
  exitCode: 0,
});

export function lifecycleCommandSucceeded(): LifecycleCommandResult {
  return SUCCESS;
}

export function lifecycleCommandCompleted(exitCode: number): LifecycleCommandResult {
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new RangeError(`lifecycle command exit code must be an integer from 0 to 255; received ${exitCode}`);
  }
  return exitCode === 0
    ? SUCCESS
    : Object.freeze({ status: "failed", exitCode });
}

export class LifecycleCommandError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    lifecycleCommandCompleted(exitCode);
    if (exitCode === 0) throw new RangeError("LifecycleCommandError requires a nonzero exit code");
    super(message);
    this.name = "LifecycleCommandError";
    this.exitCode = exitCode;
  }
}

export function failLifecycleCommand(message: string, exitCode = 1): never {
  throw new LifecycleCommandError(message, exitCode);
}
