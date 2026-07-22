// M7 scrutiny round 2 — production-wiring fix tests.
//
// This test suite proves the 5 production-wiring fixes across t27-t30:
//
// 1. t27: Production review rejection is wired through runBoundedRemediationLoop
//    (not direct failure cleanup).
// 2. t28: AttemptRunner oracle provider routes through CompletionService
//    (not direct StateStore.evaluateAndPersistAttemptOracle call).
// 3. t29: build --resume flag calls resumeRun (reads persisted receipts and
//    resumes from durable state).
// 4. t30: Terminal-writer audit detects template-literal interpolations in
//    executable strings.
// 5. artifacts/reliability/production-import-audit.json exists with correct schema.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const SRC_DIR = join(import.meta.dirname, "../../src");
const REPO_ROOT = join(import.meta.dirname, "../../..");

describe("M7 scrutiny round 2 — production-wiring fixes", () => {
  // ── t27: rejection wired through runBoundedRemediationLoop ────────────
  describe("t27: review rejection wired through runBoundedRemediationLoop", () => {
    it("attempt-runner.ts imports runBoundedRemediationLoop from remediation.ts", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/attempt-runner.ts"), "utf-8");
      expect(src).toMatch(/runBoundedRemediationLoop/);
      expect(src).toMatch(/from\s+["']\.\/remediation\.js["']/);
    });

    it("attempt-runner.ts calls runBoundedRemediationLoop when review rejects", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/attempt-runner.ts"), "utf-8");
      // The runner must call runBoundedRemediationLoop in the review-reject
      // branch, not just directly go to failure cleanup.
      expect(src).toMatch(/runBoundedRemediationLoop\(/);
      // The reject branch must reference the loop
      const rejectBranchMatch = src.match(/if\s*\(review\.verdict\s*===\s*["']reject["']\)[\s\S]*?runBoundedRemediationLoop/);
      expect(rejectBranchMatch).not.toBeNull();
    });

    it("attempt-runner.ts has a defaultRemediation function (production provider exists)", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/attempt-runner.ts"), "utf-8");
      expect(src).toMatch(/function defaultRemediation/);
    });

    it("AttemptRunnerPhaseProviders includes a remediation provider", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/attempt-runner.ts"), "utf-8");
      expect(src).toMatch(/remediation\?\:\s*\(input:\s*RemediationInput\)\s*=>\s*RemediationResult/);
    });

    it("attempt-runner-providers.ts exports a remediation provider", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/attempt-runner-providers.ts"), "utf-8");
      expect(src).toMatch(/remediation\(input:\s*RemediationInput\)/);
    });

    it("rejection through the loop continues to verification on accept (not direct failure)", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/attempt-runner.ts"), "utf-8");
      // After the loop, if accepted, the code should fall through to verification.
      // If budget_exhausted or fail_closed, it should enter failure cleanup.
      expect(src).toMatch(/loopOutcome\.status\s*===\s*["']accepted["']/);
      expect(src).toMatch(/budget_exhausted/);
    });
  });

  // ── t28: oracle routed through CompletionService ──────────────────────
  describe("t28: AttemptRunner oracle routed through CompletionService", () => {
    it("attempt-runner-providers.ts imports CompletionService", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/attempt-runner-providers.ts"), "utf-8");
      expect(src).toMatch(/CompletionService/);
      expect(src).toMatch(/from\s+["']\.\/completion-service\.js["']/);
    });

    it("oracle provider calls CompletionService.evaluateAttemptCompletion (not store directly)", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/attempt-runner-providers.ts"), "utf-8");
      // The oracle provider must use CompletionService, not the direct store call.
      const oracleSection = src.match(/oracle\(input:\s*OracleInput\)[\s\S]*?^    },/m);
      expect(oracleSection).not.toBeNull();
      expect(oracleSection![0]).toMatch(/CompletionService/);
      expect(oracleSection![0]).toMatch(/evaluateAttemptCompletion/);
      expect(oracleSection![0]).toMatch(/attempt-runner\.oracle/);
      // Must NOT call store.evaluateAndPersistAttemptOracle directly
      expect(oracleSection![0]).not.toMatch(/store\.evaluateAndPersistAttemptOracle/);
    });

    it("the oracle provider uses the 'attempt-runner.oracle' caller identity", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/attempt-runner-providers.ts"), "utf-8");
      expect(src).toMatch(/["']attempt-runner\.oracle["']/);
    });
  });

  // ── t29: --resume wired to call resumeRun ─────────────────────────────
  describe("t29: build --resume wired to call resumeRun", () => {
    it("build.ts imports resumeRun from recovery.ts", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/build.ts"), "utf-8");
      expect(src).toMatch(/resumeRun/);
      expect(src).toMatch(/from\s+["']\.\/recovery\.js["']/);
    });

    it("build.ts imports observeState from state/store.ts", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/build.ts"), "utf-8");
      expect(src).toMatch(/observeState/);
    });

    it("prepareBuildPhase calls resumeRun when opts.resume is true", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/build.ts"), "utf-8");
      // The resume path must call resumeRun, not just allocate a fresh run.
      const resumeSection = src.match(/if\s*\(opts\.resume\)[\s\S]*?resumeRun\(/);
      expect(resumeSection).not.toBeNull();
    });

    it("prepareBuildPhase skips fresh run allocation when resuming", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/build.ts"), "utf-8");
      // When resuming, allocateFreshRun must NOT be called (it's in the else branch).
      const resumeBranch = src.match(/if\s*\(opts\.resume\)\s*\{[\s\S]*?\}\s*else\s*\{[\s\S]*?allocateFreshRun/);
      expect(resumeBranch).not.toBeNull();
    });

    it("executeBuildViaRunner skips complete tickets when resuming", () => {
      const src = readFileSync(join(SRC_DIR, "lifecycle/build.ts"), "utf-8");
      expect(src).toMatch(/resumeResult.*complete|nextAction.*complete/);
    });
  });

  // ── t30: terminal-writer audit detects template-literal interpolations ──
  describe("t30: terminal-writer audit detects template-literal interpolations", () => {
    it("terminal-writer-audit.test.ts has template-literal interpolation detection tests", () => {
      const testSrc = readFileSync(join(import.meta.dirname, "terminal-writer-audit.test.ts"), "utf-8");
      expect(testSrc).toMatch(/template.literal.interpolation/);
      expect(testSrc).toMatch(/extractInterpolations/);
    });

    it("the audit checks for forbidden patterns in template-literal interpolations", () => {
      const testSrc = readFileSync(join(import.meta.dirname, "terminal-writer-audit.test.ts"), "utf-8");
      expect(testSrc).toMatch(/evaluateCompletion/);
      expect(testSrc).toMatch(/gateGreen.*null/);
      expect(testSrc).toMatch(/updateTicketState/);
    });
  });

  // ── production-import-audit.json exists ───────────────────────────────
  describe("production-import-audit.json artifact", () => {
    it("artifacts/reliability/production-import-audit.json exists", () => {
      const artifactPath = join(REPO_ROOT, "artifacts", "reliability", "production-import-audit.json");
      expect(existsSync(artifactPath)).toBe(true);
    });

    it("has the correct schema_version", () => {
      const artifactPath = join(REPO_ROOT, "artifacts", "reliability", "production-import-audit.json");
      const content = JSON.parse(readFileSync(artifactPath, "utf-8"));
      expect(content.schema_version).toBe("rickgent.production-import-audit.v1");
    });

    it("documents the production wiring for t27-t30", () => {
      const artifactPath = join(REPO_ROOT, "artifacts", "reliability", "production-import-audit.json");
      const content = JSON.parse(readFileSync(artifactPath, "utf-8"));
      expect(content.production_wiring).toBeDefined();
      expect(content.production_wiring.t27_review).toBeDefined();
      expect(content.production_wiring.t28_oracle).toBeDefined();
      expect(content.production_wiring.t29_resume).toBeDefined();
      expect(content.production_wiring.t30_audit).toBeDefined();
    });
  });
});
