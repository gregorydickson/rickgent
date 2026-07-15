/**
 * Complete, typed lifecycle outcome. Numeric process exits deliberately do not
 * live here: the CLI is the only boundary allowed to map a primary class to an
 * exit code.
 */

export const RUN_OUTCOME_CLASSES = [
  "success",
  "input_contract",
  "capability_unavailable",
  "infrastructure",
  "execution",
  "verification",
  "cleanup",
] as const;

export type RunOutcomeClass = (typeof RUN_OUTCOME_CLASSES)[number];

export type RunIssueReason =
  | "zero_ticket"
  | "zero_completion"
  | "partial_failure"
  | "ticket_failed"
  | "required_gate_failed"
  | "evidence_unverifiable"
  | "cleanup_failed"
  | "infrastructure_error"
  | "capability_unavailable"
  | "input_contract_error";

export const RUN_STABLE_CODES: Readonly<Record<RunOutcomeClass, string>> = Object.freeze({
  success: "RICKGENT_OK",
  input_contract: "RICKGENT_INPUT_CONTRACT_ERROR",
  capability_unavailable: "RICKGENT_CAPABILITY_UNAVAILABLE",
  infrastructure: "RICKGENT_INFRASTRUCTURE_ERROR",
  execution: "RICKGENT_EXECUTION_FAILED",
  verification: "RICKGENT_VERIFICATION_FAILED",
  cleanup: "RICKGENT_CLEANUP_FAILED",
});

export interface RunIssue {
  readonly reason: RunIssueReason;
  readonly class: Exclude<RunOutcomeClass, "success">;
  readonly stableCode: string;
  readonly detail: string;
  readonly ticketId?: string;
  readonly gate?: string;
  readonly capabilityCode?: string;
}

export type RunOutcome =
  | {
      readonly status: "succeeded";
      readonly primary: "success";
      readonly stableCode: "RICKGENT_OK";
      readonly issues: readonly [];
    }
  | {
      readonly status: "failed";
      readonly primary: Exclude<RunOutcomeClass, "success">;
      readonly stableCode: string;
      readonly issues: readonly RunIssue[];
    };

/**
 * Runtime precedence for a complete aggregate. Cleanup wins because unsafe or
 * unverifiable residue must be surfaced first, followed by infrastructure,
 * verification, execution, and then preflight-only classes.
 */
const PRIMARY_PRECEDENCE: readonly Exclude<RunOutcomeClass, "success">[] = [
  "cleanup",
  "infrastructure",
  "verification",
  "execution",
  "capability_unavailable",
  "input_contract",
];

export function runIssue(
  issue: Omit<RunIssue, "stableCode"> & { stableCode?: string },
): RunIssue {
  return Object.freeze({
    ...issue,
    stableCode: issue.stableCode ?? RUN_STABLE_CODES[issue.class],
  });
}

export function aggregateRunOutcome(issues: readonly RunIssue[]): RunOutcome {
  if (issues.length === 0) {
    return Object.freeze({
      status: "succeeded",
      primary: "success",
      stableCode: "RICKGENT_OK",
      issues: Object.freeze([]) as readonly [],
    });
  }

  const frozenIssues = Object.freeze([...issues]);
  const primary = PRIMARY_PRECEDENCE.find((candidate) =>
    frozenIssues.some((issue) => issue.class === candidate),
  );
  if (primary === undefined) {
    throw new Error("failed run outcome has no recognized primary class");
  }
  return Object.freeze({
    status: "failed",
    primary,
    stableCode: RUN_STABLE_CODES[primary],
    issues: frozenIssues,
  });
}
