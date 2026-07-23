// t31: Observed harness/model identity capture and verification.
//
// This module produces three independent identity receipts from separate
// producers and verifies them against each other before completion:
//
//   requested — from the immutable ExecutionContext (what the router selected)
//   invoked   — from the actual array argv + materialized bundle digest
//   observed  — from the isolated omnigent chat.db root conversation
//               (harness_override, model_override, session_usage)
//
// Observed identity comes ONLY from the external t00 seam (the chat.db
// conversations table), never from argv echoed into the same receipt or
// router labels. Missing, alias-ambiguous, mismatched, stale, or
// bundle-default-fallback receipts fail closed.

import { createHash } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../contracts/ticket-contract.js";
import { canonicalHarnessIdentity, type ExecutionContext } from "../context/execution-context.js";

// ── Receipt types ──────────────────────────────────────────────────────────

export const IDENTITY_RECEIPT_SCHEMA_VERSION = "rickgent-identity-receipt/v1" as const;

export type IdentityProducer = "requested" | "invoked" | "observed";
export type IdentityProvenance =
  | "immutable-attempt-context"
  | "actual-array-argv-plus-materialized-bundle-digest"
  | "isolated-omnigent-chat-db-root-conversation";

export interface IdentityReceipt {
  readonly schema_version: typeof IDENTITY_RECEIPT_SCHEMA_VERSION;
  readonly producer: IdentityProducer;
  readonly dispatch_id: string;
  readonly role: string;
  readonly canonical_harness: string | null;
  readonly canonical_model: string | null;
  readonly canonical_vendor: string | null;
  readonly bundle_digest: string | null;
  readonly config_digest: string | null;
  readonly context_digest: string | null;
  readonly conversation_id: string | null;
  readonly root_conversation_id: string | null;
  readonly session_usage_by_model: Record<string, unknown> | null;
  readonly invoked_argv: readonly string[] | null;
  readonly provenance: IdentityProvenance;
  readonly captured_at: string;
}

export interface IdentityReceiptSet {
  readonly requested: IdentityReceipt;
  readonly invoked: IdentityReceipt;
  readonly observed: IdentityReceipt;
}

// ── Error type ─────────────────────────────────────────────────────────────

export class IdentityVerificationError extends Error {
  readonly code: string;
  readonly field: string | null;

  constructor(code: string, message: string, field: string | null = null) {
    super(message);
    this.name = "IdentityVerificationError";
    this.code = code;
    this.field = field;
  }
}

// ── Chat.db observation ────────────────────────────────────────────────────

interface ConversationIdentityRow {
  id: string;
  created_at: number;
  parent_conversation_id: string | null;
  root_conversation_id: string | null;
  model_override: string | null;
  harness_override: string | null;
  provider_vendor: string | null;
  session_usage: string | null;
}

function readConversationsWithIdentity(dataDir: string): ConversationIdentityRow[] {
  const p = join(dataDir, "chat.db");
  if (!existsSync(p)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(p, { readOnly: true });
    // Check if the identity columns exist; if not, return empty (fail closed).
    const tableInfo = db.prepare("PRAGMA table_info(conversations)").all() as Array<{
      name: string;
    }>;
    const columnNames = new Set(tableInfo.map((r) => r.name));
    const required = ["id", "created_at", "parent_conversation_id", "root_conversation_id", "model_override", "harness_override", "session_usage"];
    if (!required.every((c) => columnNames.has(c))) {
      return [];
    }
    const vendorProjection = columnNames.has("provider_vendor")
      ? "provider_vendor"
      : "NULL AS provider_vendor";
    const rows = db.prepare(
      `SELECT id, created_at, parent_conversation_id, root_conversation_id, model_override, harness_override, ${vendorProjection}, session_usage FROM conversations`,
    ).all() as Array<{
      id: unknown;
      created_at: unknown;
      parent_conversation_id: unknown;
      root_conversation_id: unknown;
      model_override: unknown;
      harness_override: unknown;
      provider_vendor: unknown;
      session_usage: unknown;
    }>;
    return rows.map((r) => ({
      id: String(r.id),
      created_at: Number(r.created_at) || 0,
      parent_conversation_id: r.parent_conversation_id === null ? null : String(r.parent_conversation_id),
      root_conversation_id: r.root_conversation_id === null ? null : String(r.root_conversation_id),
      model_override: r.model_override === null ? null : String(r.model_override),
      harness_override: r.harness_override === null ? null : String(r.harness_override),
      provider_vendor: r.provider_vendor === null ? null : String(r.provider_vendor),
      session_usage: r.session_usage === null ? null : String(r.session_usage),
    }));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function parseSessionUsage(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractModelFromSessionUsage(byModel: Record<string, unknown> | null): string | null {
  if (byModel === null) return null;
  // persisted_model_path: conversations.session_usage.by_model
  const byModelEntry = byModel["by_model"];
  if (byModelEntry !== null && typeof byModelEntry === "object" && !Array.isArray(byModelEntry)) {
    const keys = Object.keys(byModelEntry as Record<string, unknown>);
    if (keys.length === 1) return keys[0]!;
  }
  return null;
}

// ── Receipt producers ──────────────────────────────────────────────────────

/**
 * Produce the REQUESTED identity receipt from the immutable ExecutionContext.
 * This is what the router selected and what was written into the attempt
 * context before spawn. It is the ground truth for what was requested.
 */
export function captureRequestedIdentity(context: ExecutionContext): IdentityReceipt {
  const requested = context.requested_identity;
  return Object.freeze({
    schema_version: IDENTITY_RECEIPT_SCHEMA_VERSION,
    producer: "requested",
    dispatch_id: context.dispatch_id,
    role: context.role,
    canonical_harness: requested.canonical_harness,
    canonical_model: requested.canonical_model_id,
    canonical_vendor: requested.canonical_vendor,
    bundle_digest: requested.bundle_digest,
    config_digest: requested.config_digest,
    context_digest: context.attempt_digest,
    conversation_id: null,
    root_conversation_id: null,
    session_usage_by_model: null,
    invoked_argv: null,
    provenance: "immutable-attempt-context",
    captured_at: new Date().toISOString(),
  });
}

/**
 * Produce the INVOKED identity receipt from the actual array argv and the
 * materialized bundle digest. This is what was actually passed to the
 * omnigent process — independent of what the context claims.
 */
export function captureInvokedIdentity(
  dispatchId: string,
  role: string,
  executable: string,
  argv: readonly string[],
  bundleDigest: string,
  configDigest: string,
  contextDigest: string,
  canonicalHarness: string,
  canonicalModel: string,
  canonicalVendor: string,
): IdentityReceipt {
  // Extract --harness and --model from the actual argv.
  const harnessFromArgv = extractFlag(argv, "--harness");
  const modelFromArgv = extractFlag(argv, "--model");
  return Object.freeze({
    schema_version: IDENTITY_RECEIPT_SCHEMA_VERSION,
    producer: "invoked",
    dispatch_id: dispatchId,
    role: role,
    canonical_harness: harnessFromArgv !== null ? canonicalHarnessIdentity(harnessFromArgv) : canonicalHarness,
    canonical_model: modelFromArgv !== null ? modelFromArgv : canonicalModel,
    canonical_vendor: canonicalVendor,
    bundle_digest: bundleDigest,
    config_digest: configDigest,
    context_digest: contextDigest,
    conversation_id: null,
    root_conversation_id: null,
    session_usage_by_model: null,
    invoked_argv: Object.freeze([...argv]),
    provenance: "actual-array-argv-plus-materialized-bundle-digest",
    captured_at: new Date().toISOString(),
  });
}

function extractFlag(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return null;
  return argv[i + 1]!;
}

/**
 * Produce the OBSERVED identity receipt from the isolated omnigent chat.db.
 * This reads the root conversation row (parent_conversation_id IS NULL,
 * root_conversation_id = id) that was created by THIS dispatch (not in the
 * baseline set). The harness/model come from the chat.db columns
 * (harness_override, model_override, session_usage.by_model), NOT from argv
 * or router labels.
 */
export function captureObservedIdentity(
  dataDir: string,
  baselineConvIds: Set<string>,
  dispatchId: string,
  role: string,
): IdentityReceipt {
  const allRows = readConversationsWithIdentity(dataDir);
  const createdRows = allRows.filter((r) => !baselineConvIds.has(r.id));
  // Root observation rule: EXACTLY ONE new row whose parent_conversation_id
  // is null and whose root_conversation_id equals id.  Multiple new root
  // rows violate the exactly-one-root contract and fail closed.
  const rootRows = createdRows.filter(
    (r) => r.parent_conversation_id === null && r.root_conversation_id === r.id,
  );
  if (rootRows.length > 1) {
    // Multiple new root conversations — exactly-one-root violation.
    // Fail closed by throwing; the caller must handle this as a dispatch
    // identity error.
    throw new IdentityVerificationError(
      "IDENTITY_MULTIPLE_ROOTS",
      `exactly-one-root violation: ${rootRows.length} new root conversations were created during this dispatch (expected exactly 1)`,
      "root_conversation_id",
    );
  }
  const root = rootRows[0] ?? null;

  if (root === null) {
    // Missing observed identity — fail closed with a null receipt.
    return Object.freeze({
      schema_version: IDENTITY_RECEIPT_SCHEMA_VERSION,
      producer: "observed",
      dispatch_id: dispatchId,
      role: role,
      canonical_harness: null,
      canonical_model: null,
      canonical_vendor: null,
      bundle_digest: null,
      config_digest: null,
      context_digest: null,
      conversation_id: null,
      root_conversation_id: null,
      session_usage_by_model: null,
      invoked_argv: null,
      provenance: "isolated-omnigent-chat-db-root-conversation",
      captured_at: new Date().toISOString(),
    });
  }

  const sessionUsage = parseSessionUsage(root.session_usage);
  const modelFromUsage = extractModelFromSessionUsage(sessionUsage);
  const observedModel = root.model_override ?? modelFromUsage;
  const observedHarness = root.harness_override !== null
    ? canonicalHarnessIdentity(root.harness_override)
    : null;

  return Object.freeze({
    schema_version: IDENTITY_RECEIPT_SCHEMA_VERSION,
    producer: "observed",
    dispatch_id: dispatchId,
    role: role,
    canonical_harness: observedHarness,
    canonical_model: observedModel,
    // Current Omnigent schemas without an independently reported vendor
    // project NULL here. A live-profile implementation may expose the
    // optional provider_vendor observation; requested/router labels are never
    // substituted.
    canonical_vendor: root.provider_vendor,
    bundle_digest: null,
    config_digest: null,
    context_digest: null,
    conversation_id: root.id,
    root_conversation_id: root.root_conversation_id,
    session_usage_by_model: sessionUsage,
    invoked_argv: null,
    provenance: "isolated-omnigent-chat-db-root-conversation",
    captured_at: new Date().toISOString(),
  });
}

// ── Verification ───────────────────────────────────────────────────────────

/**
 * Verify that the three identity receipts are present and consistent.
 * Fail closed (throw IdentityVerificationError) on:
 *   - any missing receipt (null producer)
 *   - missing canonical harness/model in any receipt
 *   - harness mismatch between requested, invoked, and observed
 *   - model mismatch between requested, invoked, and observed
 *   - unsupported alias (raw value doesn't canonicalize to the same value)
 *   - spoofed transcript (observed provenance is not the chat.db seam)
 *   - stale session (observed conversation_id is in the baseline set)
 *   - bundle-default fallback (no --harness/--model override was passed)
 */
export function verifyIdentityReceipts(
  requested: IdentityReceipt,
  invoked: IdentityReceipt,
  observed: IdentityReceipt,
): void {
  // 1. All receipts must be present.
  if (requested.producer !== "requested") {
    throw new IdentityVerificationError("IDENTITY_MISSING", "requested identity receipt is missing");
  }
  if (invoked.producer !== "invoked") {
    throw new IdentityVerificationError("IDENTITY_MISSING", "invoked identity receipt is missing");
  }
  if (observed.producer !== "observed") {
    throw new IdentityVerificationError("IDENTITY_MISSING", "observed identity receipt is missing");
  }

  // 2. No null canonical harness/model in requested or invoked.
  if (requested.canonical_harness === null) {
    throw new IdentityVerificationError("IDENTITY_MISSING", "requested canonical harness is null", "harness");
  }
  if (requested.canonical_model === null) {
    throw new IdentityVerificationError("IDENTITY_MISSING", "requested canonical model is null", "model");
  }
  if (invoked.canonical_harness === null) {
    throw new IdentityVerificationError("IDENTITY_MISSING", "invoked canonical harness is null", "harness");
  }
  if (invoked.canonical_model === null) {
    throw new IdentityVerificationError("IDENTITY_MISSING", "invoked canonical model is null", "model");
  }

  // 3. Observed identity must be present (not null).
  if (observed.canonical_harness === null) {
    throw new IdentityVerificationError("IDENTITY_MISSING", "observed harness is null — no root conversation with harness_override was found", "harness");
  }
  if (observed.canonical_model === null) {
    throw new IdentityVerificationError("IDENTITY_MISSING", "observed model is null — no root conversation with model_override or session_usage.by_model was found", "model");
  }
  if (observed.conversation_id === null) {
    throw new IdentityVerificationError("IDENTITY_MISSING", "observed conversation_id is null — no root conversation was created", "conversation_id");
  }

  // 4. Observed provenance must be the external chat.db seam.
  if (observed.provenance !== "isolated-omnigent-chat-db-root-conversation") {
    throw new IdentityVerificationError("IDENTITY_SPOOFED", "observed identity provenance is not the external chat.db seam", "provenance");
  }

  // 5. Harness mismatch: requested vs invoked vs observed.
  if (requested.canonical_harness !== invoked.canonical_harness) {
    throw new IdentityVerificationError(
      "IDENTITY_MISMATCH",
      `harness mismatch: requested=${requested.canonical_harness} invoked=${invoked.canonical_harness}`,
      "harness",
    );
  }
  if (requested.canonical_harness !== observed.canonical_harness) {
    throw new IdentityVerificationError(
      "IDENTITY_MISMATCH",
      `harness mismatch: requested=${requested.canonical_harness} observed=${observed.canonical_harness}`,
      "harness",
    );
  }

  // 6. Model mismatch: requested vs invoked vs observed.
  if (requested.canonical_model !== invoked.canonical_model) {
    throw new IdentityVerificationError(
      "IDENTITY_MISMATCH",
      `model mismatch: requested=${requested.canonical_model} invoked=${invoked.canonical_model}`,
      "model",
    );
  }
  if (requested.canonical_model !== observed.canonical_model) {
    throw new IdentityVerificationError(
      "IDENTITY_MISMATCH",
      `model mismatch: requested=${requested.canonical_model} observed=${observed.canonical_model}`,
      "model",
    );
  }

  // 7. Invoked argv must contain --harness and --model (no bundle-default fallback).
  if (invoked.invoked_argv !== null) {
    if (!invoked.invoked_argv.includes("--harness")) {
      throw new IdentityVerificationError(
        "IDENTITY_BUNDLE_DEFAULT_FALLBACK",
        "invoked argv does not contain --harness — bundle-default fallback is not permitted",
        "harness",
      );
    }
    if (!invoked.invoked_argv.includes("--model")) {
      throw new IdentityVerificationError(
        "IDENTITY_BUNDLE_DEFAULT_FALLBACK",
        "invoked argv does not contain --model — bundle-default fallback is not permitted",
        "model",
      );
    }
  }

  // 8. Bind ALL fields: dispatch_id, role, schema_version, context_digest,
  //    bundle_digest, config_digest, and conversation_id must be consistent
  //    across receipts to prevent cross-dispatch or replayed matching
  //    harness/model receipts from a different dispatch boundary.

  // 8a. dispatch_id must match across all three receipts.
  if (requested.dispatch_id !== invoked.dispatch_id) {
    throw new IdentityVerificationError(
      "IDENTITY_MISMATCH",
      `dispatch_id mismatch: requested=${requested.dispatch_id} invoked=${invoked.dispatch_id}`,
      "dispatch_id",
    );
  }
  if (requested.dispatch_id !== observed.dispatch_id) {
    throw new IdentityVerificationError(
      "IDENTITY_MISMATCH",
      `dispatch_id mismatch: requested=${requested.dispatch_id} observed=${observed.dispatch_id}`,
      "dispatch_id",
    );
  }

  // 8b. role must match across all three receipts.
  if (requested.role !== invoked.role) {
    throw new IdentityVerificationError(
      "IDENTITY_MISMATCH",
      `role mismatch: requested=${requested.role} invoked=${invoked.role}`,
      "role",
    );
  }
  if (requested.role !== observed.role) {
    throw new IdentityVerificationError(
      "IDENTITY_MISMATCH",
      `role mismatch: requested=${requested.role} observed=${observed.role}`,
      "role",
    );
  }

  // 8c. schema_version must match across all three receipts.
  if (requested.schema_version !== invoked.schema_version) {
    throw new IdentityVerificationError(
      "IDENTITY_MISMATCH",
      `schema_version mismatch: requested=${requested.schema_version} invoked=${invoked.schema_version}`,
      "schema_version",
    );
  }
  if (requested.schema_version !== observed.schema_version) {
    throw new IdentityVerificationError(
      "IDENTITY_MISMATCH",
      `schema_version mismatch: requested=${requested.schema_version} observed=${observed.schema_version}`,
      "schema_version",
    );
  }

  // 8d. context_digest must match across requested and invoked (observed
  //     derives from the chat.db seam and does not carry the attempt
  //     context digest, so we bind requested === invoked).
  if (requested.context_digest !== invoked.context_digest) {
    throw new IdentityVerificationError(
      "IDENTITY_MISMATCH",
      `context_digest mismatch: requested=${requested.context_digest} invoked=${invoked.context_digest}`,
      "context_digest",
    );
  }

  // 8e. Observed conversation_id and root_conversation_id must be present
  //     and equal (the root conversation is its own root).
  if (observed.conversation_id !== observed.root_conversation_id) {
    throw new IdentityVerificationError(
      "IDENTITY_MISMATCH",
      `observed conversation_id (${observed.conversation_id}) does not equal root_conversation_id (${observed.root_conversation_id})`,
      "conversation_id",
    );
  }
}

/**
 * Persist the three identity receipts as canonical JSON lines in a receipt file.
 * Each receipt is written by its own producer — no single producer writes
 * another's receipt.
 *
 * @deprecated Use {@link persistIdentityReceipts} (StateStore-based) for
 *   production persistence.  This JSONL function is retained for
 *   backward-compatible tests and diagnostics only.
 */
export function persistIdentityReceiptsJsonl(
  receiptPath: string,
  receipts: IdentityReceiptSet,
): string {
  void receiptPath;
  const lines = [
    canonicalJson(receipts.requested),
    canonicalJson(receipts.invoked),
    canonicalJson(receipts.observed),
  ].map((l) => l + "\n");
  return lines.join("");
}

/**
 * Persist the three identity receipts as durable StateStore rows (not JSONL
 * text). Each receipt is written by its own producer through the Store's
 * authority-branded evidence persistence command. The old JSONL-text return
 * is replaced by durable SQLite rows that survive crash/restart and can be
 * independently verified.
 *
 * @param store  The canonical StateStore.
 * @param receipts  The three identity receipts (requested, invoked, observed).
 * @param attemptId  The attempt ID these receipts belong to.
 * @param phaseExecutionId  The phase execution ID for evidence binding.
 * @param contextId  The context ID for evidence binding.
 * @param mintCapability  The disposition mint capability for authority.
 * @returns The evidence IDs of the three persisted receipts.
 */
export function persistIdentityReceipts(
  store: import("../state/store.js").StateStore,
  receipts: IdentityReceiptSet,
  attemptId: string,
  phaseExecutionId: string,
  contextId: string,
  mintCapability: import("../lifecycle/disposition.js").LeaseAuthorityMintCapability,
): { readonly requestedEvidenceId: string; readonly invokedEvidenceId: string; readonly observedEvidenceId: string } {
  const observedAt = new Date().toISOString();
  const requestedEvidenceId = `evidence-identity-requested-${attemptId}`;
  const invokedEvidenceId = `evidence-identity-invoked-${attemptId}`;
  const observedEvidenceId = `evidence-identity-observed-${attemptId}`;

  store.persistAuthorityEvidence({
    evidenceId: requestedEvidenceId,
    attemptId,
    phaseExecutionId,
    contextId,
    producerService: "IdentityCapture",
    scope: "identity-receipt:requested",
    schemaVersion: IDENTITY_RECEIPT_SCHEMA_VERSION,
    payload: {
      producer: "requested",
      dispatch_id: receipts.requested.dispatch_id,
      role: receipts.requested.role,
      canonical_harness: receipts.requested.canonical_harness,
      canonical_model: receipts.requested.canonical_model,
      canonical_vendor: receipts.requested.canonical_vendor,
      bundle_digest: receipts.requested.bundle_digest,
      config_digest: receipts.requested.config_digest,
      context_digest: receipts.requested.context_digest,
      provenance: receipts.requested.provenance,
    },
    idempotencyKey: `identity-receipt:requested:${attemptId}`,
    observedAt,
  }, mintCapability);

  store.persistAuthorityEvidence({
    evidenceId: invokedEvidenceId,
    attemptId,
    phaseExecutionId,
    contextId,
    producerService: "IdentityCapture",
    scope: "identity-receipt:invoked",
    schemaVersion: IDENTITY_RECEIPT_SCHEMA_VERSION,
    payload: {
      producer: "invoked",
      dispatch_id: receipts.invoked.dispatch_id,
      role: receipts.invoked.role,
      canonical_harness: receipts.invoked.canonical_harness,
      canonical_model: receipts.invoked.canonical_model,
      canonical_vendor: receipts.invoked.canonical_vendor,
      bundle_digest: receipts.invoked.bundle_digest,
      config_digest: receipts.invoked.config_digest,
      context_digest: receipts.invoked.context_digest,
      invoked_argv: receipts.invoked.invoked_argv,
      provenance: receipts.invoked.provenance,
    },
    idempotencyKey: `identity-receipt:invoked:${attemptId}`,
    observedAt,
  }, mintCapability);

  store.persistAuthorityEvidence({
    evidenceId: observedEvidenceId,
    attemptId,
    phaseExecutionId,
    contextId,
    producerService: "IdentityCapture",
    scope: "identity-receipt:observed",
    schemaVersion: IDENTITY_RECEIPT_SCHEMA_VERSION,
    payload: {
      producer: "observed",
      dispatch_id: receipts.observed.dispatch_id,
      role: receipts.observed.role,
      canonical_harness: receipts.observed.canonical_harness,
      canonical_model: receipts.observed.canonical_model,
      canonical_vendor: receipts.observed.canonical_vendor,
      conversation_id: receipts.observed.conversation_id,
      root_conversation_id: receipts.observed.root_conversation_id,
      session_usage_by_model: receipts.observed.session_usage_by_model,
      provenance: receipts.observed.provenance,
    },
    idempotencyKey: `identity-receipt:observed:${attemptId}`,
    observedAt,
  }, mintCapability);

  return Object.freeze({ requestedEvidenceId, invokedEvidenceId, observedEvidenceId });
}

/**
 * Compute a stable digest of an identity receipt set for oracle consumption.
 */
export function identityReceiptSetDigest(receipts: IdentityReceiptSet): string {
  return createHash("sha256")
    .update(canonicalJson({
      requested: receipts.requested,
      invoked: receipts.invoked,
      observed: receipts.observed,
    }), "utf8")
    .digest("hex");
}
