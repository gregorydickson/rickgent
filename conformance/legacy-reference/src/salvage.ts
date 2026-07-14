/**
 * Legacy salvage reference — extracted from pickle-rick-claude@95f5c416.
 *
 * Provenance: git show 95f5c416:extension/src/lib/salvage-ticket.ts
 *
 * This is a STANDALONE port of the legacy `salvageTicket` function with its
 * two dependencies (`git-utils`, `reconcile-ticket-truth`) stubbed. The stubs
 * are driven by fixture booleans so the legacy decision logic runs
 * independently of the new core.
 *
 * The legacy `salvageTicket` takes a `SalvageTicketInput` + injectable
 * `SalvageDeps` and returns a `SalvageOutcome`. We port the FULL decision
 * logic verbatim — only the I/O seams are stubbed.
 */

// ── Stub types (replacing git-utils.js and reconcile-ticket-truth.js) ──

export interface TicketTruth {
  dirty: boolean;
  headSha: string | null;
  ticketStatuses: Record<string, string | null>;
}

export interface ArchiveResult {
  path: string;
  bytes: number;
}

// ── Legacy types (ported verbatim from salvage-ticket.ts@95f5c416) ──

export type SalvageDisposition =
  | 'ff-reattached'
  | 'committed-done'
  | 'archived-todo'
  | 'no-op'
  | 'error';

export type GateVerdict = 'passing' | 'failing' | 'errored';

export interface SalvageOutcome {
  disposition: SalvageDisposition;
  sha?: string | undefined;
  archived?: boolean;
  reason: string;
}

export interface SalvageTicketInput {
  sessionDir: string;
  workingDir: string;
  ticketId: string;
  startCommit?: string | null;
  completionCommitSha?: string | null;
  log?: (msg: string) => void;
}

export interface SalvageDeps {
  reconcile: (input: { sessionDir: string; workingDir: string }) => TicketTruth;
  gate: (input: SalvageTicketInput) => GateVerdict;
  commitScoped: (input: SalvageTicketInput) => { committed: boolean; sha?: string | undefined };
  archive: (input: SalvageTicketInput) => ArchiveResult | null;
  resetTodo: (input: SalvageTicketInput) => void;
  ffReattach: (input: SalvageTicketInput) => { recovered: boolean; sha?: string | null | undefined };
  backfillDone?: (input: SalvageTicketInput, sha: string) => { done: boolean; sha?: string | null | undefined };
}

// ── Stub helpers for the default deps ──

function isTerminalStatus(status: string | null | undefined): boolean {
  const s = (status ?? '').toLowerCase().replace(/["']/g, '').trim();
  return s === 'done' || s === 'skipped';
}

// ── The ported salvageTicket function (verbatim decision logic) ──

function salvageCleanTree(
  input: SalvageTicketInput,
  truth: TicketTruth,
  deps: SalvageDeps,
  log: (msg: string) => void,
): SalvageOutcome {
  const attributedSha = input.completionCommitSha;
  const attributable = !!attributedSha
    && !!truth.headSha
    && !!deps.backfillDone
    && !isTerminalStatus(truth.ticketStatuses[input.ticketId]);
  if (attributable) {
    const r = deps.backfillDone!(input, attributedSha!);
    if (r.done && r.sha) {
      log(`[salvage] ${input.ticketId}: clean tree + attributable commit (${r.sha}) -> back-filled completion_commit + Done`);
      return { disposition: 'committed-done', sha: r.sha, reason: 'backfilled_clean_tree' };
    }
  }
  return { disposition: 'no-op', reason: 'clean_tree' };
}

export function salvageTicket(input: SalvageTicketInput, deps: SalvageDeps): SalvageOutcome {
  const log = input.log ?? (() => { /* silent */ });
  try {
    // 1. HEAD regressed off a committed ticket -> auto-ff-reattach the orphan.
    const reattach = deps.ffReattach(input);
    if (reattach.recovered) {
      log(`[salvage] ${input.ticketId}: orphan reattached (ff-only) -> ${reattach.sha ?? 'tip'}`);
      return { disposition: 'ff-reattached', sha: reattach.sha ?? undefined, reason: 'head_regression_reattached' };
    }

    const truth = deps.reconcile({ sessionDir: input.sessionDir, workingDir: input.workingDir });

    // 2. clean tree -> back-fill-or-no-op (see salvageCleanTree).
    if (!truth.dirty) {
      return salvageCleanTree(input, truth, deps, log);
    }

    // A ticket already Done/Skipped is owned by the model-driven path; don't re-salvage.
    if (isTerminalStatus(truth.ticketStatuses[input.ticketId])) {
      return { disposition: 'no-op', reason: 'already_terminal' };
    }

    // 3. dirty + gate verdict.
    const verdict = deps.gate(input);
    if (verdict === 'passing') {
      const r = deps.commitScoped(input);
      if (r.committed && r.sha) {
        log(`[salvage] ${input.ticketId}: gate-passing -> committed scoped deliverable (${r.sha}) + Done`);
        return { disposition: 'committed-done', sha: r.sha, reason: 'gate_passing_committed' };
      }
      // Commit failed -> fall through to archive so the diff is never stranded.
    }

    // 4. dirty + gate-failing / gate-errored / commit-failed -> archive THEN reset Todo.
    const archived = deps.archive(input);
    deps.resetTodo(input);
    log(`[salvage] ${input.ticketId}: ${verdict} -> archived diff + reset Todo`);
    return {
      disposition: 'archived-todo',
      archived: archived !== null,
      reason: verdict === 'errored' ? 'gate_errored_archived' : 'gate_failing_archived',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[salvage] ${input.ticketId}: threw (best-effort, no destructive action taken): ${msg}`);
    return { disposition: 'error', reason: `salvage_error: ${msg}` };
  }
}

// ── Adapter: maps conformance fixture booleans to legacy deps ──

export interface FixtureSalvageInput {
  gatePassed: boolean;
  treeChanged: boolean;
  orphanReset: boolean;
  ffReattachPossible: boolean;
  ownedPaths: string[];
}

export interface FixtureSalvageResult {
  disposition: SalvageDisposition;
  reason: string;
  stagedPaths: string[];
}

/**
 * Drive the legacy `salvageTicket` with fixture booleans by constructing
 * appropriate stub deps. The decision logic runs verbatim — only the I/O
 * seams are stubbed.
 */
export function runLegacySalvage(input: FixtureSalvageInput): FixtureSalvageResult {
  const ticketInput: SalvageTicketInput = {
    sessionDir: '/tmp/legacy-test-session',
    workingDir: '/tmp/legacy-test-work',
    ticketId: 'T1',
  };

  const deps: SalvageDeps = {
    reconcile: () => ({
      dirty: input.treeChanged,
      headSha: input.treeChanged ? 'abc123' : null,
      ticketStatuses: { T1: 'In_Progress' },
    }),
    gate: () => (input.gatePassed ? 'passing' : 'failing'),
    commitScoped: () => ({
      committed: input.gatePassed && input.treeChanged,
      sha: input.gatePassed && input.treeChanged ? 'abc123' : undefined,
    }),    archive: () => ({ path: '/tmp/archive.patch', bytes: 100 }),
    resetTodo: () => { /* no-op stub */ },
    ffReattach: () => ({
      recovered: input.orphanReset && input.ffReattachPossible,
      sha: input.orphanReset && input.ffReattachPossible ? 'abc123' : null,
    }),
  };

  const outcome = salvageTicket(ticketInput, deps);

  return {
    disposition: outcome.disposition,
    reason: outcome.reason,
    stagedPaths: input.ownedPaths,
  };
}
