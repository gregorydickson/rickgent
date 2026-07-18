import { createHash } from "node:crypto";
import { canonicalJson } from "../contracts/ticket-contract.js";
import { GATE_STATUSES, ORACLE_REFERENCE_KINDS, RESOURCE_KINDS } from "./schema.js";

export const RICKGENT_ORACLE_VERSION = "rickgent.oracle.v2" as const;

export type OracleReferenceKind = (typeof ORACLE_REFERENCE_KINDS)[number];
export type OracleGateStatus = (typeof GATE_STATUSES)[number];
export type OracleDecisionResult = "accepted" | "rejected";

export const REQUIRED_ORACLE_INPUT_CLASSES = Object.freeze([
  "run_manifest",
  "ticket_contract",
  "execution_context",
  "complete_target_proof_set",
  "required_gates",
  "independent_review",
  "commit_attribution",
  "cleanup_eligibility",
  "attempt_resource_snapshots",
  "lease_snapshots",
] as const);

export const CONDITIONAL_ORACLE_INPUT_CLASSES = Object.freeze([
  "dependency_edges",
  "remediation_cycles",
] as const);

export interface AttemptOracleScope {
  readonly runId: string;
  readonly ticketInstanceId: string;
  readonly attemptId: string;
}

export interface OracleGateProjection {
  readonly gateId: string;
  readonly evaluationOrdinal: number;
  readonly required: boolean;
  readonly status: OracleGateStatus;
}

export interface OracleNormalizedDeltaEntry {
  readonly path: string;
  readonly changeKind: "create" | "modify" | "delete" | "rename";
  readonly fromPath: string | null;
  readonly beforeMode: string | null;
  readonly afterMode: string | null;
}

export interface OracleAttributionDigests {
  readonly candidateDiffDigest: string;
  readonly pathSetDigest: string;
  readonly changeKindSetDigest: string;
  readonly modeSetDigest: string;
}

/**
 * A transaction-resolved immutable reference. `contentDigest` is the digest
 * copied into oracle_input_references; `resolvedContentDigest` is independently
 * derived from the row resolved in the same transaction.
 *
 * Lineage is the referenced row's natural lineage: manifests are run-scoped,
 * contracts and dependency edges are ticket-scoped, and all other kinds are
 * attempt-scoped.
 */
export interface OracleResolvedReferenceProjection {
  readonly ordinal: number;
  readonly referenceKind: OracleReferenceKind;
  readonly referenceId: string;
  readonly runId: string;
  readonly ticketInstanceId: string | null;
  readonly attemptId: string | null;
  readonly oracleVersion: string;
  readonly contentDigest: string;
  readonly resolvedContentDigest: string;
  /** Exact digest material for sealed-plan, dependency, review, or evidence semantics. */
  readonly sealedContent?: Readonly<Record<string, unknown>>;
  readonly gate?: OracleGateProjection;
}

export interface AttemptOracleProjection {
  readonly oracleVersion: string;
  readonly scope: AttemptOracleScope;
  readonly references: readonly OracleResolvedReferenceProjection[];
}

export interface OracleEvaluatedReference {
  readonly ordinal: number | null;
  readonly referenceKind: string;
  readonly referenceId: string | null;
  readonly runId: string | null;
  readonly ticketInstanceId: string | null;
  readonly attemptId: string | null;
  readonly oracleVersion: string | null;
  readonly contentDigest: string | null;
  readonly resolvedContentDigest: string | null;
  readonly sealedContent: Readonly<Record<string, unknown>> | null;
  readonly sealedContentState: "absent" | "exact" | "invalid";
  readonly gate: Readonly<{
    gateId: string | null;
    evaluationOrdinal: number | null;
    required: boolean | null;
    status: string | null;
  }> | null;
}

export interface OraclePersistencePlan {
  readonly oracleVersion: string;
  readonly scope: AttemptOracleScope;
  readonly result: OracleDecisionResult;
  readonly reasons: readonly string[];
  readonly inputSetDigest: string;
  readonly outputDigest: string;
  readonly referenceIntegrity: "exact" | "invalid";
  readonly references: readonly OracleEvaluatedReference[];
}

export interface OraclePersistenceIdentity {
  readonly oracleDecisionId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export type OraclePersistenceRow = Readonly<Record<string, string | number | null>>;

export interface OraclePersistenceRows {
  readonly decision: OraclePersistenceRow;
  readonly references: readonly OraclePersistenceRow[];
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REFERENCE_KINDS = new Set<string>(ORACLE_REFERENCE_KINDS);
const LEGACY_REFERENCE_KINDS = new Set<string>(["cleanup_record", "process_receipt"]);
const GATE_STATUS_SET = new Set<string>(GATE_STATUSES);
const ISSUED_PLANS = new WeakSet<object>();

const REFERENCE_ID_COLUMN: Readonly<Record<OracleReferenceKind, string>> = Object.freeze({
  run_manifest: "run_manifest_digest",
  ticket_contract: "contract_digest",
  execution_context: "context_id",
  evidence: "evidence_id",
  gate_result: "gate_result_id",
  review_record: "review_record_id",
  commit_attribution: "commit_attribution_id",
  cleanup_record: "cleanup_record_id",
  dependency_edge: "dependency_digest",
  attempt_resource_snapshot: "resource_snapshot_evidence_id",
  lease_snapshot: "lease_snapshot_evidence_id",
  process_receipt: "process_receipt_id",
});

const REFERENCE_ID_COLUMNS = Object.freeze(Object.values(REFERENCE_ID_COLUMN));
const REQUIRED_CLASS_KIND = Object.freeze([
  ["run_manifest", "run_manifest"],
  ["ticket_contract", "ticket_contract"],
  ["execution_context", "execution_context"],
  ["required_gates", "gate_result"],
  ["independent_review", "review_record"],
  ["commit_attribution", "commit_attribution"],
  ["attempt_resource_snapshots", "attempt_resource_snapshot"],
  ["lease_snapshots", "lease_snapshot"],
] as const);

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a nonempty canonical string`);
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) return null;
  return value as readonly string[];
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) ? value as number : null;
}

const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_REGULAR_MODE = /^(?:100644|100755)$/;
const CHANGE_KIND_SET = new Set(["create", "modify", "delete", "rename"]);

function compareNullableText(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left < right ? -1 : 1;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function normalizedDeltaEntry(value: unknown): OracleNormalizedDeltaEntry | null {
  const entry = objectValue(value);
  if (entry === null) return null;
  const path = nullableText(entry.path);
  const changeKind = nullableText(entry.change_kind);
  const fromPath = entry.from_path === null ? null : nullableText(entry.from_path);
  const beforeMode = entry.before_mode === null ? null : nullableText(entry.before_mode);
  const afterMode = entry.after_mode === null ? null : nullableText(entry.after_mode);
  if (
    path === null || path.length === 0 || path !== path.trim() || path.startsWith("/") || path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    changeKind === null || !CHANGE_KIND_SET.has(changeKind) ||
    (entry.from_path !== null && fromPath === null) || (entry.before_mode !== null && beforeMode === null) ||
    (entry.after_mode !== null && afterMode === null) ||
    (fromPath !== null && (fromPath.length === 0 || fromPath !== fromPath.trim() || fromPath.startsWith("/") ||
      fromPath.includes("\\") || fromPath.split("/").some((part) => part === "" || part === "." || part === ".."))) ||
    (beforeMode !== null && !GIT_REGULAR_MODE.test(beforeMode) && !(changeKind === "delete" && beforeMode === "120000")) ||
    (afterMode !== null && !GIT_REGULAR_MODE.test(afterMode)) ||
    (changeKind === "create" && (fromPath !== null || beforeMode !== null || afterMode === null)) ||
    (changeKind === "modify" && (fromPath !== null || beforeMode === null || afterMode === null)) ||
    (changeKind === "delete" && (fromPath !== null || beforeMode === null || afterMode !== null)) ||
    (changeKind === "rename" && (fromPath === null || fromPath === path || beforeMode === null || afterMode === null))
  ) return null;
  return deepFreeze({
    path,
    changeKind: changeKind as OracleNormalizedDeltaEntry["changeKind"],
    fromPath,
    beforeMode,
    afterMode,
  });
}

function orderedDelta(delta: readonly OracleNormalizedDeltaEntry[]): readonly OracleNormalizedDeltaEntry[] {
  return [...delta].sort((left, right) =>
    compareText(left.path, right.path) || compareNullableText(left.fromPath, right.fromPath) ||
    compareText(left.changeKind, right.changeKind) || compareNullableText(left.beforeMode, right.beforeMode) ||
    compareNullableText(left.afterMode, right.afterMode));
}

/** Canonical digests for the exact normalized delta sealed into attribution evidence. */
export function deriveOracleAttributionDigests(
  delta: readonly OracleNormalizedDeltaEntry[],
): OracleAttributionDigests {
  if (!Array.isArray(delta) || delta.length === 0) throw new TypeError("oracle normalized delta must be nonempty");
  const normalized = delta.map((entry) => normalizedDeltaEntry({
    path: entry.path,
    change_kind: entry.changeKind,
    from_path: entry.fromPath,
    before_mode: entry.beforeMode,
    after_mode: entry.afterMode,
  }));
  if (normalized.some((entry) => entry === null)) throw new TypeError("oracle normalized delta entry is invalid");
  const entries = orderedDelta(normalized as OracleNormalizedDeltaEntry[]);
  return deepFreeze({
    candidateDiffDigest: digest(entries.map((entry) => ({
      path: entry.path,
      from_path: entry.fromPath,
      change_kind: entry.changeKind,
      before_mode: entry.beforeMode,
      after_mode: entry.afterMode,
    }))),
    pathSetDigest: digest(entries.map((entry) => ({ path: entry.path, from_path: entry.fromPath }))),
    changeKindSetDigest: digest(entries.map((entry) => ({
      path: entry.path,
      from_path: entry.fromPath,
      change_kind: entry.changeKind,
    }))),
    modeSetDigest: digest(entries.map((entry) => ({
      path: entry.path,
      from_path: entry.fromPath,
      before_mode: entry.beforeMode,
      after_mode: entry.afterMode,
    }))),
  });
}

interface SealedScopeEntry {
  readonly path: string;
  readonly changeKind: OracleNormalizedDeltaEntry["changeKind"];
  readonly directory: boolean;
  readonly fromPath: string | null;
}

function sealedScopeEntry(value: unknown): SealedScopeEntry | null {
  const entry = objectValue(value);
  if (entry === null) return null;
  const path = nullableText(entry.path);
  const changeKind = nullableText(entry.change_kind);
  const directory = typeof entry.directory === "boolean" ? entry.directory : null;
  const fromPath = entry.from_path === undefined ? null : nullableText(entry.from_path);
  if (
    path === null || path.length === 0 || changeKind === null || !CHANGE_KIND_SET.has(changeKind) || directory === null ||
    (changeKind === "rename" ? fromPath === null || fromPath === path : fromPath !== null)
  ) return null;
  return deepFreeze({
    path,
    changeKind: changeKind as SealedScopeEntry["changeKind"],
    directory,
    fromPath,
  });
}

function pathWithin(path: string, root: string, directory: boolean): boolean {
  return path === root || (directory && path.startsWith(`${root}/`));
}

function deltaMatchesScope(delta: OracleNormalizedDeltaEntry, scope: SealedScopeEntry): boolean {
  if (!pathWithin(delta.path, scope.path, scope.directory)) return false;
  if (scope.directory) {
    return (scope.changeKind === "modify" || delta.changeKind === scope.changeKind) &&
      (delta.fromPath === null || pathWithin(delta.fromPath, scope.path, true));
  }
  if (delta.changeKind !== scope.changeKind) return false;
  if (scope.changeKind !== "rename") return delta.fromPath === null;
  return delta.fromPath !== null && scope.fromPath === delta.fromPath;
}

function hasDuplicateDeltaIdentity(delta: readonly OracleNormalizedDeltaEntry[]): boolean {
  const identities = delta.map((entry) => `${entry.path}\u0000${entry.fromPath ?? ""}`);
  return new Set(identities).size !== identities.length;
}

function normalizeSealedContent(value: unknown): Readonly<{
  content: Readonly<Record<string, unknown>> | null;
  state: "absent" | "exact" | "invalid";
}> {
  if (value === undefined) return { content: null, state: "absent" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { content: null, state: "invalid" };
  }
  try {
    const content = JSON.parse(canonicalJson(value)) as Record<string, unknown>;
    return deepFreeze({ content: deepFreeze(content), state: "exact" as const });
  } catch {
    return { content: null, state: "invalid" };
  }
}

function normalizeReference(value: unknown): OracleEvaluatedReference {
  const reference = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const gateValue = reference.gate;
  const gate = gateValue !== null && typeof gateValue === "object"
    ? gateValue as Record<string, unknown>
    : null;
  const sealed = normalizeSealedContent(reference.sealedContent);
  return deepFreeze({
    ordinal: Number.isSafeInteger(reference.ordinal) ? reference.ordinal as number : null,
    referenceKind: typeof reference.referenceKind === "string" ? reference.referenceKind : "<invalid>",
    referenceId: nullableText(reference.referenceId),
    runId: nullableText(reference.runId),
    ticketInstanceId: nullableText(reference.ticketInstanceId),
    attemptId: nullableText(reference.attemptId),
    oracleVersion: nullableText(reference.oracleVersion),
    contentDigest: nullableText(reference.contentDigest),
    resolvedContentDigest: nullableText(reference.resolvedContentDigest),
    sealedContent: sealed.content,
    sealedContentState: sealed.state,
    gate: gate === null ? null : deepFreeze({
      gateId: nullableText(gate.gateId),
      evaluationOrdinal: safeInteger(gate.evaluationOrdinal),
      required: typeof gate.required === "boolean" ? gate.required : null,
      status: nullableText(gate.status),
    }),
  });
}

function expectedLineage(
  kind: string,
  scope: AttemptOracleScope,
): Readonly<{ runId: string; ticketInstanceId: string | null; attemptId: string | null }> | null {
  if (kind === "run_manifest") return { runId: scope.runId, ticketInstanceId: null, attemptId: null };
  if (kind === "ticket_contract" || kind === "dependency_edge") {
    return { runId: scope.runId, ticketInstanceId: scope.ticketInstanceId, attemptId: null };
  }
  if (REFERENCE_KINDS.has(kind)) {
    return { runId: scope.runId, ticketInstanceId: scope.ticketInstanceId, attemptId: scope.attemptId };
  }
  return null;
}

class IssuedOraclePersistencePlan implements OraclePersistencePlan {
  readonly oracleVersion: string;
  readonly scope: AttemptOracleScope;
  readonly result: OracleDecisionResult;
  readonly reasons: readonly string[];
  readonly inputSetDigest: string;
  readonly outputDigest: string;
  readonly referenceIntegrity: "exact" | "invalid";
  readonly references: readonly OracleEvaluatedReference[];

  constructor(plan: OraclePersistencePlan) {
    this.oracleVersion = plan.oracleVersion;
    this.scope = deepFreeze({ ...plan.scope });
    this.result = plan.result;
    this.reasons = deepFreeze([...plan.reasons]);
    this.inputSetDigest = plan.inputSetDigest;
    this.outputDigest = plan.outputDigest;
    this.referenceIntegrity = plan.referenceIntegrity;
    this.references = deepFreeze(plan.references.map((reference) => deepFreeze({
      ...reference,
      sealedContent: reference.sealedContent === null ? null : deepFreeze({ ...reference.sealedContent }),
      gate: reference.gate === null ? null : deepFreeze({ ...reference.gate }),
    })));
    ISSUED_PLANS.add(this);
    Object.freeze(this);
  }
}

/** Pure evaluation over references already resolved in one Store transaction. */
export function evaluateAttemptOracle(input: AttemptOracleProjection): OraclePersistencePlan {
  if (input === null || typeof input !== "object") throw new TypeError("oracle projection must be an object");
  const oracleVersion = requiredText(input.oracleVersion, "oracleVersion");
  if (input.scope === null || typeof input.scope !== "object") throw new TypeError("oracle scope must be an object");
  const scope = deepFreeze({
    runId: requiredText(input.scope.runId, "scope.runId"),
    ticketInstanceId: requiredText(input.scope.ticketInstanceId, "scope.ticketInstanceId"),
    attemptId: requiredText(input.scope.attemptId, "scope.attemptId"),
  });
  if (!Array.isArray(input.references)) throw new TypeError("oracle references must be an array");
  const references = deepFreeze(input.references.map(normalizeReference));
  const reasons = new Set<string>();
  let integrityExact = true;

  if (oracleVersion !== RICKGENT_ORACLE_VERSION) {
    reasons.add(`unsupported_oracle_version:${oracleVersion}`);
    integrityExact = false;
  }

  const observedKinds = new Set<string>();
  const observedIdentities = new Set<string>();
  const observedContent = new Set<string>();
  const observedRequiredGateIds = new Map<string, number>();
  let requiredGateCount = 0;

  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index]!;
    const label = `${index}:${reference.referenceKind}:${reference.referenceId ?? "<invalid>"}`;
    if (reference.ordinal !== index) {
      reasons.add(`reference_ordinal_mismatch:${label}`);
      integrityExact = false;
    }
    if (!REFERENCE_KINDS.has(reference.referenceKind)) {
      reasons.add(`reference_kind_invalid:${label}`);
      integrityExact = false;
      continue;
    }
    if (LEGACY_REFERENCE_KINDS.has(reference.referenceKind)) {
      reasons.add(`legacy_reference_kind_forbidden:${label}`);
      integrityExact = false;
    }
    observedKinds.add(reference.referenceKind);
    if (reference.referenceId === null || reference.referenceId.length === 0 || reference.referenceId !== reference.referenceId.trim()) {
      reasons.add(`reference_identity_invalid:${label}`);
      integrityExact = false;
    } else {
      const identity = `${reference.referenceKind}\u0000${reference.referenceId}`;
      if (observedIdentities.has(identity)) {
        reasons.add(`reference_identity_duplicate:${label}`);
        integrityExact = false;
      }
      observedIdentities.add(identity);
    }

    if (reference.oracleVersion !== oracleVersion) {
      reasons.add(`reference_oracle_version_mismatch:${label}`);
      integrityExact = false;
    }
    const lineage = expectedLineage(reference.referenceKind, scope);
    if (
      lineage === null || reference.runId !== lineage.runId ||
      reference.ticketInstanceId !== lineage.ticketInstanceId || reference.attemptId !== lineage.attemptId
    ) {
      reasons.add(`reference_lineage_mismatch:${label}`);
      integrityExact = false;
    }

    if (reference.contentDigest === null || !DIGEST.test(reference.contentDigest)) {
      reasons.add(`reference_content_digest_invalid:${label}`);
      integrityExact = false;
    }
    if (reference.resolvedContentDigest === null || !DIGEST.test(reference.resolvedContentDigest)) {
      reasons.add(`reference_resolved_digest_invalid:${label}`);
      integrityExact = false;
    }
    if (reference.contentDigest !== reference.resolvedContentDigest) {
      reasons.add(`reference_content_digest_mismatch:${label}`);
      integrityExact = false;
    }
    if (reference.sealedContentState === "invalid") {
      reasons.add(`reference_sealed_content_invalid:${label}`);
      integrityExact = false;
    } else if (
      reference.sealedContentState === "exact" && reference.sealedContent !== null &&
      digest(reference.sealedContent) !== reference.contentDigest
    ) {
      reasons.add(`reference_sealed_content_digest_mismatch:${label}`);
      integrityExact = false;
    }
    if (reference.contentDigest !== null) {
      const contentIdentity = `${reference.referenceKind}\u0000${reference.contentDigest}`;
      if (observedContent.has(contentIdentity)) {
        reasons.add(`reference_content_duplicate:${label}`);
        integrityExact = false;
      }
      observedContent.add(contentIdentity);
    }

    if (reference.referenceKind === "gate_result") {
      const gateContent = reference.sealedContent;
      const sealedRequired = gateContent?.required === 1 ? true : gateContent?.required === 0 ? false : gateContent?.required;
      if (
        reference.gate === null || reference.gate.gateId === null || reference.gate.evaluationOrdinal === null ||
        reference.gate.evaluationOrdinal < 0 || reference.gate.required === null || reference.gate.status === null ||
        !GATE_STATUS_SET.has(reference.gate.status) || reference.sealedContentState !== "exact" || gateContent === null ||
        gateContent.gate_id !== reference.gate.gateId || gateContent.evaluation_ordinal !== reference.gate.evaluationOrdinal ||
        sealedRequired !== reference.gate.required || gateContent.status !== reference.gate.status ||
        !GIT_OID.test(nullableText(gateContent.candidate_tree_oid) ?? "") ||
        !DIGEST.test(nullableText(gateContent.candidate_diff_digest) ?? "")
      ) {
        reasons.add(`gate_projection_invalid:${label}`);
        integrityExact = false;
      } else if (reference.gate.required) {
        requiredGateCount += 1;
        observedRequiredGateIds.set(
          reference.gate.gateId,
          (observedRequiredGateIds.get(reference.gate.gateId) ?? 0) + 1,
        );
        if (reference.gate.status !== "passed") reasons.add(`required_gate_blocking:${reference.referenceId}:${reference.gate.status}`);
      }
    } else if (reference.gate !== null) {
      reasons.add(`unexpected_gate_projection:${label}`);
      integrityExact = false;
    }
  }

  for (const [requiredClass, kind] of REQUIRED_CLASS_KIND) {
    if (!observedKinds.has(kind)) reasons.add(`missing_input_class:${requiredClass}`);
  }
  const cleanupEligibilityReferences = references.filter((reference) =>
    reference.referenceKind === "evidence" && reference.sealedContent?.oracle_input_class === "cleanup_eligibility"
  );
  const targetProofSetReferences = references.filter((reference) =>
    reference.referenceKind === "evidence" && reference.sealedContent?.oracle_input_class === "complete_target_proof_set"
  );
  if (targetProofSetReferences.length !== 1) {
    reasons.add(`complete_target_proof_set_cardinality:${targetProofSetReferences.length}`);
  }
  const targetProofSet = targetProofSetReferences[0];
  if (targetProofSet !== undefined) {
    const content = targetProofSet.sealedContent;
    const targetProofs = Array.isArray(content?.target_proofs) ? content.target_proofs : null;
    const normalizedProofs = targetProofs?.map((proof) => objectValue(proof)) ?? null;
    if (
      targetProofSet.sealedContentState !== "exact" || content === null ||
      nullableText(content.target_proof_set_id) === null || content.attempt_id !== scope.attemptId ||
      nullableText(content.ownership_id) === null || safeInteger(content.owner_generation) === null ||
      nullableText(content.ownership_context_digest) === null ||
      !DIGEST.test(nullableText(content.target_proof_set_digest) ?? "") ||
      safeInteger(content.target_count) === null || safeInteger(content.target_count) !== targetProofs?.length ||
      normalizedProofs === null || normalizedProofs.length === 0 || normalizedProofs.some((proof) =>
        proof === null || nullableText(proof.phase_execution_id) === null ||
        !["terminal_process", "never_released"].includes(nullableText(proof.proof_kind) ?? "") ||
        !DIGEST.test(nullableText(proof.member_digest) ?? "")
      ) || new Set(normalizedProofs.map((proof) => nullableText(proof?.phase_execution_id))).size !== normalizedProofs.length
    ) {
      reasons.add(`complete_target_proof_set_projection_invalid:${targetProofSet.referenceId ?? "<invalid>"}`);
      integrityExact = false;
    }
  }
  if (cleanupEligibilityReferences.length !== 1) {
    reasons.add(`cleanup_eligibility_cardinality:${cleanupEligibilityReferences.length}`);
  }
  const cleanupEligibility = cleanupEligibilityReferences[0];
  if (cleanupEligibility !== undefined) {
    const content = cleanupEligibility.sealedContent;
    const claimSnapshots = Array.isArray(content?.claim_snapshot_evidence_ids)
      ? content.claim_snapshot_evidence_ids
      : null;
    if (
      cleanupEligibility.sealedContentState !== "exact" || content === null ||
      nullableText(content.eligibility_id) === null || content.attempt_id !== scope.attemptId ||
      nullableText(content.ownership_id) === null || safeInteger(content.owner_generation) === null ||
      safeInteger(content.ownership_state_version) === null || nullableText(content.ownership_context_digest) === null ||
      nullableText(content.commit_intent_id) === null || nullableText(content.commit_attribution_id) === null ||
      !GIT_OID.test(nullableText(content.candidate_oid) ?? "") ||
      !GIT_OID.test(nullableText(content.baseline_oid) ?? "") ||
      content.delivery_observed_oid !== content.baseline_oid || nullableText(content.delivery_ref) === null ||
      nullableText(content.attempt_ref) === null || content.attempt_ref_observed_oid !== content.candidate_oid ||
      !DIGEST.test(nullableText(content.claim_preimage_digest) ?? "") ||
      nullableText(content.ownership_snapshot_evidence_id) === null || claimSnapshots === null ||
      claimSnapshots.length !== RESOURCE_KINDS.length || claimSnapshots.some((id) => nullableText(id) === null) ||
      new Set(claimSnapshots).size !== claimSnapshots.length ||
      nullableText(content.target_proof_set_id) === null ||
      !DIGEST.test(nullableText(content.target_proof_set_digest) ?? "") ||
      (safeInteger(content.target_proof_count) ?? -1) < 1 ||
      content.target_proof_set_id !== targetProofSet?.sealedContent?.target_proof_set_id ||
      content.target_proof_set_digest !== targetProofSet?.sealedContent?.target_proof_set_digest ||
      content.target_proof_count !== targetProofSet?.sealedContent?.target_count
    ) {
      reasons.add(`cleanup_eligibility_projection_invalid:${cleanupEligibility.referenceId ?? "<invalid>"}`);
      integrityExact = false;
    }
  }
  if (requiredGateCount === 0) reasons.add("required_gate_missing");

  const manifestReferences = references.filter((reference) => reference.referenceKind === "run_manifest");
  const contractReferences = references.filter((reference) => reference.referenceKind === "ticket_contract");
  if (manifestReferences.length !== 1) reasons.add(`sealed_manifest_cardinality:${manifestReferences.length}`);
  if (contractReferences.length !== 1) reasons.add(`sealed_contract_cardinality:${contractReferences.length}`);

  const manifestReference = manifestReferences[0];
  const contractReference = contractReferences[0];
  let contractId: string | null = null;
  let dependencies: readonly string[] | null = null;
  let remediationLimit: number | null = null;
  let maxReviewCycles: number | null = null;
  let requiredVerificationIds: readonly string[] | null = null;
  let contractScope: readonly SealedScopeEntry[] | null = null;

  if (contractReference !== undefined) {
    const content = contractReference.sealedContent;
    const budgets = objectValue(content?.budgets);
    contractId = nullableText(content?.id);
    dependencies = stringArray(content?.depends_on);
    remediationLimit = safeInteger(budgets?.remediation_limit);
    maxReviewCycles = safeInteger(budgets?.max_review_cycles);
    const verifications = Array.isArray(content?.verifications) ? content.verifications : null;
    const scopeEntries = Array.isArray(content?.scope) ? content.scope.map(sealedScopeEntry) : null;
    contractScope = scopeEntries !== null && scopeEntries.every((entry) => entry !== null)
      ? scopeEntries as readonly SealedScopeEntry[]
      : null;
    const verificationIds = verifications === null ? null : verifications
      .map((verification) => nullableText(objectValue(verification)?.id))
      .filter((id): id is string => id !== null);
    requiredVerificationIds = verificationIds;
    if (
      contractReference.sealedContentState !== "exact" || content === null || contractId === null ||
      dependencies === null || remediationLimit === null || remediationLimit < 0 ||
      maxReviewCycles === null || maxReviewCycles < 1 || verifications === null || verificationIds === null ||
      verificationIds.length !== verifications.length || verificationIds.length < 1 ||
      new Set(verificationIds).size !== verificationIds.length ||
      new Set(dependencies).size !== dependencies.length ||
      contractScope === null || contractScope.length < 1 ||
      contractReference.referenceId !== contractReference.contentDigest
    ) {
      reasons.add("sealed_contract_projection_invalid");
      integrityExact = false;
    }
  }

  if (requiredVerificationIds !== null) {
    for (const gateId of requiredVerificationIds) {
      if (observedRequiredGateIds.get(gateId) !== 1) reasons.add(`required_gate_missing_or_duplicate:${gateId}`);
    }
    for (const gateId of observedRequiredGateIds.keys()) {
      if (!requiredVerificationIds.includes(gateId)) reasons.add(`required_gate_unsealed:${gateId}`);
    }
  }

  if (manifestReference !== undefined) {
    const content = manifestReference.sealedContent;
    const tickets = Array.isArray(content?.tickets) ? content.tickets : null;
    const ticket = tickets?.find((value) => objectValue(value)?.ticket_id === contractId);
    const ticketContent = objectValue(ticket);
    const manifestDependencies = stringArray(ticketContent?.depends_on_ticket_ids);
    if (
      manifestReference.sealedContentState !== "exact" || content === null || content.oracle_version !== oracleVersion ||
      tickets === null || ticketContent === null || contractReference === undefined ||
      ticketContent.contract_digest !== contractReference.referenceId || manifestDependencies === null ||
      dependencies === null || canonicalJson(manifestDependencies) !== canonicalJson(dependencies) ||
      manifestReference.referenceId !== manifestReference.contentDigest
    ) {
      reasons.add("sealed_manifest_projection_invalid");
      integrityExact = false;
    }
  }

  if (dependencies !== null && contractId !== null) {
    const dependencyReferences = references.filter((reference) => reference.referenceKind === "dependency_edge");
    const observedDependencies = new Map<string, number>();
    for (const reference of dependencyReferences) {
      const content = reference.sealedContent;
      const dependsOn = nullableText(content?.depends_on_ticket_id);
      if (
        reference.sealedContentState !== "exact" || content === null || dependsOn === null ||
        content.run_id !== scope.runId || content.ticket_id !== contractId ||
        reference.referenceId !== reference.contentDigest
      ) {
        reasons.add(`dependency_projection_invalid:${reference.referenceId ?? "<invalid>"}`);
        integrityExact = false;
        continue;
      }
      observedDependencies.set(dependsOn, (observedDependencies.get(dependsOn) ?? 0) + 1);
    }
    for (const dependency of dependencies) {
      if (observedDependencies.get(dependency) !== 1) reasons.add(`dependency_edge_missing_or_duplicate:${dependency}`);
    }
    for (const dependency of observedDependencies.keys()) {
      if (!dependencies.includes(dependency)) reasons.add(`dependency_edge_unsealed:${dependency}`);
    }
    if (dependencyReferences.length !== dependencies.length) {
      reasons.add(`dependency_edge_cardinality:${dependencyReferences.length}:${dependencies.length}`);
    }
  }

  const reviewReferences = references.filter((reference) => reference.referenceKind === "review_record");
  const reviewCycles = new Map<number, string>();
  const rejectedCycles: number[] = [];
  for (const reference of reviewReferences) {
    const content = reference.sealedContent;
    const cycle = safeInteger(content?.cycle);
    const verdict = nullableText(content?.verdict);
    const inputTreeOid = nullableText(content?.input_tree_oid);
    const inputDiffDigest = nullableText(content?.input_diff_digest);
    if (
      reference.sealedContentState !== "exact" || content === null || cycle === null || cycle < 1 ||
      (verdict !== "accepted" && verdict !== "rejected") || reviewCycles.has(cycle) ||
      inputTreeOid === null || !GIT_OID.test(inputTreeOid) ||
      inputDiffDigest === null || !DIGEST.test(inputDiffDigest)
    ) {
      reasons.add(`review_projection_invalid:${reference.referenceId ?? "<invalid>"}`);
      integrityExact = false;
      continue;
    }
    reviewCycles.set(cycle, verdict);
    if (verdict === "rejected") rejectedCycles.push(cycle);
  }
  const orderedReviewCycles = [...reviewCycles.keys()].sort((left, right) => left - right);
  if (
    orderedReviewCycles.some((cycle, index) => cycle !== index + 1) ||
    (maxReviewCycles !== null && orderedReviewCycles.length > maxReviewCycles)
  ) reasons.add("review_cycle_set_incomplete_or_over_budget");
  const finalReviewCycle = orderedReviewCycles.at(-1);
  if (finalReviewCycle === undefined || reviewCycles.get(finalReviewCycle) !== "accepted") {
    reasons.add("final_review_not_accepted");
  }

  const remediationReferences = references.filter((reference) =>
    reference.referenceKind === "evidence" && reference.sealedContent?.oracle_input_class === "remediation_cycle"
  );
  const remediationCycles = new Map<number, number>();
  for (const reference of remediationReferences) {
    const cycle = safeInteger(reference.sealedContent?.cycle);
    if (reference.sealedContentState !== "exact" || cycle === null || cycle < 1) {
      reasons.add(`remediation_projection_invalid:${reference.referenceId ?? "<invalid>"}`);
      integrityExact = false;
      continue;
    }
    remediationCycles.set(cycle, (remediationCycles.get(cycle) ?? 0) + 1);
  }
  for (const cycle of rejectedCycles) {
    if (remediationCycles.get(cycle) !== 1) reasons.add(`remediation_cycle_missing_or_duplicate:${cycle}`);
  }
  for (const cycle of remediationCycles.keys()) {
    if (!rejectedCycles.includes(cycle)) reasons.add(`remediation_cycle_unsealed:${cycle}`);
  }
  if (remediationLimit !== null && rejectedCycles.length > remediationLimit) reasons.add("remediation_budget_exceeded");

  const attributionReferences = references.filter((reference) => reference.referenceKind === "commit_attribution");
  if (attributionReferences.length !== 1) reasons.add(`commit_attribution_cardinality:${attributionReferences.length}`);
  const attributionReference = attributionReferences[0];
  let attributedTreeOid: string | null = null;
  let attributedDiffDigest: string | null = null;
  if (attributionReference !== undefined) {
    const content = attributionReference.sealedContent;
    const baselineOid = nullableText(content?.baseline_oid);
    const parentOid = nullableText(content?.parent_oid);
    const treeBeforeOid = nullableText(content?.tree_before_oid);
    const treeAfterOid = nullableText(content?.tree_after_oid);
    const commitOid = nullableText(content?.commit_oid);
    const contractDigest = nullableText(content?.contract_digest);
    const candidateDiffDigest = nullableText(content?.candidate_diff_digest);
    const pathSetDigest = nullableText(content?.path_set_digest);
    const changeKindSetDigest = nullableText(content?.change_kind_set_digest);
    const modeSetDigest = nullableText(content?.mode_set_digest);
    const rawDelta = Array.isArray(content?.normalized_delta) ? content.normalized_delta : null;
    const normalizedDelta = rawDelta?.map(normalizedDeltaEntry) ?? null;
    if (
      attributionReference.sealedContentState !== "exact" || content === null ||
      baselineOid === null || !GIT_OID.test(baselineOid) || parentOid !== baselineOid ||
      treeBeforeOid === null || !GIT_OID.test(treeBeforeOid) || treeAfterOid === null || !GIT_OID.test(treeAfterOid) ||
      commitOid === null || !GIT_OID.test(commitOid) || contractDigest === null ||
      candidateDiffDigest === null || !DIGEST.test(candidateDiffDigest) ||
      pathSetDigest === null || !DIGEST.test(pathSetDigest) ||
      changeKindSetDigest === null || !DIGEST.test(changeKindSetDigest) ||
      modeSetDigest === null || !DIGEST.test(modeSetDigest) ||
      normalizedDelta === null || normalizedDelta.length === 0 || normalizedDelta.some((entry) => entry === null)
    ) {
      reasons.add(`commit_attribution_projection_invalid:${attributionReference.referenceId ?? "<invalid>"}`);
      integrityExact = false;
    } else {
      const delta = normalizedDelta as readonly OracleNormalizedDeltaEntry[];
      const derived = deriveOracleAttributionDigests(delta);
      attributedTreeOid = treeAfterOid;
      attributedDiffDigest = candidateDiffDigest;
      if (
        candidateDiffDigest !== derived.candidateDiffDigest || pathSetDigest !== derived.pathSetDigest ||
        changeKindSetDigest !== derived.changeKindSetDigest || modeSetDigest !== derived.modeSetDigest
      ) reasons.add(`commit_attribution_digest_mismatch:${attributionReference.referenceId ?? "<invalid>"}`);
      if (contractReference === undefined || contractDigest !== contractReference.referenceId) {
        reasons.add(`commit_attribution_contract_mismatch:${attributionReference.referenceId ?? "<invalid>"}`);
      }
      if (hasDuplicateDeltaIdentity(delta)) {
        reasons.add(`commit_attribution_delta_duplicate:${attributionReference.referenceId ?? "<invalid>"}`);
      }
      if (
        contractScope === null || delta.some((entry) => !contractScope!.some((declaration) => deltaMatchesScope(entry, declaration))) ||
        contractScope.some((declaration) => !delta.some((entry) => deltaMatchesScope(entry, declaration)))
      ) reasons.add(`commit_attribution_scope_mismatch:${attributionReference.referenceId ?? "<invalid>"}`);
    }
  }

  if (cleanupEligibility !== undefined && attributionReference !== undefined) {
    const eligibility = cleanupEligibility.sealedContent;
    const attribution = attributionReference.sealedContent;
    if (
      eligibility?.commit_attribution_id !== attributionReference.referenceId ||
      eligibility?.candidate_oid !== attribution?.commit_oid ||
      eligibility?.baseline_oid !== attribution?.baseline_oid
    ) {
      reasons.add(`cleanup_eligibility_candidate_mismatch:${cleanupEligibility.referenceId ?? "<invalid>"}`);
    }
  }

  if (finalReviewCycle !== undefined && reviewCycles.get(finalReviewCycle) === "accepted") {
    const finalReview = reviewReferences.find((reference) => safeInteger(reference.sealedContent?.cycle) === finalReviewCycle);
    if (
      finalReview === undefined || attributedTreeOid === null || attributedDiffDigest === null ||
      finalReview.sealedContent?.input_tree_oid !== attributedTreeOid ||
      finalReview.sealedContent?.input_diff_digest !== attributedDiffDigest
    ) reasons.add(`final_review_candidate_mismatch:${finalReview?.referenceId ?? "<missing>"}`);
  }

  if (attributedTreeOid !== null && attributedDiffDigest !== null) {
    for (const reference of references) {
      if (reference.referenceKind !== "gate_result" || reference.gate?.required !== true) continue;
      if (
        reference.sealedContent?.candidate_tree_oid !== attributedTreeOid ||
        reference.sealedContent?.candidate_diff_digest !== attributedDiffDigest
      ) reasons.add(`required_gate_candidate_mismatch:${reference.gate.gateId ?? "<invalid>"}:${reference.referenceId ?? "<invalid>"}`);
    }
  }

  const inputSetDigest = digest({
    schema_version: "rickgent.oracle-input-set.v1",
    oracle_version: oracleVersion,
    scope: { run_id: scope.runId, ticket_instance_id: scope.ticketInstanceId, attempt_id: scope.attemptId },
    references: references.map((reference) => ({
      ordinal: reference.ordinal,
      reference_kind: reference.referenceKind,
      reference_id: reference.referenceId,
      run_id: reference.runId,
      ticket_instance_id: reference.ticketInstanceId,
      attempt_id: reference.attemptId,
      oracle_version: reference.oracleVersion,
      content_digest: reference.contentDigest,
      resolved_content_digest: reference.resolvedContentDigest,
      sealed_content: reference.sealedContent,
      sealed_content_state: reference.sealedContentState,
      gate: reference.gate,
    })),
  });
  const orderedReasons = [...reasons].sort();
  const result: OracleDecisionResult = orderedReasons.length === 0 ? "accepted" : "rejected";
  const outputDigest = digest({
    schema_version: "rickgent.oracle-output.v1",
    oracle_version: oracleVersion,
    scope: { run_id: scope.runId, ticket_instance_id: scope.ticketInstanceId, attempt_id: scope.attemptId },
    input_set_digest: inputSetDigest,
    result,
    reasons: orderedReasons,
  });
  return new IssuedOraclePersistencePlan({
    oracleVersion,
    scope,
    result,
    reasons: orderedReasons,
    inputSetDigest,
    outputDigest,
    referenceIntegrity: integrityExact ? "exact" : "invalid",
    references,
  });
}

export function isOraclePersistencePlan(value: unknown): value is OraclePersistencePlan {
  return value !== null && typeof value === "object" && ISSUED_PLANS.has(value);
}

/** Brand-check a plan before a Store uses it in its active transaction. */
export function oraclePersistenceProjection(value: unknown): OraclePersistencePlan {
  if (!isOraclePersistencePlan(value)) throw new TypeError("oracle persistence plan was not issued by the versioned oracle");
  return value;
}

/**
 * Materialize exact SQLite row inputs. The Store must accept the branded plan,
 * call this function, and insert both arrays in the same transaction that
 * resolved the projection. It must not expose a raw decision-row writer.
 */
export function materializeOraclePersistenceRows(
  value: unknown,
  identity: OraclePersistenceIdentity,
): OraclePersistenceRows {
  const plan = oraclePersistenceProjection(value);
  if (plan.referenceIntegrity !== "exact") {
    throw new TypeError("oracle projection with invalid reference integrity cannot be persisted");
  }
  const oracleDecisionId = requiredText(identity.oracleDecisionId, "oracleDecisionId");
  const idempotencyKey = requiredText(identity.idempotencyKey, "idempotencyKey");
  const createdAt = requiredText(identity.createdAt, "createdAt");
  if (createdAt.length < 20 || !createdAt.endsWith("Z") || Number.isNaN(Date.parse(createdAt))) {
    throw new TypeError("createdAt must be a UTC timestamp");
  }

  const decision: OraclePersistenceRow = deepFreeze({
    oracle_decision_id: oracleDecisionId,
    oracle_version: plan.oracleVersion,
    scope_kind: "attempt",
    run_id: plan.scope.runId,
    ticket_instance_id: plan.scope.ticketInstanceId,
    attempt_id: plan.scope.attemptId,
    input_set_digest: plan.inputSetDigest,
    result: plan.result,
    reasons_json: canonicalJson(plan.reasons),
    output_digest: plan.outputDigest,
    idempotency_key: idempotencyKey,
    created_at: createdAt,
  });

  const references = plan.references.map((reference): OraclePersistenceRow => {
    const kind = reference.referenceKind as OracleReferenceKind;
    const row: Record<string, string | number | null> = {
      oracle_decision_id: oracleDecisionId,
      run_id: plan.scope.runId,
      ticket_instance_id: plan.scope.ticketInstanceId,
      attempt_id: plan.scope.attemptId,
      ordinal: reference.ordinal!,
      reference_kind: kind,
      content_digest: reference.contentDigest!,
    };
    for (const column of REFERENCE_ID_COLUMNS) row[column] = null;
    row[REFERENCE_ID_COLUMN[kind]] = reference.referenceId!;
    return deepFreeze(row);
  });
  return deepFreeze({ decision, references });
}
