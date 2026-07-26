import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import verticalSchema from "../../schemas/vertical-slice-receipt.schema.json";
import { receiptDigest } from "../../src/release-proof/canonical.js";
import {
  validateVerticalSliceReceipt,
  type ReceiptExpectations,
} from "../../src/release-proof/receipt-validator.js";
import fixture from "../fixtures/protected-release/manifest.json";

type Json = Record<string, any>;

const now = new Date("2026-07-23T12:00:00.000Z");
const expected: ReceiptExpectations = {
  sourceGitOid: fixture.t37.source_git_oid,
  releaseId: fixture.t37.release_id,
  releaseSha256: fixture.t37.release_sha256,
  buildId: fixture.t37.build_id,
  buildSha256: fixture.t37.build_sha256,
  npmArchiveSha256: fixture.t37.npm_archive_sha256,
  wheelArchiveSha256: fixture.t37.wheel_archive_sha256,
  packedInstallReceiptSha256: fixture.t37.packed_install_receipt_sha256,
  requiredCheckIds: ["protected-run-1", "protected-run-2"],
  requiredCorpusIds: fixture.corpora.map((corpus) => corpus.id),
  now,
};

function evidenceId(run: number, corpusId: string): string {
  return `run:${run}:corpus:${corpusId}`;
}

function makeReceipt(): Json {
  const evidence = [1, 2].flatMap((run) => [
    ...fixture.corpora.map((corpus) => ({
      evidence_id: evidenceId(run, corpus.id),
      classification: "live",
      authenticated: true,
      sha256: corpus.sha256,
      redaction: "public",
    })),
    ...(["implementation", "review"] as const).map((role) => ({
      evidence_id: `run:${run}:model:${role}`,
      classification: "live",
      authenticated: true,
      sha256: (run === 1 ? (role === "implementation" ? "1" : "2") : (role === "implementation" ? "3" : "4")).repeat(64),
      redaction: "sensitive_redacted",
    })),
  ]);
  const runs = [1, 2].map((run) => {
    const oid = (run === 1 ? "a" : "b").repeat(40);
    return {
      run_id: `protected-${run}`,
      persistent_state_id: `state-protected-${run}`,
      installed_executable_realpath: `/opt/rickgent-t37-${fixture.t37.build_id}/bin/rickgent`,
      installed_lifecycle: {
        entrypoint: "rickgent __protected-release",
        executable_sha256: "9".repeat(64),
        controller_process_id: 50 + run,
        attempt_process_ids: [100 + run * 10, 101 + run * 10],
      },
      attempts: [
        {
          attempt_id: `protected-${run}:crash`,
          process_id: 100 + run * 10,
          process_group_id: 200 + run * 10,
          phase: "crash",
          started_at: "2026-07-23T11:00:00.000Z",
          ended_at: "2026-07-23T11:00:01.000Z",
          death_observed: true,
        },
        {
          attempt_id: `protected-${run}:resume`,
          process_id: 101 + run * 10,
          process_group_id: 201 + run * 10,
          phase: "resume",
          started_at: "2026-07-23T11:00:02.000Z",
          ended_at: "2026-07-23T11:00:03.000Z",
          death_observed: false,
        },
      ],
      model_observations: [
        {
          role: "implementation",
          canonical_provider: "openai",
          dispatch_id: `dispatch-${run}-implementation`,
          conversation_id: `conversation-${run}-implementation`,
          requested_model: "implementation-model",
          invoked_model: "implementation-model",
          observed_model: "implementation-model",
          observed_canonical_model: "implementation-model",
          observed_provider: "openai",
          process_id: 100 + run * 10,
          provider_process_id: 300 + run * 10,
          adapter: "provider-alpha",
          bundle_sha256: "5".repeat(64),
          identity_sha256: "7".repeat(64),
          evidence_id: `run:${run}:model:implementation`,
        },
        {
          role: "review",
          canonical_provider: "anthropic",
          dispatch_id: `dispatch-${run}-review`,
          conversation_id: `conversation-${run}-review`,
          requested_model: "review-model",
          invoked_model: "review-model",
          observed_model: "review-model",
          observed_canonical_model: "review-model",
          observed_provider: "firstParty",
          process_id: 101 + run * 10,
          provider_process_id: 301 + run * 10,
          adapter: "provider-beta",
          bundle_sha256: "6".repeat(64),
          identity_sha256: "8".repeat(64),
          evidence_id: `run:${run}:model:review`,
        },
      ],
      delivery: {
        branch: `${fixture.remote.owned_branch_prefix}protected-${run}`,
        observed_branch_oid: oid,
        pull_request_id: `fixture-pr-${run}`,
        pull_request_head_oid: oid,
        delivery_oid: oid,
        duplicate_side_effects: false,
      },
      containment_passed: true,
      lifecycle_complete: true,
      cleanup: {
        owned_pull_request_closed: true,
        branch_compare_before_delete_oid: oid,
        failure_path: {
          run_id: `protected-${run}`,
          base_branch: fixture.remote.base_branch,
          branch: `${fixture.remote.owned_branch_prefix}protected-${run}-failure-cleanup`,
          delivery_oid: oid,
          pull_request_id: String(100 + run),
          pull_request_head_oid: oid,
          owned_branch_absent_on_requery: true,
          owned_pull_request_closed: true,
          repository_preserved: true,
        },
        owned_branch_absent_on_requery: true,
        repository_preserved: true,
      },
    };
  });
  const receipt: Json = {
    schema_version: "1.0.0",
    proof_version: "vertical-slice-proof-v1",
    redaction_version: "rickgent-redaction-v1",
    canonicalization: "rickgent-canonical-json-v1",
    digest_algorithm: "sha256_over_utf8_canonical_bytes_excluding_top_level_digest",
    digest: "0".repeat(64),
    binding: {
      source_git_oid: fixture.t37.source_git_oid,
      release: { id: fixture.t37.release_id, sha256: fixture.t37.release_sha256 },
      build: { id: fixture.t37.build_id, sha256: fixture.t37.build_sha256 },
      npm_archive_sha256: fixture.t37.npm_archive_sha256,
      wheel_archive_sha256: fixture.t37.wheel_archive_sha256,
      packed_install_receipt_sha256: fixture.t37.packed_install_receipt_sha256,
      packed_install_schema_id: "https://rickgent.dev/schemas/packed-install-receipt-v1.json",
      corpora: structuredClone(fixture.corpora),
    },
    repository: {
      ...fixture.remote,
      allowlisted_disposable: true,
      pre_existing: true,
    },
    evidence: {
      items: evidence,
      fixture_substitution: false,
      contains_raw_secrets: false,
    },
    checks: [1, 2].map((run) => ({
      check_id: `protected-run-${run}`,
      outcome: "pass",
      required: true,
      evidence_ids: evidence.filter((item) => item.evidence_id.startsWith(`run:${run}:`)).map((item) => item.evidence_id),
    })),
    runs,
    cleanup: {
      success_path: { kind: "success", completed: true, independently_requeried: true },
      failure_path: { kind: "failure", completed: true, independently_requeried: true },
      repository_deleted: false,
    },
  };
  receipt.digest = receiptDigest(receipt);
  return receipt;
}

function redigest(receipt: Json): Json {
  receipt.digest = receiptDigest(receipt);
  return receipt;
}

function verticalSemantics(receipt: Json): string[] {
  const errors: string[] = [];
  const evidenceIds = new Set(receipt.evidence.items.map((item: Json) => item.evidence_id));
  const allAttemptIds = new Set<string>();
  for (const [index, run] of receipt.runs.entries()) {
    const runNumber = index + 1;
    if (run.run_id !== `protected-${runNumber}` || run.persistent_state_id !== `state-${run.run_id}`) {
      errors.push("run/state authority changed across resume");
    }
    for (const attempt of run.attempts) {
      if (allAttemptIds.has(attempt.attempt_id)) errors.push("attempt IDs are not distinct");
      allAttemptIds.add(attempt.attempt_id);
      if (!attempt.attempt_id.startsWith(`${run.run_id}:`)) errors.push("attempt is not correlated to run");
    }
    const processIds = new Set(run.attempts.map((attempt: Json) => attempt.process_id));
    if (run.model_observations.some((observation: Json) => !processIds.has(observation.process_id))) {
      errors.push("model observation is not correlated to an attempt process");
    }
    if (new Set(run.model_observations.map((item: Json) => item.adapter)).size !== 2) {
      errors.push("implementation and review providers are not distinct");
    }
    if (run.model_observations.some((item: Json) =>
      item.requested_model !== item.invoked_model ||
      item.requested_model !== item.observed_model
    )) errors.push("requested/invoked/observed identity mismatch");
    const expectedCorpusEvidence = fixture.corpora.map((corpus) => evidenceId(runNumber, corpus.id));
    if (expectedCorpusEvidence.some((id) => !evidenceIds.has(id))) errors.push("run corpus mirror incomplete");
    const check = receipt.checks.find((item: Json) => item.check_id === `protected-run-${runNumber}`);
    const completeRunEvidence = receipt.evidence.items
      .filter((item: Json) => item.evidence_id.startsWith(`run:${runNumber}:`))
      .map((item: Json) => item.evidence_id)
      .sort();
    if (JSON.stringify([...check.evidence_ids].sort()) !== JSON.stringify(completeRunEvidence)) {
      errors.push("per-run evidence reference closure incomplete");
    }
    if (
      run.cleanup.owned_pull_request_closed !== true ||
      run.cleanup.owned_branch_absent_on_requery !== true ||
      run.cleanup.repository_preserved !== true ||
      run.cleanup.branch_compare_before_delete_oid !== run.delivery.delivery_oid
    ) errors.push("per-run cleanup incomplete");
    const failureCleanup = run.cleanup.failure_path;
    if (
      failureCleanup.run_id !== run.run_id ||
      failureCleanup.base_branch !== fixture.remote.base_branch ||
      failureCleanup.branch !== `${fixture.remote.owned_branch_prefix}${run.run_id}-failure-cleanup` ||
      failureCleanup.delivery_oid !== run.delivery.delivery_oid ||
      failureCleanup.pull_request_head_oid !== run.delivery.delivery_oid ||
      !/^[1-9][0-9]*$/.test(failureCleanup.pull_request_id) ||
      failureCleanup.owned_branch_absent_on_requery !== true ||
      failureCleanup.owned_pull_request_closed !== true ||
      failureCleanup.repository_preserved !== true
    ) errors.push("per-run failure cleanup identity changed");
  }
  if (
    receipt.cleanup.success_path.completed !== true ||
    receipt.cleanup.success_path.independently_requeried !== true ||
    receipt.cleanup.failure_path.completed !== true ||
    receipt.cleanup.failure_path.independently_requeried !== true ||
    receipt.cleanup.repository_deleted !== false
  ) errors.push("aggregate cleanup incomplete");
  return errors;
}

function validate(receipt: Json) {
  return {
    shared: validateVerticalSliceReceipt(
      receipt,
      verticalSchema as Record<string, unknown>,
      expected,
    ),
    semantic: verticalSemantics(receipt),
  };
}

describe("t37 vertical-slice receipt hermetic contract", () => {
  it("accepts exactly two complete mirrored evidence trees bound to committed t37", () => {
    for (const corpus of fixture.corpora) {
      const path = resolve("..", corpus.id);
      expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(corpus.sha256);
    }
    const result = validate(makeReceipt());
    expect(result.shared).toMatchObject({ ok: true, diagnostics: [] });
    expect(result.semantic).toEqual([]);
  });

  it("rejects unstable authority, repeated attempts, process miscorrelation, and stale terminal topology", () => {
    const mutations: Array<(receipt: Json) => void> = [
      (receipt) => { receipt.runs[0].persistent_state_id = "state-from-stale-terminal"; },
      (receipt) => { receipt.runs[0].attempts[1].attempt_id = receipt.runs[0].attempts[0].attempt_id; },
      (receipt) => { receipt.runs[0].model_observations[1].process_id = 9999; },
      (receipt) => { receipt.runs[0].attempts[1].process_id = receipt.runs[0].attempts[0].process_id; },
      (receipt) => { receipt.runs[0].attempts[1].process_group_id = receipt.runs[0].attempts[0].process_group_id; },
    ];
    for (const mutate of mutations) {
      const receipt = makeReceipt();
      mutate(receipt);
      const result = validate(redigest(receipt));
      expect(result.shared.ok && result.semantic.length === 0).toBe(false);
    }
  });

  it("rejects identity drift, same-provider review, fixture evidence, and incomplete corpus/reference trees", () => {
    const mutations: Array<(receipt: Json) => void> = [
      (receipt) => { receipt.runs[0].model_observations[0].observed_model = "substituted-model"; },
      (receipt) => { receipt.runs[0].model_observations[1].adapter = "provider-alpha"; },
      (receipt) => { receipt.evidence.items[0].classification = "fixture"; },
      (receipt) => {
        const missing = evidenceId(2, fixture.corpora[0]!.id);
        receipt.evidence.items = receipt.evidence.items.filter((item: Json) => item.evidence_id !== missing);
      },
      (receipt) => { receipt.checks[1].evidence_ids.pop(); },
    ];
    for (const mutate of mutations) {
      const receipt = makeReceipt();
      mutate(receipt);
      const result = validate(redigest(receipt));
      expect(result.shared.ok && result.semantic.length === 0).toBe(false);
    }
  });

  it("rejects delivery inequality, duplicate effects, stale evidence, and incomplete per-run or aggregate cleanup", () => {
    const mutations: Array<(receipt: Json) => void> = [
      (receipt) => { receipt.runs[0].delivery.pull_request_head_oid = "c".repeat(40); },
      (receipt) => { receipt.runs[0].delivery.duplicate_side_effects = true; },
      (receipt) => { receipt.runs[0].attempts[0].started_at = "2020-01-01T00:00:00.000Z"; },
      (receipt) => { receipt.runs[1].cleanup.owned_branch_absent_on_requery = false; },
      (receipt) => { receipt.runs[0].cleanup.failure_path.pull_request_head_oid = "d".repeat(40); },
      (receipt) => { receipt.cleanup.failure_path.independently_requeried = false; },
      (receipt) => { receipt.binding.packed_install_receipt_sha256 = "0".repeat(64); },
    ];
    for (const mutate of mutations) {
      const receipt = makeReceipt();
      mutate(receipt);
      const result = validate(redigest(receipt));
      expect(result.shared.ok && result.semantic.length === 0).toBe(false);
    }
  });
});
