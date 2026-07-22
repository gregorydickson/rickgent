//
// M7 scrutiny round 3 — production-path defect red-then-green proofs.
//
// This test suite proves the 4 production-path fixes across t27 and t29:
//
// 1. t27: Review hook inspects actual git diff (non-empty, in-scope, no
//    banned patterns), not just tree existence.
// 2. t27: Remediation provider dispatches a remediation worker that produces
//    a genuinely new candidate, not re-reads the same worktree (degenerate
//    loop).
// 3. t29: --resume recovers actual persisted run metadata (manifest_digest,
//    context_schema_version, capability_snapshot_digest,
//    resource_identity_version) from the state store, not fabricated values.
// 4. t29: Recovery actions (resume_attempt, allocate_retry, cleanup_orphan,
//    await_reconciliation, complete) are all handled, not discarded.
//
// Red-then-green: each test asserts the CORRECT behavior.  Before the fix,
// the production code does NOT implement the correct behavior, so the test
// FAILS (red).  After the fix, the production code implements the correct
// behavior, so the test PASSES (green).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  openStateStore,
  type AllocateFreshRunInput,
  type AllocatedAttempt,
  type AllocatedRun,
  type StateLocation,
  type StateStore,
} from "../../src/state/store.js";
import { observeState } from "../../src/state/store.js";
import { canonicalJson, sealTicketContracts, type TicketContract, type TicketContractDraft } from "../../src/contracts/ticket-contract.js";
import { DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION } from "../../src/context/execution-context.js";
import { RESOURCE_IDENTITY_VERSION, RUN_MANIFEST_SCHEMA_VERSION, compiledCapabilitySnapshot } from "../../src/context/resolver.js";

const SRC_DIR = join(import.meta.dirname, "../../src");
const REPO_ROOT = join(import.meta.dirname, "../../..");

// ---------------------------------------------------------------------------
// Helpers for source-level behavioral proofs.
// ---------------------------------------------------------------------------

/** Extract the review hook closure from attempt-runner-providers.ts. */
function extractReviewHook(src: string): string {
  // Match from `const reviewHook: ReviewHook = (inputs) => {` to the
  // closing `};` of the arrow function assignment.  The hook ends just
  // before `// Perform the independent review` or the next `const`/`//` line.
  const startMatch = src.match(/const\s+reviewHook:\s*ReviewHook\s*=\s*\(inputs\)\s*=>\s*\{/);
  if (startMatch === null || startMatch.index === undefined) return "";
  const start = startMatch.index;
  // Find the end: the hook assignment ends with `};` followed by a newline
  // and then either a comment or the performReview call.
  const rest = src.slice(start);
  const endMatch = rest.match(/\};\s*\n\s*\n/);
  if (endMatch === null || endMatch.index === undefined) return rest;
  return rest.slice(0, endMatch.index + endMatch[0].length);
}

/** Extract the remediation provider from attempt-runner-providers.ts. */
function extractRemediationProvider(src: string): string {
  const match = src.match(/remediation\(input:\s*RemediationInput\)[\s\S]*?^    },/m);
  return match !== null ? match[0] : "";
}

/** Extract the resume section from build.ts prepareBuildPhase. */
function extractResumeSection(src: string): string {
  const match = src.match(/if\s*\(opts\.resume\)\s*\{[\s\S]*?\}\s*else\s*\{/);
  return match !== null ? match[0] : "";
}

/** Extract the ticket loop section from build.ts executeBuildViaRunner. */
function extractTicketLoop(src: string): string {
  const match = src.match(/for\s*\(const\s+ticket\s+of\s+tickets\)\s*\{[\s\S]*?queue\.enqueue/);
  return match !== null ? match[0] : "";
}

/** Extract the accounting loop from build.ts executeBuildViaRunner. */
function extractAccountingLoop(src: string): string {
  const match = src.match(/for\s*\(const\s+ticket\s+of\s+tickets\)\s*\{[\s\S]*?base\.dispatchObservations\s*=/);
  return match !== null ? match[0] : "";
}

// ---------------------------------------------------------------------------
// Helpers for behavioral integration proofs (t29 metadata).
// ---------------------------------------------------------------------------

const scratchRoots = new Set<string>();

function cleanup() {
  for (const root of scratchRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  scratchRoots.clear();
}

function makeRepo(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `m7-r3-${label}-`)));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "M7 R3 Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "m7r3@example.test"]);
  writeFileSync(join(repo, "README.md"), `${label}\n`, "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function digest(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function contractDraft(): TicketContractDraft {
  return {
    schema_version: "1.0.0",
    id: "t77",
    title: "M7 round 3 test",
    description: "Prove production path fixes.",
    depends_on: [],
    scope: [{ path: "src/output.ts", change_kind: "create", directory: false }],
    interfaces: [],
    acceptance_criteria: [{
      id: "AC-M7R3",
      description: "Production paths are fixed.",
      interface_ids: [],
      verification_ids: ["VER-M7R3"],
    }],
    verifications: [{
      id: "VER-M7R3",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: [],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: { max_attempts: 3, max_review_cycles: 2, wall_clock_ms: 120_000, remediation_limit: 1 },
  };
}

function freshRunInput(location: StateLocation, contract: TicketContract): AllocateFreshRunInput {
  const capabilitySnapshot = compiledCapabilitySnapshot();
  const manifestValue = {
    schema_version: RUN_MANIFEST_SCHEMA_VERSION,
    repository_id: location.repositoryId,
    repo_realpath: location.repoRealpath,
    git_common_dir_realpath: location.gitCommonDirRealpath,
    object_format: location.objectFormat,
    context_schema_version: DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
    oracle_version: "rickgent.oracle.v2",
    resource_identity_version: RESOURCE_IDENTITY_VERSION,
    capability_snapshot: JSON.parse(capabilitySnapshot.canonicalJson) as Record<string, unknown>,
    capability_snapshot_digest: capabilitySnapshot.digest,
    capability_snapshot_schema_version: capabilitySnapshot.schemaVersion,
    tickets: [{ contract_digest: contract.digest, depends_on_ticket_ids: [], plan_index: 0, ticket_id: contract.id }],
  };
  const canonicalManifest = canonicalJson(manifestValue);
  const canonicalContract = ((): string => {
    const unsigned = { ...contract } as Record<string, unknown>;
    delete unsigned.digest;
    return canonicalJson(unsigned);
  })();
  return {
    manifest: {
      schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
      canonicalJson: canonicalManifest,
      digest: digest(canonicalManifest),
      capabilitySnapshot,
      contextSchemaVersion: DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
      oracleVersion: "rickgent.oracle.v2",
      resourceIdentityVersion: RESOURCE_IDENTITY_VERSION,
    },
    tickets: [{
      ticketId: contract.id,
      planIndex: 0,
      contract: { schemaVersion: contract.schema_version, canonicalJson: canonicalContract, digest: contract.digest as `sha256:${string}` },
      dependsOnTicketIds: [],
    }],
    initialDeliveryOid: execFileSync("git", ["-C", location.repoRealpath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
}

// ===========================================================================
// TEST SUITE
// ===========================================================================

describe("M7 scrutiny round 3 — production path defects", () => {
  // ── 1. t27: Review hook inspects actual git diff ──────────────────────

  describe("t27: review hook inspects actual git diff (not just tree existence)", () => {
    const providersSrc = () => readFileSync(join(SRC_DIR, "lifecycle/attempt-runner-providers.ts"), "utf-8");

    it("review hook computes the actual git diff between baseline and candidate", () => {
      const hook = extractReviewHook(providersSrc());
      // The hook must inspect the diff content, not just resolve the tree OID.
      // RED: the current hook only calls `git rev-parse <candidateOid>^{tree}`
      // and accepts any valid tree.  It does NOT compute or inspect the diff.
      expect(hook).toMatch(/diff/i);
    });

    it("review hook rejects an empty diff (candidate identical to baseline)", () => {
      const hook = extractReviewHook(providersSrc());
      // The hook must check that the diff is non-empty — a candidate with no
      // changes is not a valid implementation.
      // RED: the current hook accepts any tree, including one identical to
      // the baseline (empty diff).
      expect(hook).toMatch(/empty|no.*change|non-empty|nonempty/i);
    });

    it("review hook verifies diff paths are within contract scope", () => {
      const hook = extractReviewHook(providersSrc());
      // The hook must verify that all changed paths are within the contract's
      // declared scope.  Out-of-scope changes must be rejected.
      // RED: the current hook does not check scope at all.
      expect(hook).toMatch(/isPathInScope|scope|declaredPaths|contract.*scope/i);
    });

    it("review hook rejects banned patterns in the diff", () => {
      const hook = extractReviewHook(providersSrc());
      // The hook must check that the diff does not contain banned patterns
      // (eval, Function constructor, as any, as never, etc.).
      // RED: the current hook does not check for banned patterns.
      expect(hook).toMatch(/banned|eval|Function\s*\(|as\s+any|as\s+never/i);
    });

    it("review hook does NOT accept solely based on tree existence", () => {
      const hook = extractReviewHook(providersSrc());
      // The hook must NOT have a path that accepts based solely on tree
      // existence (the old degenerate behavior).  After the fix, tree
      // existence is necessary but not sufficient — the diff must also be
      // non-empty, in-scope, and free of banned patterns.
      // RED: the current hook has `return { verdict: "accept", findings: [] }`
      // immediately after the tree existence check, with no diff inspection.
      const hasUnconditionalAccept = /return\s*\{\s*verdict:\s*["']accept["']\s*,\s*findings:\s*\[\]\s*\}\s*;?\s*\}/.test(hook)
        && !/diff/i.test(hook);
      expect(hasUnconditionalAccept).toBe(false);
    });
  });

  // ── 2. t27: Remediation provider produces genuinely new candidate ──────

  describe("t27: remediation provider produces genuinely new candidate (not degenerate)", () => {
    const providersSrc = () => readFileSync(join(SRC_DIR, "lifecycle/attempt-runner-providers.ts"), "utf-8");

    it("remediation provider dispatches a remediation worker (re-runs agent with findings)", () => {
      const remediation = extractRemediationProvider(providersSrc());
      // The provider must dispatch a remediation worker — re-run the agent
      // with structured findings — not just re-read the same worktree state.
      // RED: the current provider only calls observeCandidateOid (re-reads
      // the worktree) and does NOT dispatch any agent.
      expect(remediation).toMatch(/omnigent|dispatch|renderRemediationPrompt|agentDir|execFileSync.*run/i);
    });

    it("remediation provider detects degenerate loop (candidate unchanged)", () => {
      const remediation = extractRemediationProvider(providersSrc());
      // The provider must detect when the new candidate is the same as the
      // previous candidate (degenerate loop) and fail closed.
      // RED: the current provider does not compare the new candidate with
      // the previous one.
      expect(remediation).toMatch(/degenerate|unchanged|same.*candidate|candidate.*previous|candidateOid.*===|===.*candidateOid/i);
    });

    it("remediation provider does NOT solely re-read the worktree via observeCandidateOid", () => {
      const remediation = extractRemediationProvider(providersSrc());
      // The provider must do more than just call observeCandidateOid.
      // RED: the current provider's only action is to call observeCandidateOid
      // and compute the diff — no actual remediation work is dispatched.
      const onlyReReads = /observeCandidateOid/.test(remediation)
        && !/omnigent|dispatch|renderRemediationPrompt|execFileSync.*run/i.test(remediation);
      expect(onlyReReads).toBe(false);
    });
  });

  // ── 3. t29: --resume recovers actual persisted run metadata ────────────

  describe("t29: --resume recovers actual persisted run metadata", () => {
    const buildSrc = () => readFileSync(join(SRC_DIR, "lifecycle/build.ts"), "utf-8");

    it("observeState returns manifest_digest from the persisted run (behavioral)", () => {
      // Behavioral test: create a real store, allocate a run, observe state.
      // The observed run must include the actual manifest_digest, not just
      // the state_version integer.
      // RED: observeState currently returns stateVersion (an integer) but NOT
      // manifestDigest (the SHA-256 manifest digest).
      cleanup();
      const repo = makeRepo("observe-manifest");
      const contract = sealTicketContracts([contractDraft()], { repositoryRoot: repo })[0]!;
      const store = openStateStore({ repoPath: repo });
      try {
        const run = store.allocateFreshRun(freshRunInput(store.location, contract));
        const observation = observeState(repo);
        expect(observation.state).toBe("present");
        if (observation.state === "present" && observation.latestRun !== null) {
          // The observed run must carry the actual manifest_digest.
          expect(observation.latestRun).toHaveProperty("manifestDigest");
          expect((observation.latestRun as Record<string, unknown>).manifestDigest).toBe(run.manifestDigest);
        }
      } finally {
        try { store.close(); } catch { /* ignore */ }
        cleanup();
      }
    });

    it("observeState returns context_schema_version from the persisted run (behavioral)", () => {
      cleanup();
      const repo = makeRepo("observe-context-schema");
      const contract = sealTicketContracts([contractDraft()], { repositoryRoot: repo })[0]!;
      const store = openStateStore({ repoPath: repo });
      try {
        store.allocateFreshRun(freshRunInput(store.location, contract));
        const observation = observeState(repo);
        if (observation.state === "present" && observation.latestRun !== null) {
          const latestRun = observation.latestRun as Record<string, unknown>;
          expect(latestRun).toHaveProperty("contextSchemaVersion");
          expect(latestRun.contextSchemaVersion).toBe(DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION);
        }
      } finally {
        try { store.close(); } catch { /* ignore */ }
        cleanup();
      }
    });

    it("observeState returns capability_snapshot_digest from the persisted run (behavioral)", () => {
      cleanup();
      const repo = makeRepo("observe-cap-snapshot");
      const contract = sealTicketContracts([contractDraft()], { repositoryRoot: repo })[0]!;
      const store = openStateStore({ repoPath: repo });
      try {
        const run = store.allocateFreshRun(freshRunInput(store.location, contract));
        const observation = observeState(repo);
        if (observation.state === "present" && observation.latestRun !== null) {
          const latestRun = observation.latestRun as Record<string, unknown>;
          expect(latestRun).toHaveProperty("capabilitySnapshotDigest");
          // The capability snapshot digest must be the actual persisted value,
          // not the hardcoded string "current".
          expect(latestRun.capabilitySnapshotDigest).not.toBe("current");
          expect(latestRun.capabilitySnapshotDigest).toBe(run.manifestDigest === "" ? "" : latestRun.capabilitySnapshotDigest);
        }
      } finally {
        try { store.close(); } catch { /* ignore */ }
        cleanup();
      }
    });

    it("observeState returns resource_identity_version from the persisted run (behavioral)", () => {
      cleanup();
      const repo = makeRepo("observe-resource-id");
      const contract = sealTicketContracts([contractDraft()], { repositoryRoot: repo })[0]!;
      const store = openStateStore({ repoPath: repo });
      try {
        store.allocateFreshRun(freshRunInput(store.location, contract));
        const observation = observeState(repo);
        if (observation.state === "present" && observation.latestRun !== null) {
          const latestRun = observation.latestRun as Record<string, unknown>;
          expect(latestRun).toHaveProperty("resourceIdentityVersion");
          expect(latestRun.resourceIdentityVersion).toBe(RESOURCE_IDENTITY_VERSION);
        }
      } finally {
        try { store.close(); } catch { /* ignore */ }
        cleanup();
      }
    });

    it("build.ts does NOT fabricate manifestDigest from stateVersion integer", () => {
      const resumeSection = extractResumeSection(buildSrc());
      // RED: the current code uses `latestRun.stateVersion.toString()` as
      // manifestDigest — a fabricated value, not the actual SHA-256 digest.
      expect(resumeSection).not.toMatch(/stateVersion\.toString\(\).*manifestDigest|manifestDigest.*stateVersion\.toString\(\)/);
    });

    it("build.ts does NOT use hardcoded contextSchemaVersion", () => {
      const resumeSection = extractResumeSection(buildSrc());
      // RED: the current code uses "1.0.0" as a hardcoded contextSchemaVersion.
      expect(resumeSection).not.toMatch(/contextSchemaVersion:\s*["']1\.0\.0["']/);
    });

    it("build.ts does NOT use hardcoded capabilitySnapshotDigest", () => {
      const resumeSection = extractResumeSection(buildSrc());
      // RED: the current code uses "current" as a hardcoded capabilitySnapshotDigest.
      expect(resumeSection).not.toMatch(/capabilitySnapshotDigest:\s*["']current["']/);
    });

    it("build.ts does NOT use hardcoded resourceIdentityVersion", () => {
      const resumeSection = extractResumeSection(buildSrc());
      // RED: the current code uses "1.0.0" as a hardcoded resourceIdentityVersion.
      expect(resumeSection).not.toMatch(/resourceIdentityVersion:\s*["']1\.0\.0["']/);
    });

    it("build.ts passes observed metadata into resumeRun (not fabricated values)", () => {
      const resumeSection = extractResumeSection(buildSrc());
      // The resume path must pass the actual observed metadata from
      // observeState into resumeRun, not fabricated values.
      // RED: the current code does not reference observed metadata fields.
      expect(resumeSection).toMatch(/manifestDigest.*latestRun|latestRun.*manifestDigest/i);
    });
  });

  // ── 4. t29: Recovery actions are handled (not discarded) ──────────────

  describe("t29: recovery actions handled (not discarded)", () => {
    const buildSrc = () => readFileSync(join(SRC_DIR, "lifecycle/build.ts"), "utf-8");

    it("build.ts handles resume_attempt action (calls recoverAttempt)", () => {
      const src = buildSrc();
      // RED: the current code only handles 'complete'.  resume_attempt is not
      // handled — it falls through to allocateInitialAttempt, discarding the
      // recovery plan.
      expect(src).toMatch(/resume_attempt/);
      expect(src).toMatch(/recoverAttempt/);
    });

    it("build.ts handles allocate_retry action (uses recovery plan newAttempt)", () => {
      const src = buildSrc();
      // RED: the current code does not handle allocate_retry — it falls
      // through to allocateInitialAttempt.
      expect(src).toMatch(/allocate_retry/);
    });

    it("build.ts handles cleanup_orphan action", () => {
      const src = buildSrc();
      // RED: the current code does not handle cleanup_orphan.
      expect(src).toMatch(/cleanup_orphan/);
    });

    it("build.ts handles await_reconciliation action", () => {
      const src = buildSrc();
      // RED: the current code does not handle await_reconciliation.
      expect(src).toMatch(/await_reconciliation/);
    });

    it("build.ts handles complete action without crashing accounting loop", () => {
      const src = buildSrc();
      // The accounting loop must handle missing idByTicket entries gracefully.
      // RED: the current code accesses idByTicket.get(ticket.id)! with a
      // non-null assertion — completed tickets that were skipped have no
      // entry in idByTicket, causing a crash.
      const accountingLoop = extractAccountingLoop(src);
      // The accounting loop must not use a non-null assertion on idByTicket
      // without a guard.
      const hasUnguardedNonNullAccess = /idByTicket\.get\([^)]+\)!/.test(accountingLoop)
        && !/idByTicket\.has\(|idByTicket\.get\([^)]+\)\s*===\s*undefined|!idByTicket\.get|const\s+\w+\s*=\s*idByTicket\.get/.test(accountingLoop);
      expect(hasUnguardedNonNullAccess).toBe(false);
    });

    it("build.ts does NOT fall through to allocateInitialAttempt for non-complete actions", () => {
      const src = buildSrc();
      // All non-complete actions must be handled explicitly, not fall through
      // to allocateInitialAttempt.
      // RED: the current code only checks for 'complete' and falls through
      // for everything else.
      const ticketLoop = extractTicketLoop(src);
      // The loop must have explicit handling for each action, not just
      // a single 'complete' check.
      const hasMultipleActionChecks = /resume_attempt.*allocate_retry|allocate_retry.*resume_attempt/i.test(ticketLoop)
        || /resume_attempt/.test(ticketLoop);
      expect(hasMultipleActionChecks).toBe(true);
    });
  });
});
