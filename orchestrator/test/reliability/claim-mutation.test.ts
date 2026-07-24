import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProofClaimError,
  canonical,
  validateProofAuthorities,
} from "../../scripts/generate-release-proof-index.mjs";

const repoRoot = join(import.meta.dirname, "../../..");
const load = (path: string) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
const bytes = (path: string) => readFileSync(join(repoRoot, path));
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);

function resign(value: Record<string, unknown>): Buffer {
  delete value.digest;
  value.digest = sha256(canonical(value));
  return Buffer.from(`${canonical(value)}\n`);
}

const retained = {
  packed: load("artifacts/reliability/packed-install-summary.json"),
  packedBytes: bytes("artifacts/reliability/packed-install-summary.json"),
  vertical: load("artifacts/reliability/vertical-slice-receipt.json"),
  verticalBytes: bytes("artifacts/reliability/vertical-slice-receipt.json"),
  preflight: load("artifacts/reliability/protected-release-preflight.json"),
  diagnostics: load("artifacts/reliability/vertical-slice-failure-diagnostics.json"),
  fileDigests: {
    packed_schema_sha256: sha256(bytes("orchestrator/schemas/packed-install-receipt.schema.json")),
    vertical_schema_sha256: sha256(bytes("orchestrator/schemas/vertical-slice-receipt.schema.json")),
    preflight_sha256: sha256(bytes("artifacts/reliability/protected-release-preflight.json")),
    diagnostics_sha256: sha256(bytes("artifacts/reliability/vertical-slice-failure-diagnostics.json")),
    release_sha256: sha256(bytes("release-manifest.json")),
  },
  sidecars: { packed: "", vertical: "" },
  now: Date.parse("2026-07-24T03:45:00.000Z"),
};

function mutateVertical(change: (value: any) => void, claim: string) {
  const input = {
    ...retained,
    packed: clone(retained.packed),
    vertical: clone(retained.vertical),
    preflight: clone(retained.preflight),
    diagnostics: clone(retained.diagnostics),
    packedBytes: Buffer.from(retained.packedBytes),
    verticalBytes: Buffer.from(retained.verticalBytes),
  };
  change(input.vertical);
  input.verticalBytes = resign(input.vertical);
  const expected = {
    packed_digest: input.packed.digest,
    vertical_digest: input.vertical.digest,
    packed_schema_sha256: input.fileDigests.packed_schema_sha256,
    vertical_schema_sha256: input.fileDigests.vertical_schema_sha256,
    preflight_sha256: input.fileDigests.preflight_sha256,
    diagnostics_sha256: input.fileDigests.diagnostics_sha256,
    release_sha256: input.fileDigests.release_sha256,
  };
  expect(() => validateProofAuthorities({ ...input, expected, enforceExactBytes: false }))
    .toThrow(new RegExp(`^${claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
}

describe("retained proof claim mutations", () => {
  it("fails every proof mutation at its own claim", () => {
    mutateVertical((v) => { v.evidence.fixture_substitution = true; }, "vertical_receipt.fixture_substitution");
    mutateVertical((v) => { v.runs.pop(); }, "runs.count");
    mutateVertical((v) => { v.runs[0].lifecycle_complete = false; }, "lifecycle.protected-1");
    mutateVertical((v) => { v.runs[0].cleanup.owned_pull_request_closed = false; }, "cleanup.protected-1.pull_request");
    mutateVertical((v) => { v.runs[0].model_observations[0].adapter = "fixture"; }, "provider_pair.protected-1.implementation");
    mutateVertical((v) => { v.runs[0].model_observations[1].invoked_model = "other"; }, "provider_pair.protected-1.review");
    mutateVertical((v) => { v.runs[0].delivery.pull_request_head_oid = "0".repeat(40); }, "delivery.protected-1.pr_oid");
    mutateVertical((v) => { v.evidence.items[0].authenticated = false; }, "vertical_receipt.evidence.classification");
    mutateVertical((v) => { v.cleanup.failure_path.completed = false; }, "cleanup.aggregate.failure_path");
  });
});

const inventory = load("artifacts/reliability/claim-surface-inventory.json");
const cases = load("orchestrator/test/fixtures/claim-mutation/inventory-cases.json");
const EXPECTED_CLAIMS: Record<string, unknown> = {
  "capability.autonomous_dispatch": "local_sequential_attempt_runner",
  "capability.resume_retry": "proof_gated",
  "capability.cross_vendor_review": "installed_t38_exact_provider_pair_only",
  "capability.automatic_delivery": "installed_t38_allowlisted_disposable_remote_only",
  "capability.reconciliation": "local_t29_persisted_receipt_oracle_only",
  "capability.parallel_dispatch": "unavailable",
  "capability.raw_shell": "unavailable",
  "terminal.Done": "delivered_only_alias",
  "terminal.delivered": "remote_delivery_verified",
  "readiness.ready_for_delivery": "local_oracle_complete",
  "readiness.installed": "resume_retry, cross_vendor_review, and automatic_delivery require the valid installed_t38_retained_proof_v1 root; invalid evidence contracts all three.",
  "package.boundary": "immutable_after_retained_t38_proof",
  "platform.reference": "One t38 reference-platform observation; this is not a general Darwin, Linux, or cross-platform execution proof.",
  "readiness.hosted": "One allowlisted disposable GitHub repository was observed by t38; no general hosted-service claim is made.",
  "readiness.local": "Compiled local behavior; autonomous_dispatch is sequential and reconciliation is limited to the t29 persisted-receipt/oracle profile.",
  "provider_pair.scope": "Only Codex CLI/OpenAI/gpt-5.6-sol implementation plus Claude Code/Anthropic/claude-opus-4-8[1m] review is proved.",
};
const CLAIM_PATHS: Record<string, string> = Object.fromEntries(cases.map((item: any) => [item.claim, item.path]));

function at(value: any, path: string): unknown {
  return path.split(".").reduce((cursor, key) => cursor[key], value);
}
function validateInventory(value: any): void {
  for (const [claim, expected] of Object.entries(EXPECTED_CLAIMS)) {
    if (at(value, CLAIM_PATHS[claim]) !== expected) throw new ProofClaimError(claim, "claim was strengthened or changed");
  }
}

describe("public claim-surface mutations", () => {
  it.each(cases)("$name fails with $claim", ({ path, value, claim }: any) => {
    const mutated = clone(inventory);
    const parts = path.split(".");
    const leaf = parts.pop()!;
    const parent = parts.reduce((cursor: any, key: string) => cursor[key], mutated);
    parent[leaf] = value;
    expect(() => validateInventory(mutated)).toThrow(new RegExp(`^${claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
  });
});
