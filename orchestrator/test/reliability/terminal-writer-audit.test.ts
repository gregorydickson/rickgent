// t30 — Terminal-writer and terminal-predicate audit.
//
// VAL-ORC-005: "One lifecycle engine and one terminal predicate."
// After t30, the production codebase must contain exactly one lifecycle
// engine (LifecycleEngine in lifecycle/engine.ts) and exactly one terminal
// completion predicate for the production path (Oracle v2 via
// CompletionService / evaluateAttemptOracle).  The legacy core
// evaluateCompletion is a pure diagnostic function available only to the
// `rickgent verdict` CLI; it must not be called from any production
// terminalization, dispatch, or lifecycle path.
//
// This test suite audits the production source tree (orchestrator/src/) and
// fails closed if a second terminal writer or terminal predicate appears.
// It is a static import/caller audit — it scans source files for forbidden
// patterns, so a future worker who reintroduces a shortcut will see this
// test go red.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";

const SRC_DIR = join(import.meta.dirname, "../../src");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Strip string literals (single/double/backtick) and comments (line + block)
 * from TypeScript source so that regex-based audits only match REAL code,
 * not tokens inside strings, template literals, or comments.
 *
 * This is the same approach used by the AC-5 caller audit in
 * test/core/caller-audit.test.ts.  Source length and character positions are
 * preserved (content replaced with spaces) so match indices remain valid.
 */
function stripForAudit(source: string): string {
  const chars = source.split("");
  stripCodeRange(chars, 0, chars.length);
  return chars.join("");
}

function stripCodeRange(chars: string[], start: number, end: number): void {
  let i = start;
  while (i < end) {
    const ch = chars[i];
    const next = i + 1 < end ? chars[i + 1] : "";

    if (ch === "/" && next === "/") {
      while (i < end && chars[i] !== "\n") { chars[i] = " "; i++; }
      continue;
    }
    if (ch === "/" && next === "*") {
      chars[i] = " "; chars[i + 1] = " "; i += 2;
      while (i < end) {
        if (chars[i] === "*" && i + 1 < end && chars[i + 1] === "/") {
          chars[i] = " "; chars[i + 1] = " "; i += 2;
          break;
        }
        chars[i] = " "; i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      chars[i] = " "; i++;
      while (i < end) {
        if (chars[i] === "\\" && i + 1 < end) { chars[i] = " "; chars[i + 1] = " "; i += 2; continue; }
        if (chars[i] === ch) { chars[i] = " "; i++; break; }
        if (chars[i] === "\n") break;
        chars[i] = " "; i++;
      }
      continue;
    }
    if (ch === "`") {
      chars[i] = " "; i++;
      while (i < end) {
        if (chars[i] === "\\" && i + 1 < end) { chars[i] = " "; chars[i + 1] = " "; i += 2; continue; }
        if (chars[i] === "`") { chars[i] = " "; i++; break; }
        if (chars[i] === "$" && i + 1 < end && chars[i + 1] === "{") {
          chars[i] = " "; chars[i + 1] = " "; i += 2;
          let depth = 1;
          while (i < end && depth > 0) {
            if (chars[i] === "{") depth++;
            if (chars[i] === "}") { depth--; if (depth === 0) { chars[i] = " "; i++; break; } }
            i++;
          }
          continue;
        }
        chars[i] = " "; i++;
      }
      continue;
    }
    i++;
  }
}

function readStripped(file: string): string {
  return stripForAudit(readFileSync(file, "utf-8"));
}

function relPath(file: string): string {
  return relative(SRC_DIR, file).replace(/\\/g, "/");
}

describe("t30 — one terminal predicate audit (VAL-ORC-005)", () => {
  const allFiles = walkTsFiles(SRC_DIR);

  it("the production source tree is non-empty (audit runs against real files)", () => {
    expect(allFiles.length).toBeGreaterThan(0);
  });

  // ── evaluateCompletion is a diagnostic-only pure function ──────────────
  //
  // The core evaluateCompletion (core/completion.ts) is one of the six core
  // algorithms.  After t30 it is available ONLY to the `rickgent verdict`
  // CLI (core/verdict-cli.ts).  No production terminalization, dispatch, or
  // lifecycle path may call it — the Oracle v2 (evaluateAttemptOracle via
  // CompletionService) is the single production completion predicate.

  it("evaluateCompletion is not imported outside core/ and verdict-cli", () => {
    const forbidden = allFiles.filter((f) => {
      const rel = relPath(f);
      // core/completion.ts defines it; core/verdict-cli.ts uses it for the
      // diagnostic CLI.  These are the only two files permitted to reference
      // evaluateCompletion.
      if (rel === "core/completion.ts") return false;
      if (rel === "core/verdict-cli.ts") return false;
      if (rel === "lifecycle/completion-service.ts") return false; // documents the oracle, may reference the name
      const src = readStripped(f);
      return /\bevaluateCompletion\b/.test(src);
    });
    expect(forbidden.map(relPath)).toEqual([]);
  });

  it("evaluateCompletion is not called from any dispatch or lifecycle path", () => {
    const forbidden = allFiles.filter((f) => {
      const rel = relPath(f);
      if (rel === "core/completion.ts") return false;
      if (rel === "core/verdict-cli.ts") return false;
      if (rel === "lifecycle/completion-service.ts") return false;
      const src = readStripped(f);
      // Match a real call site: evaluateCompletion(  — not the definition.
      return /\bevaluateCompletion\s*\(/.test(src);
    });
    expect(forbidden.map(relPath)).toEqual([]);
  });

  it("no production code passes gateGreen: null as a completion input (nullable completion shortcut)", () => {
    const forbidden = allFiles.filter((f) => {
      const rel = relPath(f);
      // core/completion.ts defines the CompletionInput type which has
      // gateGreen: boolean | null — that's the type definition, not a call.
      if (rel === "core/completion.ts") return false;
      const src = readStripped(f);
      // Match gateGreen: null or gateGreen:null as a value assignment in
      // real code (not inside a string literal — already stripped).
      return /gateGreen\s*:\s*null/.test(src);
    });
    expect(forbidden.map(relPath)).toEqual([]);
  });

  it("gatherCompletionEvidence is not exported from dispatch/evidence.ts (removed terminal shortcut)", () => {
    const evidenceFile = join(SRC_DIR, "dispatch/evidence.ts");
    if (!existsSync(evidenceFile)) return; // file removed entirely is fine
    const src = readStripped(evidenceFile);
    expect(src).not.toMatch(/\bgatherCompletionEvidence\b/);
  });

  it("the dispatch.completion caller is not in the evaluateCompletion allowlist (call site removed)", () => {
    const completionSrc = readFileSync(join(SRC_DIR, "core/completion.ts"), "utf-8");
    // The allowlist must not contain "dispatch.completion" — that caller was
    // only used by gatherCompletionEvidence, which is removed.
    expect(completionSrc).not.toContain('"dispatch.completion"');
  });
});

describe("t30 — one lifecycle engine audit (VAL-ORC-005)", () => {
  const allFiles = walkTsFiles(SRC_DIR);

  it("LifecycleEngine is defined exactly once in lifecycle/engine.ts", () => {
    const defining = allFiles.filter((f) => {
      const src = readStripped(f);
      return /class\s+LifecycleEngine\b/.test(src);
    });
    expect(defining.map(relPath)).toEqual(["lifecycle/engine.ts"]);
  });

  it("Registry.updateTicketState terminal writer is removed from production code", () => {
    // The Registry class in lifecycle/registry.ts had an updateTicketState
    // method that could set ticket status to "Done" — a terminal writer that
    // bypasses the LifecycleEngine.  After t30 this method must not exist in
    // production source.
    const forbidden = allFiles.filter((f) => {
      const src = readStripped(f);
      return /\bupdateTicketState\b/.test(src);
    });
    expect(forbidden.map(relPath)).toEqual([]);
  });

  it("no production code sets ticket status to Done outside the LifecycleEngine", () => {
    // Scan for patterns that directly set a ticket/attempt to a terminal
    // "Done" status outside the engine's transition API.
    const allowed = new Set([
      "lifecycle/engine.ts",
      "lifecycle/phase.ts",
      "state/transitions.ts",
      "state/store.ts",
      "lifecycle/registry.ts", // registry may still read/status-track but not terminalize
      "lifecycle/reconcile.ts",
      "lifecycle/recovery.ts",
      "commands/doctor.ts", // doctor reports status, doesn't terminalize
      "state/schema.ts",
      "state/migrations.ts",
    ]);
    const forbidden = allFiles.filter((f) => {
      const rel = relPath(f);
      if (allowed.has(rel)) return false;
      const src = readStripped(f);
      // Match status: "Done" or status='Done' as a value assignment.
      return /status\s*[:=]\s*["'`]Done["'`]/.test(src);
    });
    expect(forbidden.map(relPath)).toEqual([]);
  });
});

describe("t30 — one terminal predicate identity (VAL-ORC-005)", () => {
  it("Oracle v2 evaluateAttemptOracle is defined exactly once in state/oracle.ts", () => {
    const allFiles = walkTsFiles(SRC_DIR);
    const defining = allFiles.filter((f) => {
      const src = readStripped(f);
      return /\bevaluateAttemptOracle\b/.test(src) &&
        /export\s+function\s+evaluateAttemptOracle/.test(src);
    });
    expect(defining.map(relPath)).toEqual(["state/oracle.ts"]);
  });

  it("CompletionService is defined exactly once in lifecycle/completion-service.ts", () => {
    const allFiles = walkTsFiles(SRC_DIR);
    const defining = allFiles.filter((f) => {
      const src = readStripped(f);
      return /class\s+CompletionService\b/.test(src);
    });
    expect(defining.map(relPath)).toEqual(["lifecycle/completion-service.ts"]);
  });
});
