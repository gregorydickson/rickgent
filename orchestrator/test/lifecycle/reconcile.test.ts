import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcile } from "../../src/lifecycle/reconcile.js";

// The contained dispatch fixture replaces this module. Reconciliation must
// remain unavailable even in that fixture runtime.
vi.mock("../../src/capabilities/runtime-gate.js", () => ({
  RUNTIME_CAPABILITY_GATE: Object.freeze({ require(): void {} }),
}));

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

describe("reconcile authority boundary", () => {
  let repo: string;
  let diagnosticDir: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "rickgent-reconcile-unavailable-"));
    diagnosticDir = join(repo, ".rickgent");
    mkdirSync(diagnosticDir, { recursive: true });
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@rickgent.dev"]);
    git(repo, ["config", "user.name", "Rickgent Test"]);
    writeFileSync(join(repo, "work.txt"), "legacy work\n");
    git(repo, ["add", "--", "work.txt"]);
    git(repo, ["commit", "-q", "-m", "ticket: T-FORGED pretend completion"]);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("does not turn matching Git subjects into ticket state", () => {
    expect(() => reconcile(repo, diagnosticDir)).toThrow(
      "RICKGENT_RECONCILIATION_UNAVAILABLE",
    );
    expect(existsSync(join(diagnosticDir, "registry.json"))).toBe(false);
    expect(existsSync(join(repo, ".git", "rickgent", "state.sqlite3"))).toBe(false);
  });

  it("does not read or rewrite legacy dispatch completion claims", () => {
    const ledger = join(diagnosticDir, "dispatch-ledger.jsonl");
    const forged = `${JSON.stringify({
      dispatchId: "forged/T-FORGED/implement/99/worker",
      state: "completed",
      commitSha: git(repo, ["rev-parse", "HEAD"]),
      baselineSha: "",
      declaredPaths: ["work.txt"],
    })}\n{ malformed legacy tail\n`;
    writeFileSync(ledger, forged);

    expect(() => reconcile(repo, diagnosticDir, ledger)).toThrow(
      "RICKGENT_RECONCILIATION_UNAVAILABLE",
    );
    expect(readFileSync(ledger, "utf8")).toBe(forged);
    expect(existsSync(join(diagnosticDir, "registry.json"))).toBe(false);
  });
});
