// Circuit breaker — error-signature counting with escalation ladders.
// PURE decision functions. Transitions only; no side effects.

export interface CircuitBreakerState {
  errorCounts: Record<string, number>;
  threshold: number;
  open: boolean;
  iterationCount: number;
  stallCount: number;
}

export interface IterationResult {
  error: string | null;
  gitTreeChanged: boolean;
  workerClaimedFilesChanged: number | null;
}

export type CircuitTransition =
  | { transition: "closed"; canExecute: true }
  | { transition: "opened"; canExecute: false; reason: string }
  | { transition: "half-open"; canExecute: true }
  | { transition: "reset"; canExecute: true; reason: string };

export function createBreakerState(threshold: number = 5): CircuitBreakerState {
  return {
    errorCounts: {},
    threshold,
    open: false,
    iterationCount: 0,
    stallCount: 0,
  };
}

export function extractErrorSignature(error: string): string {
  // Normalize error to a stable signature for counting.
  // Strip line numbers, timestamps, and variable content.
  return error
    .replace(/:\d+/g, ":N") // strip line numbers after colons
    .replace(/\bline \d+/gi, "line N") // strip "line 42" patterns
    .replace(/\bat \d+/g, "at N") // strip "at 42" patterns
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.-]+/g, "TIMESTAMP") // strip timestamps
    .replace(/0x[0-9a-f]+/gi, "0xADDR") // strip addresses
    .trim();
}

export function canExecute(state: CircuitBreakerState): boolean {
  return !state.open;
}

export function recordIterationResult(
  state: CircuitBreakerState,
  result: IterationResult,
): CircuitTransition {
  state.iterationCount++;

  if (result.error) {
    const sig = extractErrorSignature(result.error);
    state.errorCounts[sig] = (state.errorCounts[sig] ?? 0) + 1;

    // Detect progress via git tree truth, not worker claims
    if (result.gitTreeChanged) {
      // Progress detected — reset error counts
      state.errorCounts = {};
      state.open = false;
      state.stallCount = 0;
      return { transition: "reset", canExecute: true, reason: "git tree changed, progress detected" };
    }

    // Check if threshold reached
    if (state.errorCounts[sig] >= state.threshold) {
      state.open = true;
      return { transition: "opened", canExecute: false, reason: `threshold reached for ${sig}` };
    }
  } else {
    // No error — if git tree changed, reset
    if (result.gitTreeChanged) {
      state.errorCounts = {};
      state.open = false;
      state.stallCount = 0;
      return { transition: "reset", canExecute: true, reason: "successful iteration with tree change" };
    }
    // No error but no tree change — stall
    state.stallCount++;
  }

  if (state.open) {
    return { transition: "opened", canExecute: false, reason: "breaker is open" };
  }
  return { transition: "closed", canExecute: true };
}

// Escalation ladder constants (ported from pickle_settings.json hardening block)
export const ESCALATION_LADDERS = {
  silentDeathRespawnCap: 1,
  failedFlipSuppressionCap: 2,
  boundedTerminalEscapeCap: 3,
  breakerThresholds: 5,
  breakerRecoveryGraceSeconds: 30,
} as const;
