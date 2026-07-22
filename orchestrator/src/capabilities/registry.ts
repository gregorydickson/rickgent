export const CAPABILITY_STATES = ["unavailable", "fixture_only", "enabled"] as const;

export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export const CAPABILITY_NAMES = [
  "autonomous_dispatch",
  "parallel_dispatch",
  "resume_retry",
  "reconciliation",
  "cross_vendor_review",
  "automatic_delivery",
  "raw_shell",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export const CLAIMS_SCHEMA_VERSION = "1.0.0" as const;
export const RELEASE_CHANNEL = "reliability_preview" as const;
export const RELEASE_LABEL = "Rickgent reliability preview" as const;
export const LEGACY_HELP_DISCLAIMER =
  "Legacy syntax follows for inspection only. Descriptions below do not make a blocked capability publicly available; the compiled preview boundary and exit contract above control." as const;
export const CLAIM_MATRIX_BEGIN = "<!-- RICKGENT_CLAIMS_MATRIX_BEGIN -->" as const;
export const CLAIM_MATRIX_END = "<!-- RICKGENT_CLAIMS_MATRIX_END -->" as const;

export const TERMINAL_SEMANTICS = Object.freeze({
  ready_for_delivery: "local_oracle_complete",
  delivered: "remote_delivery_verified",
  Done: "alias_only_for_delivered",
} as const);

export interface CapabilityEntry {
  readonly name: CapabilityName;
  readonly state: CapabilityState;
  readonly error_code: string;
  readonly reason: string;
  readonly proof_version: string;
  readonly minimum_profile: string;
}

const ENTRIES: readonly CapabilityEntry[] = [
  {
    name: "autonomous_dispatch",
    state: "enabled",
    error_code: "RICKGENT_AUTONOMOUS_DISPATCH_ACTIVE",
    reason: "Activated by t22D: the single AttemptRunner owns execution and terminalization; production requires a validated containment backend and fails closed when unavailable.",
    proof_version: "attempt-runner-critical-section-v1",
    minimum_profile: "m4_attempt_runner_containment",
  },
  {
    name: "parallel_dispatch",
    state: "unavailable",
    error_code: "RICKGENT_PARALLEL_DISPATCH_UNAVAILABLE",
    reason: "Sequential ownership is required until concurrency proof passes.",
    proof_version: "concurrency-corpus-v1",
    minimum_profile: "post_m4_explicit_activation",
  },
  {
    name: "resume_retry",
    state: "enabled",
    error_code: "RICKGENT_RESUME_ACTIVE",
    reason: "Activated by t29: resume of explicit runs uses persisted receipts; response-lost planned retries resolve through typed no-side-effect cleanup; later attempts allocated only after reconciliation.",
    proof_version: "recovery-parity-v1",
    minimum_profile: "m7_resume_reconcile_parity",
  },
  {
    name: "reconciliation",
    state: "enabled",
    error_code: "RICKGENT_RECONCILIATION_ACTIVE",
    reason: "Activated by t29: structured reconciliation uses the shared oracle and transactionally persisted run-attributed receipts; Git subjects and cross-run ticket IDs are ignored.",
    proof_version: "recovery-parity-v1",
    minimum_profile: "m7_resume_reconcile_parity",
  },
  {
    name: "cross_vendor_review",
    state: "enabled",
    error_code: "RICKGENT_CROSS_VENDOR_ACTIVE",
    reason: "Activated by t32: cross-vendor review is permitted only when the canonical observed identities of implementer and reviewer are genuinely distinct (different harness AND model); same-identity requests are rejected.",
    proof_version: "model-identity-corpus-v1",
    minimum_profile: "m8_cross_vendor_distinction",
  },
  {
    name: "automatic_delivery",
    state: "enabled",
    error_code: "RICKGENT_DELIVERY_ACTIVE",
    reason: "Activated by t34: verified push (independent ls-remote OID match) and verified idempotent PR creation (queried head OID and repository identity equality) are required before marking delivered. Retries resolve the same PR without duplicates or false success.",
    proof_version: "delivery-corpus-v1",
    minimum_profile: "m8_verified_delivery",
  },
  {
    name: "raw_shell",
    state: "unavailable",
    error_code: "RICKGENT_RAW_SHELL_UNAVAILABLE",
    reason: "Execution and verification accept structured argv only.",
    proof_version: "none",
    minimum_profile: "none",
  },
] as const;

const ENTRY_BY_NAME = new Map<CapabilityName, CapabilityEntry>(
  ENTRIES.map((entry) => [entry.name, Object.freeze({ ...entry })]),
);

export const INPUT_CONTRACT_ERROR_CODE = "RICKGENT_INPUT_CONTRACT_ERROR";
export const CAPABILITY_UNAVAILABLE_ERROR_CODE = "RICKGENT_CAPABILITY_UNAVAILABLE";
export const INTERNAL_ERROR_CODE = "RICKGENT_INTERNAL_ERROR";
export const OK_CODE = "RICKGENT_OK";

export class RickgentBoundaryError extends Error {
  constructor(
    message: string,
    readonly stableCode: string,
    readonly exitCode: 2 | 3 | 70,
  ) {
    super(message);
    this.name = "RickgentBoundaryError";
  }
}

export class InputContractError extends RickgentBoundaryError {
  constructor(message: string) {
    super(message, INPUT_CONTRACT_ERROR_CODE, 2);
    this.name = "InputContractError";
  }
}

export class CapabilityUnavailableError extends RickgentBoundaryError {
  constructor(readonly capability: CapabilityEntry) {
    super(
      `${capability.error_code}: ${capability.reason}`,
      CAPABILITY_UNAVAILABLE_ERROR_CODE,
      3,
    );
    this.name = "CapabilityUnavailableError";
  }
}

/**
 * A boundary dependency, not a mutable registry. Production entry points use
 * PRODUCTION_CAPABILITY_GATE. Fixtures replace the runtime-gate module only in
 * a separately compiled, package-excluded tree; no caller injects a production
 * gate and no production environment/config adapter exists.
 */
export interface CapabilityGate {
  require(name: CapabilityName): void;
}

export function capabilityRegistry(): readonly CapabilityEntry[] {
  return Object.freeze(
    CAPABILITY_NAMES.map((name) => Object.freeze({ ...getCapability(name) })),
  );
}

export function getCapability(name: CapabilityName): CapabilityEntry {
  const entry = ENTRY_BY_NAME.get(name);
  if (!entry) {
    throw new RickgentBoundaryError(`unknown compiled capability: ${name}`, INTERNAL_ERROR_CODE, 70);
  }
  return entry;
}

export type PublicSurfaceMode =
  | "public_read_only"
  | "public_local_artifact"
  | "public_blocked"
  | "public_input_rejected"
  | "fixture_dependency_only";

export type MutationAuthority = "none" | "local_artifact_only" | "capture_only";

export interface PublicSurfaceEntry {
  readonly surface: string;
  readonly mode: PublicSurfaceMode;
  readonly mutation_authority: MutationAuthority;
  readonly capability: CapabilityName | null;
  readonly capability_state: CapabilityState | "not_applicable";
  readonly result: string;
  readonly exit_code: 0 | 2 | 3 | null;
  readonly stable_code: string | null;
  readonly capability_detail: string | null;
  readonly boundary: string;
}

function capabilitySurface(
  entry: Omit<PublicSurfaceEntry, "capability_state" | "capability_detail"> & {
    readonly capability: CapabilityName;
  },
): PublicSurfaceEntry {
  const capability = getCapability(entry.capability);
  return Object.freeze({
    ...entry,
    capability_state: capability.state,
    capability_detail: capability.error_code,
  });
}

function nonCapabilitySurface(
  entry: Omit<PublicSurfaceEntry, "capability" | "capability_state" | "capability_detail">,
): PublicSurfaceEntry {
  return Object.freeze({
    ...entry,
    capability: null,
    capability_state: "not_applicable",
    capability_detail: null,
  });
}

const PUBLIC_SURFACES: readonly PublicSurfaceEntry[] = Object.freeze([
  capabilitySurface({
    surface: "rickgent build <prd>",
    mode: "public_local_artifact",
    mutation_authority: "local_artifact_only",
    capability: "autonomous_dispatch",
    result: "autonomous dispatch via the AttemptRunner critical section; parallelism and raw shell remain unavailable",
    exit_code: null,
    stable_code: null,
    boundary: "Autonomous dispatch is activated (t22D): the single AttemptRunner owns execution and terminalization. Production requires a validated containment backend and a real model roster; unavailable containment fails closed with a target-never-released proof before any spawn. Parallel dispatch and raw shell remain unavailable. Cross-vendor review is activated (t32). Automatic delivery is activated (t34).",
  }),
  capabilitySurface({
    surface: "rickgent pipeline <prd>",
    mode: "public_local_artifact",
    mutation_authority: "local_artifact_only",
    capability: "autonomous_dispatch",
    result: "autonomous dispatch via the AttemptRunner critical section followed by the cleanup chain; parallelism and raw shell remain unavailable",
    exit_code: null,
    stable_code: null,
    boundary: "Autonomous dispatch is activated (t22D): the single AttemptRunner owns execution and terminalization. Production requires a validated containment backend; unavailable containment fails closed. Parallel dispatch and raw shell remain unavailable. Cross-vendor review is activated (t32). Automatic delivery is activated (t34).",
  }),
  capabilitySurface({
    surface: "explicit build test dependency injection",
    mode: "fixture_dependency_only",
    mutation_authority: "capture_only",
    capability: "autonomous_dispatch",
    result: "implementation_captured_nonterminal",
    exit_code: null,
    stable_code: null,
    boundary: "Exactly one worker in a dedicated run worktree; no trusted commit or gate advancement.",
  }),
  nonCapabilitySurface({
    surface: "rickgent prd --non-interactive [--output <path>]",
    mode: "public_local_artifact",
    mutation_authority: "local_artifact_only",
    result: "resolves the destination and writes or overwrites a deterministic PRD template",
    exit_code: null,
    stable_code: null,
    boundary: "The caller-selected/default path is explicit write authority and may be inside the repository or state root; read-only Git inspection may run, but no agent spawn, Git mutation, or validated lifecycle transition occurs.",
  }),
  nonCapabilitySurface({
    surface: "rickgent citadel [--report <path>]",
    mode: "public_local_artifact",
    mutation_authority: "local_artifact_only",
    result: "reads a diff and may create or overwrite the requested audit report",
    exit_code: null,
    stable_code: null,
    boundary: "The caller-selected report path is explicit write authority and may be inside the repository or state root; read-only Git inspection may run, but no remediation agent, Git mutation, or validated lifecycle transition occurs.",
  }),
  capabilitySurface({
    surface: "build|pipeline --resume",
    mode: "public_local_artifact",
    mutation_authority: "local_artifact_only",
    capability: "resume_retry",
    result: "resumes an explicit run from persisted receipts; response-lost planned retries are cleaned up via typed no-side-effect cleanup; later attempts allocated only after reconciliation",
    exit_code: null,
    stable_code: null,
    boundary: "Resume reads the durable SQLite state store, validates contract/context/oracle compatibility, and resumes cleanup or the next safe phase. Commit prose is never treated as truth; only durable receipts are authority.",
  }),
  nonCapabilitySurface({
    surface: "rickgent retry",
    mode: "public_input_rejected",
    mutation_authority: "none",
    result: "unknown command",
    exit_code: 2,
    stable_code: INPUT_CONTRACT_ERROR_CODE,
    boundary: "Retry has no public CLI command; use `build --resume` for explicit run resume.",
  }),
  capabilitySurface({
    surface: "rickgent reconcile",
    mode: "public_read_only",
    mutation_authority: "none",
    capability: "reconciliation",
    result: "rebuilds derived views from persisted run-attributed receipts; Git subjects and cross-run ticket IDs are ignored",
    exit_code: null,
    stable_code: null,
    boundary: "Reconciliation reads the durable SQLite state store and reports the persisted ticket count. No Git subjects, commit messages, or legacy JSONL claims are imported as truth.",
  }),
  capabilitySurface({
    surface: "build|pipeline --feature|--no-autonomous-pr",
    mode: "public_local_artifact",
    mutation_authority: "local_artifact_only",
    capability: "automatic_delivery",
    result: "delivery configuration accepted; verified push and idempotent PR creation are required before marking delivered",
    exit_code: null,
    stable_code: null,
    boundary: "Automatic delivery is activated (t34): branch push uses the exact delivery OID with independent ls-remote confirmation, and PR creation/resolution requires queried head OID and repository identity equality. Retries resolve the same PR without duplicates. The protected real-provider run remains in t38.",
  }),
  capabilitySurface({
    surface: "build|pipeline --raw-shell",
    mode: "public_blocked",
    mutation_authority: "none",
    capability: "raw_shell",
    result: "raw-shell configuration rejected",
    exit_code: 3,
    stable_code: CAPABILITY_UNAVAILABLE_ERROR_CODE,
    boundary: "Execution and verification accept structured argv only.",
  }),
  capabilitySurface({
    surface: "build|pipeline [--max-concurrent 1]",
    mode: "public_local_artifact",
    mutation_authority: "local_artifact_only",
    capability: "autonomous_dispatch",
    result: "sequential value accepted; dispatch via the AttemptRunner (concurrency >1 rejected)",
    exit_code: null,
    stable_code: null,
    boundary: "Exactly 1 is the only accepted concurrency; production parallelism remains unavailable (t23 proves isolation but does not activate parallel dispatch).",
  }),
  nonCapabilitySurface({
    surface: "build|pipeline --max-concurrent <not-1>",
    mode: "public_input_rejected",
    mutation_authority: "none",
    result: "input contract rejected",
    exit_code: 2,
    stable_code: INPUT_CONTRACT_ERROR_CODE,
    boundary: "Greater, zero, fractional, malformed, and non-finite values fail before capability selection.",
  }),
  nonCapabilitySurface({
    surface: "build|pipeline --max-iterations <N>",
    mode: "public_input_rejected",
    mutation_authority: "none",
    result: "parsed legacy flag rejected as unimplemented",
    exit_code: 2,
    stable_code: INPUT_CONTRACT_ERROR_CODE,
    boundary: "A parsed flag is not an enabled capability.",
  }),
  capabilitySurface({
    surface: "cross-vendor review (routing selects distinct vendor for code_review)",
    mode: "public_read_only",
    mutation_authority: "none",
    capability: "cross_vendor_review",
    result: "cross-vendor review permitted only when observed implementer and reviewer identities are genuinely distinct",
    exit_code: null,
    stable_code: null,
    boundary: "Cross-vendor review is activated (t32): the router selects a different vendor for code_review, and the distinction authority verifies that observed harness AND model both differ. Same-identity, missing, spoofed, or stale reviewer identity blocks the cross-vendor claim without invalidating same-vendor independent review.",
  }),
  nonCapabilitySurface({
    surface: "rickgent status [--deep]",
    mode: "public_read_only",
    mutation_authority: "none",
    result: "canonical SQLite lifecycle observation; --deep also runs the doctor health audit",
    exit_code: null,
    stable_code: null,
    boundary: "Healthy observations exit 0; deep health failure exits 1; neither can terminalize a run.",
  }),
  nonCapabilitySurface({
    surface: "rickgent doctor [--json]",
    mode: "public_read_only",
    mutation_authority: "none",
    result: "health and attachment audit",
    exit_code: null,
    stable_code: null,
    boundary: "Healthy audit exits 0; toolchain, platform, or attachment failure exits 1.",
  }),
  nonCapabilitySurface({
    surface: "rickgent <command> --help",
    mode: "public_read_only",
    mutation_authority: "none",
    result: "claim observation only",
    exit_code: 0,
    stable_code: OK_CODE,
    boundary: "Help text does not activate a mutating capability.",
  }),
]);

export function publicSurfaceRegistry(): readonly PublicSurfaceEntry[] {
  return Object.freeze(PUBLIC_SURFACES.map((entry) => Object.freeze({ ...entry })));
}

export function formatTerminalSummary(): string {
  return (
    `ready_for_delivery=${TERMINAL_SEMANTICS.ready_for_delivery} means local oracle acceptance plus ` +
    "cleanup/ownership release; " +
    `delivered=${TERMINAL_SEMANTICS.delivered} requires verified remote branch and PR-head observations; ` +
    "Done is a delivered-only alias."
  );
}

export function formatReliabilityPreviewBanner(): string {
  const autonomous = getCapability("autonomous_dispatch");
  const unavailable = capabilityRegistry()
    .filter((entry) => entry.state === "unavailable")
    .map((entry) => `${entry.name} (${entry.error_code})`)
    .join(", ");
  return [
    `${RELEASE_LABEL} (${RELEASE_CHANNEL})`,
    `${CAPABILITY_UNAVAILABLE_ERROR_CODE} (exit 3): public autonomous dispatch is ${autonomous.state} ` +
      `(${autonomous.error_code}); explicit build test dependency injection is sequential, dedicated-worktree, ` +
      "capture-only, and nonterminal.",
    `Unavailable capabilities: ${unavailable}.`,
    formatTerminalSummary(),
  ].join("\n");
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function formatPublicSurfaceMatrixMarkdown(): string {
  const header = [
    "| Surface | Mode | Mutation authority | Capability/state | Result | Exit | Stable code | Capability detail | Boundary |",
    "|---|---|---|---|---|---:|---|---|---|",
  ];
  const rows = publicSurfaceRegistry().map((entry) => {
    const capability = entry.capability === null
      ? "—"
      : `${entry.capability}/${entry.capability_state}`;
    return `| ${[
      entry.surface,
      entry.mode,
      entry.mutation_authority,
      capability,
      entry.result,
      entry.exit_code === null ? "—" : String(entry.exit_code),
      entry.stable_code ?? "—",
      entry.capability_detail ?? "—",
      entry.boundary,
    ].map(markdownCell).join(" | ")} |`;
  });
  return [...header, ...rows].join("\n");
}

export function formatPublicSurfaceMatrixBlock(): string {
  return `${CLAIM_MATRIX_BEGIN}\n${formatPublicSurfaceMatrixMarkdown()}\n${CLAIM_MATRIX_END}`;
}

export function formatPublicSurfaceMatrixText(): string {
  return [
    "Public command/capability matrix:",
    ...publicSurfaceRegistry().map((entry) =>
      `  ${entry.surface}: mode=${entry.mode} mutation=${entry.mutation_authority} ` +
      `capability=${entry.capability ?? "none"}/${entry.capability_state} result=${entry.result} ` +
      `exit=${entry.exit_code ?? "n/a"} code=${entry.stable_code ?? "n/a"} ` +
      `detail=${entry.capability_detail ?? "n/a"} boundary=${entry.boundary}`,
    ),
  ].join("\n");
}

export const PRODUCTION_CAPABILITY_GATE: CapabilityGate = Object.freeze({
  require(name: CapabilityName): void {
    const entry = getCapability(name);
    if (entry.state !== "enabled") throw new CapabilityUnavailableError(entry);
  },
});

// These are retired production controls. They are named only here so their
// presence can be rejected; they never select a registry state or skip a gate.
export const REJECTED_PRODUCTION_BYPASSES = Object.freeze([
  "RICKGENT_SKIP_POLICY_ATTACH",
  "RICKGENT_SKIP_CONFORMANCE",
  "RICKGENT_SKIP_DESLOP",
] as const);

export function assertNoProductionBypasses(env: NodeJS.ProcessEnv): void {
  const present = REJECTED_PRODUCTION_BYPASSES.filter((name) => env[name] !== undefined);
  if (present.length > 0) {
    throw new InputContractError(
      `retired production bypass variable(s) are forbidden: ${present.join(", ")}`,
    );
  }
}

export function formatCapabilityReport(title = "Compiled capability registry"): string {
  return [
    `${RELEASE_LABEL} (${RELEASE_CHANNEL})`,
    formatTerminalSummary(),
    title,
    ...capabilityRegistry().map(
      (entry) =>
        `  ${entry.name}: state=${entry.state} code=${entry.error_code} ` +
        `proof=${entry.proof_version} reason=${entry.reason}`,
    ),
  ].join("\n");
}
