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
    state: "fixture_only",
    error_code: "RICKGENT_AUTONOMOUS_FIXTURE_ONLY",
    reason: "M1 permits mutation-capture fixtures only; it cannot terminalize a ticket.",
    proof_version: "native-policy-lifecycle-v1",
    minimum_profile: "m2_local_structured_worker",
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
    state: "unavailable",
    error_code: "RICKGENT_RESUME_UNAVAILABLE",
    reason: "Transactional lifecycle and oracle parity are not yet proven.",
    proof_version: "recovery-parity-v1",
    minimum_profile: "m5_local_lifecycle",
  },
  {
    name: "reconciliation",
    state: "unavailable",
    error_code: "RICKGENT_RECONCILIATION_UNAVAILABLE",
    reason: "Reconciliation cannot precede authoritative persisted recovery.",
    proof_version: "recovery-parity-v1",
    minimum_profile: "m5_local_lifecycle",
  },
  {
    name: "cross_vendor_review",
    state: "unavailable",
    error_code: "RICKGENT_CROSS_VENDOR_UNAVAILABLE",
    reason: "Requested identity is not independently observed identity.",
    proof_version: "model-identity-corpus-v1",
    minimum_profile: "m6_protected_identity",
  },
  {
    name: "automatic_delivery",
    state: "unavailable",
    error_code: "RICKGENT_DELIVERY_UNAVAILABLE",
    reason: "Push and PR observations are not implemented and verified.",
    proof_version: "delivery-corpus-v1",
    minimum_profile: "m6_protected_delivery",
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
 * PRODUCTION_CAPABILITY_GATE. Tests that exercise historical fixture paths may
 * inject a gate explicitly; no production environment/config adapter exists.
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

export function formatCapabilityReport(title = "rickgent startup capabilities"): string {
  return [
    title,
    ...capabilityRegistry().map(
      (entry) =>
        `  ${entry.name}: state=${entry.state} code=${entry.error_code} ` +
        `proof=${entry.proof_version} reason=${entry.reason}`,
    ),
  ].join("\n");
}
