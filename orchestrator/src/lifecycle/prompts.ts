/**
 * t25: Full ticket-contract propagation through every phase.
 *
 * Role-specific prompt renderers that carry the immutable ticket ID/title/
 * description, acceptance criteria and structured verification definitions,
 * interface/ownership assertions, normalized scope/change kinds, dependencies,
 * budgets, contract digest, baseline/diff identity, and required output
 * schema through every phase prompt and receipt without lossy
 * reconstruction.
 *
 * A lossy reconstruction (missing field, mutated digest) is rejected by
 * {@link verifyPromptReceipt}.  Review receives immutable baseline/final-tree/
 * diff identity and cannot trust implementation transcript claims;
 * remediation receives structured findings only.
 *
 * The renderers are the single production source of phase prompts.  The
 * legacy lossy `Implement ticket <id>: <title>` two-line header is removed.
 */

import { createHash } from "node:crypto";
import {
  canonicalJson,
  ticketContractDigest,
  type TicketContract,
} from "../contracts/ticket-contract.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const PROMPT_RECEIPT_SCHEMA_VERSION = "rickgent.prompt-receipt.v1" as const;

/**
 * The catalog of contract fields every renderer MUST carry in its
 * prompt_text.  A renderer that drops any of these is a lossy
 * reconstruction and is rejected by {@link verifyPromptReceipt}.
 */
export const REQUIRED_CONTRACT_FIELDS: readonly string[] = Object.freeze([
  "schema_version",
  "id",
  "title",
  "description",
  "depends_on",
  "scope",
  "interfaces",
  "acceptance_criteria",
  "verifications",
  "budgets",
  "digest",
]);

export type PromptPhase =
  | "implement"
  | "review"
  | "remediate"
  | "verify"
  | "converge";

export type PromptRole =
  | "worker"
  | "reviewer"
  | "remediator"
  | "verifier"
  | "converger";

export interface StructuredFinding {
  readonly id: string;
  readonly severity: "high" | "medium" | "low";
  readonly message: string;
  readonly path?: string;
}

export interface ReviewEvidence {
  /** Immutable baseline tree OID (the parent the attempt started from). */
  readonly baselineOid: string;
  /** Immutable candidate/final-tree OID under review. */
  readonly candidateOid: string;
  /** Content digest of the observed baseline..candidate diff. */
  readonly diffDigest: string;
}

/**
 * Phase-appropriate immutable context supplied to a renderer.  The
 * `contractDigest` field MUST equal `contract.digest`; the renderer does not
 * re-derive it (fail-closed on mismatch is the caller's responsibility, but
 * the renderer also asserts it for defense in depth).
 */
export interface PhasePromptContext {
  readonly phase: PromptPhase;
  readonly role: PromptRole;
  readonly contextDigest: string;
  readonly contractDigest: string;
}

export interface PromptReceipt {
  readonly schema_version: typeof PROMPT_RECEIPT_SCHEMA_VERSION;
  readonly phase: PromptPhase;
  readonly role: PromptRole;
  readonly contract_digest: string;
  readonly context_digest: string;
  /** Audit trail of contract fields the renderer included. */
  readonly rendered_fields: readonly string[];
  /**
   * Canonical, redacted, deterministic prompt body.  Embeds the full
   * normalized contract (every required field), the phase/role, the context
   * digest, and phase-appropriate immutable evidence.
   */
  readonly prompt_text: string;
  /** Content hash of the receipt payload (every field except prompt_digest). */
  readonly prompt_digest: string;
  /** Review-phase immutable baseline OID (review only). */
  readonly baseline_oid?: string;
  /** Review-phase immutable candidate OID (review only). */
  readonly candidate_oid?: string;
  /** Review-phase diff digest (review only). */
  readonly diff_digest?: string;
  /** Remediation-phase structured findings (remediation only). */
  readonly findings?: readonly StructuredFinding[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PromptReceiptMismatchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PromptReceiptMismatchError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * The phases that require each piece of phase-appropriate immutable evidence.
 * Used by {@link verifyPromptReceipt} to fail closed when a receipt is missing
 * required evidence or carries evidence it should not.
 */
const PHASE_EVIDENCE: Readonly<Record<PromptPhase, {
  readonly role: PromptRole;
  readonly requiresReviewEvidence: boolean;
  readonly requiresFindings: boolean;
}>> = Object.freeze({
  implement: { role: "worker", requiresReviewEvidence: false, requiresFindings: false },
  review: { role: "reviewer", requiresReviewEvidence: true, requiresFindings: false },
  remediate: { role: "remediator", requiresReviewEvidence: false, requiresFindings: true },
  verify: { role: "verifier", requiresReviewEvidence: false, requiresFindings: false },
  converge: { role: "converger", requiresReviewEvidence: false, requiresFindings: false },
});

interface PromptBody {
  readonly schema_version: "rickgent.prompt.v1";
  readonly phase: PromptPhase;
  readonly role: PromptRole;
  readonly contract: TicketContract;
  readonly contract_digest: string;
  readonly context_digest: string;
  readonly baseline_oid?: string;
  readonly candidate_oid?: string;
  readonly diff_digest?: string;
  readonly findings?: readonly StructuredFinding[];
  readonly output_schema: Readonly<{
    readonly kind: "normalized_ticket_contract";
    readonly required_fields: readonly string[];
  }>;
}

function buildPromptBody(
  contract: TicketContract,
  ctx: PhasePromptContext,
  extras: {
    readonly baselineOid?: string;
    readonly candidateOid?: string;
    readonly diffDigest?: string;
    readonly findings?: readonly StructuredFinding[];
  } = {},
): PromptBody {
  if (ctx.contractDigest !== contract.digest) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_CONTRACT_DIGEST_MISMATCH",
      `phase context contract digest ${ctx.contractDigest} disagrees with contract.digest ${contract.digest}`,
    );
  }
  const expectedRole = PHASE_EVIDENCE[ctx.phase]?.role;
  if (expectedRole === undefined) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_PHASE_UNKNOWN",
      `unknown prompt phase ${ctx.phase}`,
    );
  }
  if (expectedRole !== ctx.role) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_ROLE_PHASE_MISMATCH",
      `phase ${ctx.phase} requires role ${expectedRole}, got ${ctx.role}`,
    );
  }
  const body: PromptBody = {
    schema_version: "rickgent.prompt.v1",
    phase: ctx.phase,
    role: ctx.role,
    contract,
    contract_digest: contract.digest,
    context_digest: ctx.contextDigest,
    output_schema: {
      kind: "normalized_ticket_contract",
      required_fields: REQUIRED_CONTRACT_FIELDS,
    },
    ...(extras.baselineOid !== undefined ? { baseline_oid: extras.baselineOid } : {}),
    ...(extras.candidateOid !== undefined ? { candidate_oid: extras.candidateOid } : {}),
    ...(extras.diffDigest !== undefined ? { diff_digest: extras.diffDigest } : {}),
    ...(extras.findings !== undefined ? { findings: extras.findings } : {}),
  };
  return body;
}

function sealReceipt(
  contract: TicketContract,
  ctx: PhasePromptContext,
  extras: {
    readonly baselineOid?: string;
    readonly candidateOid?: string;
    readonly diffDigest?: string;
    readonly findings?: readonly StructuredFinding[];
  },
): PromptReceipt {
  const body = buildPromptBody(contract, ctx, extras);
  const promptText = canonicalJson(body);
  const baseReceipt: Omit<PromptReceipt, "prompt_digest"> = {
    schema_version: PROMPT_RECEIPT_SCHEMA_VERSION,
    phase: ctx.phase,
    role: ctx.role,
    contract_digest: contract.digest,
    context_digest: ctx.contextDigest,
    rendered_fields: REQUIRED_CONTRACT_FIELDS,
    prompt_text: promptText,
    ...(extras.baselineOid !== undefined ? { baseline_oid: extras.baselineOid } : {}),
    ...(extras.candidateOid !== undefined ? { candidate_oid: extras.candidateOid } : {}),
    ...(extras.diffDigest !== undefined ? { diff_digest: extras.diffDigest } : {}),
    ...(extras.findings !== undefined ? { findings: extras.findings } : {}),
  };
  const computed = sha256(canonicalJson(baseReceipt));
  return Object.freeze({ ...baseReceipt, prompt_digest: computed }) as PromptReceipt;
}

// ---------------------------------------------------------------------------
// Role-specific renderers
// ---------------------------------------------------------------------------

/**
 * Implementation prompt: the worker receives the full normalized contract
 * (ACs, structured verification definitions, interfaces, scope/change kinds,
 * dependencies, budgets, contract digest) and the required output schema.
 */
export function renderImplementationPrompt(
  contract: TicketContract,
  ctx: PhasePromptContext,
): PromptReceipt {
  assertPhase(ctx, "implement");
  return sealReceipt(contract, ctx, {});
}

/**
 * Review prompt: the reviewer receives the full normalized contract plus
 * immutable baseline/final-tree/diff identity.  The reviewer cannot trust
 * implementation transcript claims — no transcript is included.
 */
export function renderReviewPrompt(
  contract: TicketContract,
  ctx: PhasePromptContext,
  evidence: ReviewEvidence,
): PromptReceipt {
  assertPhase(ctx, "review");
  if (
    typeof evidence.baselineOid !== "string" || evidence.baselineOid.length === 0 ||
    typeof evidence.candidateOid !== "string" || evidence.candidateOid.length === 0 ||
    typeof evidence.diffDigest !== "string" || evidence.diffDigest.length === 0
  ) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_REVIEW_EVIDENCE_INCOMPLETE",
      "review requires immutable baseline_oid, candidate_oid, and diff_digest",
    );
  }
  return sealReceipt(contract, ctx, {
    baselineOid: evidence.baselineOid,
    candidateOid: evidence.candidateOid,
    diffDigest: evidence.diffDigest,
  });
}

/**
 * Remediation prompt: the remediator receives the full normalized contract
 * plus structured findings only.  No implementation transcript is included.
 */
export function renderRemediationPrompt(
  contract: TicketContract,
  ctx: PhasePromptContext,
  findings: readonly StructuredFinding[],
): PromptReceipt {
  assertPhase(ctx, "remediate");
  if (!Array.isArray(findings) || findings.length === 0) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_REMEDIATION_FINDINGS_EMPTY",
      "remediation requires at least one structured finding",
    );
  }
  for (const finding of findings) {
    if (
      typeof finding.id !== "string" || finding.id.length === 0 ||
      (finding.severity !== "high" && finding.severity !== "medium" && finding.severity !== "low") ||
      typeof finding.message !== "string" || finding.message.length === 0
    ) {
      throw new PromptReceiptMismatchError(
        "RICKGENT_PROMPT_FINDING_INVALID",
        "each finding requires a nonempty id, a valid severity, and a nonempty message",
      );
    }
  }
  return sealReceipt(contract, ctx, { findings });
}

/**
 * Verification prompt: the verifier receives the full normalized contract
 * and the structured verification argv specifications to run.
 */
export function renderVerificationPrompt(
  contract: TicketContract,
  ctx: PhasePromptContext,
): PromptReceipt {
  assertPhase(ctx, "verify");
  return sealReceipt(contract, ctx, {});
}

/**
 * Convergence prompt: the converger receives the full normalized contract
 * and the convergence target (the contract's acceptance criteria).
 */
export function renderConvergencePrompt(
  contract: TicketContract,
  ctx: PhasePromptContext,
): PromptReceipt {
  assertPhase(ctx, "converge");
  return sealReceipt(contract, ctx, {});
}

// ---------------------------------------------------------------------------
// Verification (resume / lossy-reconstruction rejection)
// ---------------------------------------------------------------------------

function assertPhase(ctx: PhasePromptContext, expected: PromptPhase): void {
  if (ctx.phase !== expected) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_PHASE_MISMATCH",
      `renderer for ${expected} received phase ${ctx.phase}`,
    );
  }
  if (ctx.contractDigest.length === 0) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_CONTRACT_DIGEST_EMPTY",
      "phase context contract digest is empty",
    );
  }
  if (ctx.contextDigest.length === 0) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_CONTEXT_DIGEST_EMPTY",
      "phase context digest is empty",
    );
  }
}

interface ParsedPromptBody {
  readonly schema_version: string;
  readonly phase: PromptPhase;
  readonly role: PromptRole;
  readonly contract: Record<string, unknown>;
  readonly context_digest: string;
  readonly baseline_oid?: string;
  readonly candidate_oid?: string;
  readonly diff_digest?: string;
  readonly findings?: readonly StructuredFinding[];
  readonly output_schema?: { readonly kind: string; readonly required_fields?: readonly string[] };
}

function parsePromptText(text: string): ParsedPromptBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_TEXT_NOT_JSON",
      `prompt_text is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_TEXT_NOT_OBJECT",
      "prompt_text must be a JSON object",
    );
  }
  return parsed as ParsedPromptBody;
}

/**
 * Verify a {@link PromptReceipt} against the expected contract and context.
 *
 * Rejects (fail-closed, throws {@link PromptReceiptMismatchError}) when:
 *  - the receipt's `contract_digest` differs from `contract.digest` (mutated digest),
 *  - the receipt's `context_digest` differs from `expectedContextDigest` (resume mismatch),
 *  - the `prompt_digest` does not match the canonical hash of the receipt payload (replay tamper),
 *  - the prompt_text is not canonical JSON / does not round-trip,
 *  - the embedded contract's recomputed digest differs from `contract.digest` (lossy reconstruction: missing/mutated field),
 *  - the phase/role in the receipt header disagrees with the phase/role in prompt_text (phase mismatch),
 *  - a required contract field is absent from the embedded contract (dropped ACs/interfaces/dependencies/verification specs/change kinds/budgets),
 *  - phase-appropriate immutable evidence is missing (review without baseline/candidate/diff; remediation without findings),
 *  - the receipt carries evidence it should not (review carrying findings; implement carrying review evidence).
 */
export function verifyPromptReceipt(
  receipt: PromptReceipt,
  contract: TicketContract,
  expectedContextDigest: string,
): void {
  // 1. Header-level digest checks.
  if (receipt.schema_version !== PROMPT_RECEIPT_SCHEMA_VERSION) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_SCHEMA_VERSION_UNSUPPORTED",
      `expected ${PROMPT_RECEIPT_SCHEMA_VERSION}, got ${receipt.schema_version}`,
    );
  }
  if (receipt.contract_digest !== contract.digest) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_CONTRACT_DIGEST_MISMATCH",
      `receipt contract_digest ${receipt.contract_digest} disagrees with contract.digest ${contract.digest}`,
    );
  }
  if (receipt.context_digest !== expectedContextDigest) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_CONTEXT_DIGEST_MISMATCH",
      `receipt context_digest ${receipt.context_digest} disagrees with expected ${expectedContextDigest}`,
    );
  }

  // 2. Prompt-digest (replay integrity) check.
  const { prompt_digest, ...payload } = receipt;
  const computedPromptDigest = sha256(canonicalJson(payload));
  if (prompt_digest !== computedPromptDigest) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_DIGEST_TAMPER",
      `receipt prompt_digest ${prompt_digest} disagrees with recomputed ${computedPromptDigest}`,
    );
  }

  // 3. Prompt-text round-trip and field-presence checks.
  const body = parsePromptText(receipt.prompt_text);
  if (body.schema_version !== "rickgent.prompt.v1") {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_BODY_SCHEMA_VERSION_UNSUPPORTED",
      `prompt body schema_version ${body.schema_version} is unsupported`,
    );
  }
  // 3a. Phase/role in the header must agree with the body (catches phase
  //     forgery where a review receipt is relabeled as implement).
  if (body.phase !== receipt.phase) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_PHASE_BODY_MISMATCH",
      `receipt.phase ${receipt.phase} disagrees with prompt_text phase ${body.phase}`,
    );
  }
  if (body.role !== receipt.role) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_ROLE_BODY_MISMATCH",
      `receipt.role ${receipt.role} disagrees with prompt_text role ${body.role}`,
    );
  }
  if (body.context_digest !== receipt.context_digest) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_CONTEXT_BODY_MISMATCH",
      `prompt_text context_digest ${body.context_digest} disagrees with receipt ${receipt.context_digest}`,
    );
  }

  // 4. Embedded contract digest check — catches lossy reconstruction where a
  //    required field was stripped or mutated inside prompt_text while the
  //    outer receipt.contract_digest was left untouched.
  const embeddedContract = body.contract;
  if (embeddedContract === null || typeof embeddedContract !== "object" || Array.isArray(embeddedContract)) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_CONTRACT_BODY_MISSING",
      "prompt_text does not embed a contract object",
    );
  }
  for (const field of REQUIRED_CONTRACT_FIELDS) {
    if (!(field in embeddedContract)) {
      throw new PromptReceiptMismatchError(
        "RICKGENT_PROMPT_CONTRACT_FIELD_MISSING",
        `prompt_text embedded contract is missing required field ${field}`,
      );
    }
  }
  const recomputedEmbeddedDigest = ticketContractDigest(embeddedContract as Record<string, unknown>);
  if (recomputedEmbeddedDigest !== contract.digest) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_CONTRACT_BODY_DIGEST_MISMATCH",
      `prompt_text embedded contract digest ${recomputedEmbeddedDigest} disagrees with contract.digest ${contract.digest} (lossy reconstruction)`,
    );
  }
  if (typeof embeddedContract.digest === "string" && embeddedContract.digest !== contract.digest) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_CONTRACT_BODY_DIGEST_FIELD_MISMATCH",
      `prompt_text embedded contract.digest ${embeddedContract.digest} disagrees with contract.digest ${contract.digest}`,
    );
  }

  // 5. Phase-appropriate immutable evidence checks.
  const expected = PHASE_EVIDENCE[receipt.phase];
  if (expected === undefined) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_PHASE_UNKNOWN",
      `unknown prompt phase ${receipt.phase}`,
    );
  }
  if (expected.role !== receipt.role) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_ROLE_PHASE_MISMATCH",
      `phase ${receipt.phase} requires role ${expected.role}, got ${receipt.role}`,
    );
  }
  if (expected.requiresReviewEvidence) {
    if (
      typeof receipt.baseline_oid !== "string" || receipt.baseline_oid.length === 0 ||
      typeof receipt.candidate_oid !== "string" || receipt.candidate_oid.length === 0 ||
      typeof receipt.diff_digest !== "string" || receipt.diff_digest.length === 0
    ) {
      throw new PromptReceiptMismatchError(
        "RICKGENT_PROMPT_REVIEW_EVIDENCE_MISSING",
        "review receipt requires nonempty baseline_oid, candidate_oid, and diff_digest",
      );
    }
    if (receipt.findings !== undefined) {
      throw new PromptReceiptMismatchError(
        "RICKGENT_PROMPT_REVIEW_CARRIES_FINDINGS",
        "review receipt must not carry remediation findings",
      );
    }
  }
  if (expected.requiresFindings) {
    if (!Array.isArray(receipt.findings) || receipt.findings.length === 0) {
      throw new PromptReceiptMismatchError(
        "RICKGENT_PROMPT_REMEDIATION_FINDINGS_MISSING",
        "remediation receipt requires nonempty structured findings",
      );
    }
    if (
      receipt.baseline_oid !== undefined ||
      receipt.candidate_oid !== undefined ||
      receipt.diff_digest !== undefined
    ) {
      throw new PromptReceiptMismatchError(
        "RICKGENT_PROMPT_REMEDIATION_CARRIES_REVIEW_EVIDENCE",
        "remediation receipt must not carry review evidence",
      );
    }
  }
  if (!expected.requiresReviewEvidence) {
    if (
      receipt.baseline_oid !== undefined ||
      receipt.candidate_oid !== undefined ||
      receipt.diff_digest !== undefined
    ) {
      throw new PromptReceiptMismatchError(
        "RICKGENT_PROMPT_PHASE_CARRIES_REVIEW_EVIDENCE",
        `${receipt.phase} receipt must not carry review evidence`,
      );
    }
  }
  if (!expected.requiresFindings && receipt.findings !== undefined) {
    throw new PromptReceiptMismatchError(
      "RICKGENT_PROMPT_PHASE_CARRIES_FINDINGS",
      `${receipt.phase} receipt must not carry remediation findings`,
    );
  }
}
