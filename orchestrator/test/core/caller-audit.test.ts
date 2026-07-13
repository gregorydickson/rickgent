import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { evaluateCompletion, ALLOWED_COMPLETION_CALLERS } from "../../src/core/completion.js";

const SRC_DIR = join(import.meta.dirname, "../../src");

const VALID_INPUT = {
  claimedSha: "abc123",
  baselineSha: "def456",
  shaExists: true,
  treeChanged: true,
  gateGreen: true,
};

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Extract the top-level argument list of a call whose '(' is at openIdx.
// Tracks string literals and bracket depth so nested calls / type assertions
// don't confuse the comma split.
function parseCallArgs(source: string, openIdx: number): { args: string[]; endIdx: number } | null {
  let depth = 0;
  let inStr: string | null = null;
  const args: string[] = [];
  let cur = "";
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    const prev = i > 0 ? source[i - 1] : "";
    if (inStr) {
      cur += ch;
      if (ch === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (depth === 1 && ch === "(") continue;
      cur += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (cur.trim().length) args.push(cur.trim());
        return { args, endIdx: i };
      }
      cur += ch;
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  return null;
}

interface CallSite {
  file: string;
  argCount: number;
  callerLiteral: string | null;
}

function findCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of walkTsFiles(SRC_DIR)) {
    const source = readFileSync(file, "utf-8");
    const re = /evaluateCompletion\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const before = source.slice(Math.max(0, m.index - 12), m.index);
      // Skip the function definition itself (the single completion oracle).
      if (/function\s+$/.test(before)) continue;
      const openIdx = m.index + m[0].length - 1;
      const parsed = parseCallArgs(source, openIdx);
      if (!parsed) continue;
      const callerArg = parsed.args[1] ?? null;
      let callerLiteral: string | null = null;
      if (callerArg) {
        const lit = callerArg.match(/^["'`]([^"'`]+)["'`]$/);
        if (lit) callerLiteral = lit[1];
      }
      sites.push({ file: file.replace(SRC_DIR, "src"), argCount: parsed.args.length, callerLiteral });
    }
  }
  return sites;
}

describe("AC-5 — completion oracle single predicate, pinned callers", () => {
  it("exports exactly one completion evaluation function", async () => {
    const completionModule = await import("../../src/core/completion.js");
    const exports = Object.keys(completionModule);
    const evalFunctions = exports.filter(e => e.startsWith("evaluate") || e.startsWith("check"));
    // evaluateCompletion must be the ONLY exported evaluation function.
    expect(evalFunctions).toEqual(["evaluateCompletion"]);
  });

  it("has an explicit caller allowlist containing the real call site", () => {
    expect(ALLOWED_COMPLETION_CALLERS.size).toBeGreaterThan(0);
    expect(ALLOWED_COMPLETION_CALLERS.has("cli.verdict")).toBe(true);
  });

  it("allowlist does not contain wildcard entries", () => {
    for (const caller of ALLOWED_COMPLETION_CALLERS) {
      expect(caller).not.toContain("*");
      expect(caller.length).toBeGreaterThan(0);
    }
  });

  it("evaluateCompletion is a pure function (same input, same output)", () => {
    const result1 = evaluateCompletion(VALID_INPUT, "cli.verdict");
    const result2 = evaluateCompletion(VALID_INPUT, "cli.verdict");
    expect(result1).toEqual(result2);
  });

  it("does not throw when called by an authorized caller", () => {
    expect(() => evaluateCompletion(VALID_INPUT, "cli.verdict")).not.toThrow();
  });

  it("throws when called by an unauthorized (rogue) caller", () => {
    expect(() => evaluateCompletion(VALID_INPUT, "rogue-caller" as any)).toThrow();
  });

  it("throws for a null caller — no `!= null` short-circuit bypasses the allowlist", () => {
    expect(() => evaluateCompletion(VALID_INPUT, null as any)).toThrow();
  });

  it("throws for an undefined caller — no `!= null` short-circuit bypasses the allowlist", () => {
    expect(() => evaluateCompletion(VALID_INPUT, undefined as any)).toThrow();
  });

  it("signature requires a non-optional branded caller (no `caller?:`)", () => {
    const src = readFileSync(join(SRC_DIR, "core/completion.ts"), "utf-8");
    expect(src).toMatch(
      /export function evaluateCompletion\(\s*input: CompletionInput,\s*caller: CompletionCaller\s*\)/,
    );
    expect(src).not.toMatch(/caller\?:/);
  });
});

describe("AC-5 — import-graph audit over src/", () => {
  it("finds the production completion call site(s)", () => {
    const sites = findCallSites();
    // Silence is not success: an audit that inspects zero call sites proves nothing.
    expect(sites.length).toBeGreaterThan(0);
  });

  it("zero call sites omit the caller argument", () => {
    const callerLess = findCallSites().filter(s => s.argCount < 2);
    expect(callerLess).toEqual([]);
  });

  it("no phantom allowlist entries — every allowlisted id maps to a real call site", () => {
    const used = new Set(findCallSites().map(s => s.callerLiteral).filter((c): c is string => c !== null));
    const phantom = [...ALLOWED_COMPLETION_CALLERS].filter(id => !used.has(id));
    expect(phantom).toEqual([]);
  });

  it("positive routing — the production completion path invokes the oracle with an allowlisted caller", () => {
    const sites = findCallSites();
    for (const s of sites) {
      expect(s.callerLiteral).not.toBeNull();
      expect(ALLOWED_COMPLETION_CALLERS.has(s.callerLiteral as any)).toBe(true);
    }
    const verdictCliSite = sites.find(s => s.file.endsWith("verdict-cli.ts"));
    expect(verdictCliSite, "verdict-cli.ts must route completion through the oracle").toBeDefined();
    expect(verdictCliSite!.callerLiteral).toBe("cli.verdict");
    // Drive the real oracle with that production caller and observe the verdict.
    const verdict = evaluateCompletion(VALID_INPUT, "cli.verdict");
    expect(verdict.verdict).toBe("COMMITTED");
  });
});
