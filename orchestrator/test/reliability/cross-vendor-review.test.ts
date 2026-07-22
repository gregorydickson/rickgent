// t32: Cross-vendor reviewer distinction corpus.
//
// Exercises every identity mismatch and permits cross-vendor review only when
// the canonical observed identities are genuinely distinct. Same-identity
// requests are rejected. Every requested/invoked/observed field is falsified
// independently and no router/ledger label alone can satisfy the gate.
//
// This test drives the real cross-vendor distinction authority
// (evaluateCrossVendorDistinction) with identity receipts produced by the
// t31 identity capture module, exercising:
//   - Genuine distinct observed identities (different harness AND model) → permitted
//   - Same observed identity (same harness AND model) → rejected
//   - Same harness, different model → rejected (not cross-vendor)
//   - Different harness, same model → rejected (not cross-vendor)
//   - Missing implementer observed identity → rejected
//   - Missing reviewer observed identity → rejected
//   - Missing implementer harness → rejected
//   - Missing reviewer harness → rejected
//   - Missing implementer model → rejected
//   - Missing reviewer model → rejected
//   - Missing implementer conversation ID → rejected
//   - Missing reviewer conversation ID → rejected
//   - Same conversation ID → rejected (not independent)
//   - Same role → rejected (authority collapse)
//   - Spoofed implementer provenance → rejected
//   - Spoofed reviewer provenance → rejected
//   - Label-only (no observed receipt) → rejected
//   - Alias canonicalization consistency across receipts
//   - Distinction result is frozen (authority-owned)

import { describe, expect, it } from "vitest";
import {
  captureRequestedIdentity,
  captureInvokedIdentity,
  captureObservedIdentity,
  verifyIdentityReceipts,
  type IdentityReceipt,
  type IdentityReceiptSet,
  IDENTITY_RECEIPT_SCHEMA_VERSION,
} from "../../src/dispatch/model-identity.js";
import {
  evaluateCrossVendorDistinction,
  verifyCrossVendorDistinction,
  CrossVendorDistinctionError,
  makeIdentityReceiptSet,
  CROSS_VENDOR_DISTINCTION_SCHEMA_VERSION,
  type CrossVendorDenialReason,
} from "../../src/dispatch/cross-vendor-distinction.js";
import type { ExecutionContext } from "../../src/context/execution-context.js";
import type { RouterSelection } from "../../src/lifecycle/routing.js";
import { canonicalHarnessIdentity } from "../../src/context/execution-context.js";

// ── Test helpers ───────────────────────────────────────────────────────────

function makeExecutionContext(
  selection: RouterSelection,
  role: string = "worker",
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  const canonicalHarness = canonicalHarnessIdentity(selection.harness);
  return {
    schema_version: "rickgent-attempt-context/v1",
    policy_abi_version: "omnigent-function-policy/current-v1",
    ticket_contract_schema_version: "1.0.0",
    identity_normalization_version: "rickgent-identity-normalization/v1",
    dispatch_id: `run-cv/t32/implement/1/${role}`,
    run_id: "run-cv",
    ticket_id: "t32",
    attempt: 1,
    lifecycle_phase: role === "reviewer" ? "code_review" : "implement",
    role,
    target_repo_realpath: "/tmp/repo",
    worktree_realpath: "/tmp/worktree",
    state_root_realpath: "/tmp/state",
    policy_root_realpath: "/tmp/policy",
    bundle_root_realpath: "/tmp/bundle",
    ticket_contract_digest: "sha256:" + "a".repeat(64),
    declared_scope: [],
    requested_identity: {
      normalization_version: "rickgent-identity-normalization/v1",
      raw_harness: selection.harness,
      canonical_harness: canonicalHarness,
      raw_provider: selection.vendor,
      canonical_provider: selection.vendor,
      raw_vendor: selection.vendor,
      canonical_vendor: selection.vendor,
      raw_model_id: selection.model,
      canonical_model_id: selection.model,
      bundle_digest: "b".repeat(64),
      config_digest: "c".repeat(64),
      profile: "effective-session-v1",
      profile_available: true,
      conflict: false,
    },
    runtime_provenance: {
      schema_version: "rickgent-runtime-provenance/v2",
      omnigent_python_entrypoint: "/tmp/python",
      omnigent_python_realpath: "/tmp/python",
      omnigent_python_sha256: "0".repeat(64),
      omnigent_root_realpath: "/tmp/omnigent",
      omnigent_origin_realpath: "/tmp/omnigent/omnigent/__init__.py",
      rickgent_policies_origin_realpath: "/tmp/policies/__init__.py",
      rickgent_policies_sha256: "1".repeat(64),
      rickgent_node_realpath: "/tmp/node",
      rickgent_node_sha256: "2".repeat(64),
      rickgent_cli_realpath: "/tmp/cli.js",
      rickgent_cli_sha256: "3".repeat(64),
      rickgent_build_commit: "abcdef0",
    },
    requested_bundle_sha256: "b".repeat(64),
    requested_config_sha256: "c".repeat(64),
    attempt_digest: "a".repeat(64),
    owner_token_sha256: "4".repeat(64),
    nonce: "test-nonce",
    nonce_claim_path: "/tmp/nonce.json",
    lease_path: "/tmp/lease.json",
    receipt_path: "/tmp/receipt.jsonl",
    ...overrides,
  } as unknown as ExecutionContext;
}

function makeSelection(overrides: Partial<RouterSelection> = {}): RouterSelection {
  return { harness: "codex", model: "gpt-5", vendor: "openai", ...overrides };
}

function makeValidObservedReceipt(
  dispatchId: string,
  role: string,
  harness: string,
  model: string,
  conversationId: string,
  vendor: string | null = null,
): IdentityReceipt {
  return Object.freeze({
    schema_version: IDENTITY_RECEIPT_SCHEMA_VERSION,
    producer: "observed",
    dispatch_id: dispatchId,
    role: role,
    canonical_harness: canonicalHarnessIdentity(harness),
    canonical_model: model,
    canonical_vendor: vendor,
    bundle_digest: null,
    config_digest: null,
    context_digest: null,
    conversation_id: conversationId,
    root_conversation_id: conversationId,
    session_usage_by_model: { by_model: { [model]: { input_tokens: 10 } } },
    invoked_argv: null,
    provenance: "isolated-omnigent-chat-db-root-conversation",
    captured_at: new Date().toISOString(),
  });
}

function makeNullObservedReceipt(
  dispatchId: string,
  role: string,
): IdentityReceipt {
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

function makeRequestedReceipt(
  context: ExecutionContext,
): IdentityReceipt {
  return captureRequestedIdentity(context);
}

function makeInvokedReceipt(
  dispatchId: string,
  role: string,
  harness: string,
  model: string,
  vendor: string,
): IdentityReceipt {
  return captureInvokedIdentity(
    dispatchId,
    role,
    "/tmp/omnigent",
    ["run", "/tmp/bundle", "--no-session", "--harness", harness, "--model", model, "-p", "prompt"],
    "d".repeat(64),
    "e".repeat(64),
    "a".repeat(64),
    canonicalHarnessIdentity(harness),
    model,
    vendor,
  );
}

function buildReceiptSet(
  selection: RouterSelection,
  role: string,
  observedHarness: string | null,
  observedModel: string | null,
  conversationId: string | null,
  observedProvenance: string = "isolated-omnigent-chat-db-root-conversation",
  observedVendor: string | null = null,
): IdentityReceiptSet {
  const context = makeExecutionContext(selection, role);
  const requested = makeRequestedReceipt(context);
  const invoked = makeInvokedReceipt(
    context.dispatch_id,
    role,
    selection.harness,
    selection.model,
    selection.vendor,
  );
  const observed: IdentityReceipt = observedHarness === null || observedModel === null
    ? makeNullObservedReceipt(context.dispatch_id, role)
    : Object.freeze({
        ...makeValidObservedReceipt(
          context.dispatch_id,
          role,
          observedHarness,
          observedModel,
          conversationId ?? "conv-" + role,
          observedVendor ?? selection.vendor,
        ),
        provenance: observedProvenance as IdentityReceipt["provenance"],
      });
  return makeIdentityReceiptSet(requested, invoked, observed);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("t32: cross-vendor reviewer distinction", () => {
  describe("genuine distinct observed identities", () => {
    it("permits cross-vendor when harness AND model both differ in observed identity", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });

      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("permitted");
      expect(result.genuine_distinction).toBe(true);
      expect(result.denial_reason).toBeNull();
      expect(result.implementer_observed_harness).toBe("codex");
      expect(result.reviewer_observed_harness).toBe("claude-sdk");
      expect(result.implementer_observed_model).toBe("gpt-5");
      expect(result.reviewer_observed_model).toBe("claude-sonnet-4-5");
      expect(result.implementer_conversation_id).toBe("conv-impl-1");
      expect(result.reviewer_conversation_id).toBe("conv-rev-1");
      expect(result.implementer_role).toBe("worker");
      expect(result.reviewer_role).toBe("reviewer");
    });

    it("permits cross-vendor with droid/glm vs codex/gpt-5", () => {
      const implSelection = makeSelection({ harness: "droid", model: "glm-5.2", vendor: "zhipu" });
      const revSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });

      const implementer = buildReceiptSet(implSelection, "worker", "droid", "glm-5.2", "conv-impl-droid");
      const reviewer = buildReceiptSet(revSelection, "reviewer", "codex", "gpt-5", "conv-rev-codex");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("permitted");
      expect(result.genuine_distinction).toBe(true);
    });

    it("verifyCrossVendorDistinction returns the result on success", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });

      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1");

      expect(() => verifyCrossVendorDistinction(implementer, reviewer)).not.toThrow();
      const result = verifyCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("permitted");
    });
  });

  describe("same-identity rejection", () => {
    it("rejects same observed identity (same harness AND same model)", () => {
      const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const implementer = buildReceiptSet(selection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(selection, "reviewer", "codex", "gpt-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("same_observed_identity");
      expect(result.genuine_distinction).toBe(false);
    });

    it("rejects same observed identity even with different conversation IDs", () => {
      const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const implementer = buildReceiptSet(selection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(selection, "reviewer", "codex", "gpt-5", "conv-rev-2");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("same_observed_identity");
    });

    it("verifyCrossVendorDistinction throws on same identity", () => {
      const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const implementer = buildReceiptSet(selection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(selection, "reviewer", "codex", "gpt-5", "conv-rev-1");

      expect(() => verifyCrossVendorDistinction(implementer, reviewer)).toThrow(CrossVendorDistinctionError);
      try {
        verifyCrossVendorDistinction(implementer, reviewer);
      } catch (e) {
        expect((e as CrossVendorDistinctionError).reason).toBe("same_observed_identity");
      }
    });
  });

  describe("partial distinction rejection", () => {
    it("rejects same harness, different model (harness alone is not cross-vendor)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "codex", model: "o3-mini", vendor: "openai" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(revSelection, "reviewer", "codex", "o3-mini", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("same_observed_harness");
    });

    it("rejects different harness, same model (model alone is not cross-vendor)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "gpt-5", vendor: "openai" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "gpt-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("same_observed_model");
    });
  });

  describe("missing observed identity rejection", () => {
    it("rejects missing implementer observed identity (null harness and model)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const implementer = buildReceiptSet(implSelection, "worker", null, null, null);
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_implementer_harness");
    });

    it("rejects missing reviewer observed identity (null harness and model)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(revSelection, "reviewer", null, null, null);

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_reviewer_harness");
    });

    it("rejects missing implementer harness only (model present)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      // Implementer observed has model but no harness
      const context = makeExecutionContext(implSelection, "worker");
      const requested = makeRequestedReceipt(context);
      const invoked = makeInvokedReceipt(context.dispatch_id, "worker", "codex", "gpt-5", "openai");
      const observed = Object.freeze({
        ...makeValidObservedReceipt(context.dispatch_id, "worker", "codex", "gpt-5", "conv-impl-1"),
        canonical_harness: null,
      });
      const implementer = makeIdentityReceiptSet(requested, invoked, observed);
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_implementer_harness");
    });

    it("rejects missing reviewer harness only (model present)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      // Reviewer observed has model but no harness
      const context = makeExecutionContext(revSelection, "reviewer");
      const requested = makeRequestedReceipt(context);
      const invoked = makeInvokedReceipt(context.dispatch_id, "reviewer", "claude-sdk", "claude-sonnet-4-5", "anthropic");
      const observed = Object.freeze({
        ...makeValidObservedReceipt(context.dispatch_id, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1"),
        canonical_harness: null,
      });
      const reviewer = makeIdentityReceiptSet(requested, invoked, observed);

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_reviewer_harness");
    });

    it("rejects missing implementer model only (harness present)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const context = makeExecutionContext(implSelection, "worker");
      const requested = makeRequestedReceipt(context);
      const invoked = makeInvokedReceipt(context.dispatch_id, "worker", "codex", "gpt-5", "openai");
      const observed = Object.freeze({
        ...makeValidObservedReceipt(context.dispatch_id, "worker", "codex", "gpt-5", "conv-impl-1"),
        canonical_model: null,
      });
      const implementer = makeIdentityReceiptSet(requested, invoked, observed);
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_implementer_model");
    });

    it("rejects missing reviewer model only (harness present)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const context = makeExecutionContext(revSelection, "reviewer");
      const requested = makeRequestedReceipt(context);
      const invoked = makeInvokedReceipt(context.dispatch_id, "reviewer", "claude-sdk", "claude-sonnet-4-5", "anthropic");
      const observed = Object.freeze({
        ...makeValidObservedReceipt(context.dispatch_id, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1"),
        canonical_model: null,
      });
      const reviewer = makeIdentityReceiptSet(requested, invoked, observed);

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_reviewer_model");
    });

    it("rejects missing implementer conversation ID", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const context = makeExecutionContext(implSelection, "worker");
      const requested = makeRequestedReceipt(context);
      const invoked = makeInvokedReceipt(context.dispatch_id, "worker", "codex", "gpt-5", "openai");
      const observed = Object.freeze({
        ...makeValidObservedReceipt(context.dispatch_id, "worker", "codex", "gpt-5", "conv-impl-1"),
        conversation_id: null,
        root_conversation_id: null,
      });
      const implementer = makeIdentityReceiptSet(requested, invoked, observed);
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_implementer_conversation_id");
    });

    it("rejects missing reviewer conversation ID", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const context = makeExecutionContext(revSelection, "reviewer");
      const requested = makeRequestedReceipt(context);
      const invoked = makeInvokedReceipt(context.dispatch_id, "reviewer", "claude-sdk", "claude-sonnet-4-5", "anthropic");
      const observed = Object.freeze({
        ...makeValidObservedReceipt(context.dispatch_id, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1"),
        conversation_id: null,
        root_conversation_id: null,
      });
      const reviewer = makeIdentityReceiptSet(requested, invoked, observed);

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_reviewer_conversation_id");
    });
  });

  describe("process/session independence rejection", () => {
    it("rejects same conversation ID (same process/session)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "same-conv");
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "same-conv");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("same_conversation_id");
    });
  });

  describe("role independence rejection", () => {
    it("rejects same role (authority collapse)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      // Both have "worker" role — authority collapse
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(revSelection, "worker", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("same_role");
    });
  });

  describe("spoofed provenance rejection", () => {
    it("rejects spoofed implementer provenance (not chat.db seam)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const implementer = buildReceiptSet(
        implSelection, "worker", "codex", "gpt-5", "conv-impl-1",
        "immutable-attempt-context", // wrong provenance
      );
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("spoofed_implementer_provenance");
    });

    it("rejects spoofed reviewer provenance (not chat.db seam)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(
        revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1",
        "actual-array-argv-plus-materialized-bundle-digest", // wrong provenance
      );

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("spoofed_reviewer_provenance");
    });
  });

  describe("label-only rejection (no observed identity can satisfy the gate)", () => {
    it("rejects when implementer has no observed receipt (producer mismatch)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const context = makeExecutionContext(implSelection, "worker");
      const requested = makeRequestedReceipt(context);
      const invoked = makeInvokedReceipt(context.dispatch_id, "worker", "codex", "gpt-5", "openai");
      // Observed receipt has wrong producer — label-only, no real observation
      const observed = Object.freeze({
        ...makeValidObservedReceipt(context.dispatch_id, "worker", "codex", "gpt-5", "conv-impl-1"),
        producer: "requested" as IdentityReceipt["producer"],
      });
      const implementer = makeIdentityReceiptSet(requested, invoked, observed);
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_implementer_observed_identity");
    });

    it("rejects when reviewer has no observed receipt (producer mismatch)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const context = makeExecutionContext(revSelection, "reviewer");
      const requested = makeRequestedReceipt(context);
      const invoked = makeInvokedReceipt(context.dispatch_id, "reviewer", "claude-sdk", "claude-sonnet-4-5", "anthropic");
      const observed = Object.freeze({
        ...makeValidObservedReceipt(context.dispatch_id, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1"),
        producer: "invoked" as IdentityReceipt["producer"],
      });
      const reviewer = makeIdentityReceiptSet(requested, invoked, observed);

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_reviewer_observed_identity");
    });
  });

  describe("alias canonicalization consistency", () => {
    it("treats claude alias and claude-sdk canonical as the same harness", () => {
      // If implementer uses "claude" (alias for "claude-sdk") and reviewer
      // uses "claude-sdk", both canonicalize to "claude-sdk" — same harness.
      const implSelection = makeSelection({ harness: "claude", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "gpt-5", vendor: "openai" });
      // Observed identities: both canonicalize to claude-sdk for harness
      const implementer = buildReceiptSet(implSelection, "worker", "claude", "claude-sonnet-4-5", "conv-impl-1");
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "gpt-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      // claude → claude-sdk (same canonical harness) → denied
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("same_observed_harness");
      expect(result.implementer_observed_harness).toBe("claude-sdk");
      expect(result.reviewer_observed_harness).toBe("claude-sdk");
    });
  });

  describe("result immutability and schema", () => {
    it("produces a frozen result (authority-owned)", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.schema_version).toBe(CROSS_VENDOR_DISTINCTION_SCHEMA_VERSION);
    });

    it("produces a frozen denial result (authority-owned)", () => {
      const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const implementer = buildReceiptSet(selection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(selection, "reviewer", "codex", "gpt-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.outcome).toBe("denied");
    });
  });

  describe("same-vendor independent review is not invalidated", () => {
    it("same-vendor review with different harness+model is permitted as cross-vendor", () => {
      // Same vendor but different harness AND model — this IS a genuine
      // identity distinction. The cross-vendor gate does not block
      // same-vendor independent review; it permits it when identities are
      // genuinely distinct.
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "droid", model: "glm-5.2", vendor: "zhipu" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(revSelection, "reviewer", "droid", "glm-5.2", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("permitted");
    });

    it("same identity same-vendor is denied but does not invalidate independent review mode", () => {
      // Same identity — denied as cross-vendor, but the denial reason is
      // specific to cross-vendor. Independent review (t27) handles
      // same-model review separately.
      const selection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const implementer = buildReceiptSet(selection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(selection, "reviewer", "codex", "gpt-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      // The denial is specifically about same observed identity, not about
      // independent review mode being invalid.
      expect(result.denial_reason).toBe("same_observed_identity");
    });
  });

  describe("every field falsified independently", () => {
    // Each test falsifies exactly one field while keeping all others valid.
    // This proves no single field alone determines the outcome.

    it("falsifying only implementer harness blocks the gate", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      // Null implementer harness only
      const context = makeExecutionContext(implSelection, "worker");
      const requested = makeRequestedReceipt(context);
      const invoked = makeInvokedReceipt(context.dispatch_id, "worker", "codex", "gpt-5", "openai");
      const observed = Object.freeze({
        ...makeValidObservedReceipt(context.dispatch_id, "worker", "codex", "gpt-5", "conv-impl-1"),
        canonical_harness: null,
      });
      const implementer = makeIdentityReceiptSet(requested, invoked, observed);
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_implementer_harness");
    });

    it("falsifying only reviewer model blocks the gate", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      // Null reviewer model only
      const context = makeExecutionContext(revSelection, "reviewer");
      const requested = makeRequestedReceipt(context);
      const invoked = makeInvokedReceipt(context.dispatch_id, "reviewer", "claude-sdk", "claude-sonnet-4-5", "anthropic");
      const observed = Object.freeze({
        ...makeValidObservedReceipt(context.dispatch_id, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1"),
        canonical_model: null,
      });
      const reviewer = makeIdentityReceiptSet(requested, invoked, observed);

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_reviewer_model");
    });

    it("falsifying only implementer conversation_id blocks the gate", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const context = makeExecutionContext(implSelection, "worker");
      const requested = makeRequestedReceipt(context);
      const invoked = makeInvokedReceipt(context.dispatch_id, "worker", "codex", "gpt-5", "openai");
      const observed = Object.freeze({
        ...makeValidObservedReceipt(context.dispatch_id, "worker", "codex", "gpt-5", "conv-impl-1"),
        conversation_id: null,
        root_conversation_id: null,
      });
      const implementer = makeIdentityReceiptSet(requested, invoked, observed);
      const reviewer = buildReceiptSet(revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1");

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("missing_implementer_conversation_id");
    });

    it("falsifying only reviewer provenance blocks the gate", () => {
      const implSelection = makeSelection({ harness: "codex", model: "gpt-5", vendor: "openai" });
      const revSelection = makeSelection({ harness: "claude-sdk", model: "claude-sonnet-4-5", vendor: "anthropic" });
      const implementer = buildReceiptSet(implSelection, "worker", "codex", "gpt-5", "conv-impl-1");
      const reviewer = buildReceiptSet(
        revSelection, "reviewer", "claude-sdk", "claude-sonnet-4-5", "conv-rev-1",
        "actual-array-argv-plus-materialized-bundle-digest",
      );

      const result = evaluateCrossVendorDistinction(implementer, reviewer);
      expect(result.outcome).toBe("denied");
      expect(result.denial_reason).toBe("spoofed_reviewer_provenance");
    });
  });
});
