/**
 * Legacy circuit breaker reference — extracted from pickle-rick-claude@95f5c416.
 *
 * Provenance: git show 95f5c416:extension/src/services/circuit-breaker.ts
 *
 * This is a STANDALONE port of the legacy `recordIterationResult`,
 * `normalizeErrorSignature`, `canExecute`, and related types/functions.
 * The I/O-bound parts (detectProgress, initCircuitBreaker, state file I/O)
 * are NOT ported — only the pure decision logic.
 *
 * ADAPTER-MEDIATED: The legacy breaker has a richer state model (CLOSED,
 * HALF_OPEN, OPEN) and tracks `consecutive_same_error` + `consecutive_no_progress`
 * separately. The new core has a simpler model (open boolean, per-signature
 * errorCounts map, no HALF_OPEN). The adapter maps between these lossy
 * representations. See manifest.json for the adapter documentation.
 */

// ── Legacy types (ported verbatim from circuit-breaker.ts@95f5c416) ──

export type CircuitState = 'CLOSED' | 'HALF_OPEN' | 'OPEN';

export interface CircuitBreakerState {
  state: CircuitState;
  last_change: string;
  consecutive_no_progress: number;
  consecutive_same_error: number;
  last_error_signature: string | null;
  last_known_head: string;
  last_known_step: string | null;
  last_known_ticket: string | null;
  last_progress_iteration: number;
  total_opens: number;
  reason: string;
  opened_at: string | null;
  history: CircuitTransition[];
}

export interface CircuitBreakerConfig {
  enabled: boolean;
  noProgressThreshold: number;
  sameErrorThreshold: number;
  halfOpenAfter: number;
}

export interface IterationResult {
  hasProgress: boolean;
  errorSignature: string | null;
}

export interface CircuitTransition {
  timestamp: string;
  iteration: number;
  from: CircuitState;
  to: CircuitState;
  reason: string;
}

// ── Ported functions (verbatim from circuit-breaker.ts@95f5c416) ──

function freshState(): CircuitBreakerState {
  return {
    state: 'CLOSED',
    last_change: new Date().toISOString(),
    consecutive_no_progress: 0,
    consecutive_same_error: 0,
    last_error_signature: null,
    last_known_head: '',
    last_known_step: null,
    last_known_ticket: null,
    last_progress_iteration: 0,
    total_opens: 0,
    reason: '',
    opened_at: null,
    history: [],
  };
}

function isCircuitState(s: unknown): s is CircuitState {
  return s === 'CLOSED' || s === 'HALF_OPEN' || s === 'OPEN';
}

function transition(
  state: CircuitBreakerState,
  to: CircuitState,
  reason: string,
  iteration: number,
): void {
  const from = state.state;
  state.state = to;
  state.last_change = new Date().toISOString();
  state.reason = reason;
  state.history.push({
    timestamp: new Date().toISOString(),
    iteration,
    from,
    to,
    reason,
  });
  if (to === 'OPEN') {
    state.opened_at = new Date().toISOString();
    state.total_opens++;
  }
  if (to === 'CLOSED') {
    state.opened_at = null;
  }
}

/**
 * Normalize an error signature.
 * (Verbatim from circuit-breaker.ts@95f5c416)
 *
 * NOTE: The legacy normalization does NOT strip "at line N" patterns.
 * It strips Unix paths, :N:N line:column patterns, timestamps, UUIDs.
 * The new core's `extractErrorSignature` additionally strips `:\d+` and
 * `\bline \d+` patterns — this is an intentional improvement (see
 * docs/decisions/breaker-normalization.md).
 */
export function normalizeErrorSignature(errorLine: string): string {
  let s = errorLine;

  // Rule 1: Replace Unix paths
  s = s.replace(/\/[\w.@/-]+/g, '<PATH>');

  // Rule 2: Replace line:column patterns :N:N
  s = s.replace(/:\d+:\d+/g, ':<N>:<N>');

  // Rule 3: Replace ISO 8601 timestamps
  s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>');

  // Rule 4: Replace UUIDs
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');

  // Rule 5: Standalone numbers are preserved (exit codes matter)

  // Rule 6: Collapse consecutive whitespace
  s = s.replace(/\s+/g, ' ').trim();

  // Rule 7: Truncate to 200 chars
  if (s.length > 200) s = s.slice(0, 200);

  return s;
}

function updateErrorTracking(
  newState: CircuitBreakerState,
  priorSignature: string | null,
  currentSignature: string | null,
): void {
  if (currentSignature === null) {
    newState.consecutive_same_error = 0;
    newState.last_error_signature = null;
    return;
  }
  if (currentSignature === priorSignature) {
    newState.consecutive_same_error++;
  } else {
    newState.consecutive_same_error = 1;
    newState.last_error_signature = currentSignature;
  }
}

export function recordIterationResult(
  state: CircuitBreakerState,
  result: IterationResult,
  iteration: number,
  settings: CircuitBreakerConfig
): CircuitBreakerState {
  const newState: CircuitBreakerState = {
    ...state,
    history: [...state.history],
  };

  updateErrorTracking(newState, state.last_error_signature, result.errorSignature);

  // Progress tracking
  if (result.hasProgress) {
    newState.consecutive_no_progress = 0;
    newState.last_progress_iteration = iteration;
    // Recovery: HALF_OPEN -> CLOSED (error counters NOT reset)
    if (state.state === 'HALF_OPEN') {
      transition(newState, 'CLOSED', 'Progress detected', iteration);
    }
  } else {
    newState.consecutive_no_progress++;
  }

  // State transitions (error check first — errors are unambiguous)
  if (newState.consecutive_same_error >= settings.sameErrorThreshold) {
    transition(newState, 'OPEN',
      `Same error repeated ${newState.consecutive_same_error} times`, iteration);
  } else if (newState.consecutive_no_progress >= settings.noProgressThreshold) {
    transition(newState, 'OPEN',
      `No progress in ${newState.consecutive_no_progress} iterations`, iteration);
  } else if (newState.consecutive_no_progress >= settings.halfOpenAfter
             && newState.state === 'CLOSED') {
    transition(newState, 'HALF_OPEN',
      `No progress in ${newState.consecutive_no_progress} iterations`, iteration);
  }

  return newState;
}

export function canExecute(state: CircuitBreakerState): boolean {
  return state.state !== 'OPEN';
}

// ── Adapter: maps conformance fixture inputs to the legacy breaker ──

export interface FixtureBreakerIteration {
  error: string | null;
  gitTreeChanged: boolean;
  workerClaimedFilesChanged?: number | null;
}

export interface FixtureBreakerInput {
  threshold: number;
  iterations: FixtureBreakerIteration[];
}

export interface FixtureBreakerResult {
  canExecute: boolean;
  transition: string | undefined;
  reason: string | undefined;
  errorCount: number;
}

/**
 * ADAPTER-MEDIATED differential: drives the legacy `recordIterationResult`
 * via a documented (lossy) state→transition adapter.
 *
 * Adapter mapping:
 * - Fixture `gitTreeChanged` → legacy `hasProgress` (the legacy's
 *   detectProgress uses git tree truth, matching the new core's design).
 * - Fixture `error` → legacy `errorSignature` via `normalizeErrorSignature`
 *   (the legacy pipeline normalizes before calling recordIterationResult).
 * - Fixture `workerClaimedFilesChanged` → IGNORED (the legacy's
 *   detectProgress does not count worker-claimed file changes as progress
 *   without a git tree change — this matches the new core's design).
 * - Fixture `threshold` → legacy `sameErrorThreshold` AND `noProgressThreshold`.
 *   `halfOpenAfter` defaults to 2 (legacy default), capped at threshold-1.
 *
 * Lossiness:
 * - The legacy has HALF_OPEN state; the new core does not. When the legacy
 *   transitions to HALF_OPEN, `canExecute` is still true (HALF_OPEN ≠ OPEN),
 *   matching the new core's `canExecute` semantics. The `transition` field
 *   will differ (legacy: "half-open", new core: "closed") — this is
 *   adapter-mediated lossiness, not a behavioral deviation.
 * - The legacy tracks `consecutive_same_error` (reset on signature change);
 *   the new core tracks per-signature `errorCounts` (not reset on change).
 *   For the errorCount comparison, we map the legacy's
 *   `consecutive_same_error` to the new core's max(errorCounts.values()).
 *   These match when all errors have the same signature.
 */
export function runLegacyBreaker(input: FixtureBreakerInput): FixtureBreakerResult {
  const threshold = input.threshold;
  const settings: CircuitBreakerConfig = {
    enabled: true,
    noProgressThreshold: threshold,
    sameErrorThreshold: threshold,
    halfOpenAfter: Math.min(2, Math.max(1, threshold - 1)),
  };

  let state = freshState();
  let lastTransition: CircuitTransition | undefined;

  for (let i = 0; i < input.iterations.length; i++) {
    const iter = input.iterations[i]!;
    const errorSignature = iter.error !== null
      ? normalizeErrorSignature(iter.error)
      : null;

    state = recordIterationResult(
      state,
      {
        hasProgress: iter.gitTreeChanged,
        errorSignature,
      },
      i,
      settings,
    );

    if (state.history.length > 0) {
      lastTransition = state.history[state.history.length - 1];
    }
  }

  // Map legacy state to new-core transition names
  let transitionName: string | undefined;
  if (lastTransition) {
    if (lastTransition.to === 'OPEN') {
      transitionName = 'opened';
    } else if (lastTransition.to === 'HALF_OPEN') {
      transitionName = 'half-open';
    } else if (lastTransition.to === 'CLOSED' && lastTransition.from === 'HALF_OPEN') {
      transitionName = 'reset';
    } else if (lastTransition.to === 'CLOSED' && lastTransition.from === 'CLOSED') {
      // No actual transition — stays closed
      transitionName = 'closed';
    } else {
      transitionName = lastTransition.to.toLowerCase();
    }
  } else {
    transitionName = 'closed';
  }

  return {
    canExecute: canExecute(state),
    transition: transitionName,
    reason: lastTransition?.reason,
    errorCount: state.consecutive_same_error,
  };
}
