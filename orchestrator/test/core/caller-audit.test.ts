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

/**
 * Strip string literals (single/double/backtick, honoring backslash escapes)
 * and comments (line `//` + block `/* *\/`) from TypeScript source, replacing
 * their contents with spaces so that a call-site regex only matches REAL call
 * sites — not the token appearing inside a log string, template literal, or
 * comment.  Source length and character positions are preserved so that match
 * indices in the stripped text correspond to the same positions in the original
 * source (used for argument parsing).
 *
 * Template literal interpolations (`${...}`) are treated as CODE: their
 * expression content is preserved so a real call site inside an interpolation
 * is still detected, while the surrounding template string content is masked.
 */
function stripForAudit(source: string): string {
  const chars = source.split("");
  stripCodeRange(chars, 0, chars.length);
  return chars.join("");
}

/**
 * Strip strings and comments from `chars[start..end)` in-place (replace with
 * spaces, preserving length/positions).  Called recursively for template
 * literal interpolations so their expression content is treated as code.
 */
function stripCodeRange(chars: string[], start: number, end: number): void {
  let i = start;
  while (i < end) {
    const ch = chars[i];
    const next = i + 1 < end ? chars[i + 1] : "";

    // Line comment — mask to end of line (keep newline)
    if (ch === "/" && next === "/") {
      while (i < end && chars[i] !== "\n") { chars[i] = " "; i++; }
      continue;
    }

    // Block comment — mask through closing */
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

    // Single / double quoted string — mask entirely (no interpolation)
    if (ch === "'" || ch === '"') {
      i = stripFlatString(chars, i, end, ch);
      continue;
    }

    // Template literal — mask string parts, keep ${...} as code
    if (ch === "`") {
      chars[i] = " "; i++; // mask opening backtick
      i = stripTemplateBody(chars, i, end);
      continue;
    }

    i++; // keep code character
  }
}

/** Mask a single/double-quoted string starting at `chars[start]` (the quote). */
function stripFlatString(chars: string[], start: number, end: number, quote: string): number {
  chars[start] = " "; // mask opening quote
  let i = start + 1;
  while (i < end) {
    if (chars[i] === "\\" && i + 1 < end) {
      chars[i] = " "; chars[i + 1] = " "; i += 2; // mask escaped char
      continue;
    }
    if (chars[i] === quote) { chars[i] = " "; i++; break; } // closing quote
    if (chars[i] === "\n") break; // unterminated string — bail safely
    chars[i] = " "; i++;
  }
  return i;
}

/**
 * Mask the body of a template literal (after the opening backtick was masked).
 * String content is masked; `${...}` interpolations are treated as code via
 * `stripCodeRange`.  Returns the index past the closing backtick (or `end`).
 */
function stripTemplateBody(chars: string[], start: number, end: number): number {
  let i = start;
  while (i < end) {
    if (chars[i] === "\\" && i + 1 < end) {
      chars[i] = " "; chars[i + 1] = " "; i += 2; // mask escaped char
      continue;
    }
    if (chars[i] === "`") { chars[i] = " "; i++; break; } // closing backtick
    if (chars[i] === "$" && i + 1 < end && chars[i + 1] === "{") {
      chars[i] = " "; chars[i + 1] = " "; i += 2; // mask ${ delimiter
      i = stripInterpolation(chars, i, end);
      continue;
    }
    chars[i] = " "; i++; // mask template string content
  }
  return i;
}

/**
 * Process a template-literal interpolation expression starting just after `${`.
 * Tracks brace depth to find the matching `}`.  The expression content is
 * treated as code (strings/comments inside are stripped, real call sites are
 * preserved).  Masks the closing `}` and returns the index past it.
 */
function stripInterpolation(chars: string[], start: number, end: number): number {
  let i = start;
  let depth = 1;
  while (i < end && depth > 0) {
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
      i = stripFlatString(chars, i, end, ch);
      continue;
    }
    if (ch === "`") {
      chars[i] = " "; i++; // mask opening backtick of nested template
      i = stripTemplateBody(chars, i, end);
      continue;
    }
    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0) { chars[i] = " "; i++; break; }
      i++; // keep — part of the expression
      continue;
    }
    i++; // keep expression character (real code)
  }
  return i;
}

/**
 * Scan a single source string for `evaluateCompletion(...)` call sites.
 *
 * **Robustness:** before running the call-site regex, string literals
 * (single/double/backtick, honoring backslash escapes) and comments (line +
 * block) are stripped from the source so the regex only matches REAL call sites
 * — not the token appearing inside a log string, template literal, or comment.
 * The argument parser still runs against the ORIGINAL source so string-literal
 * caller arguments (e.g. `"cli.verdict"`) are correctly extracted.
 *
 * @param source   Raw TypeScript source text.
 * @param filePath Logical file path for the returned `CallSite.file` label.
 */
function findCallSitesInSource(source: string, filePath = "synthetic.ts"): CallSite[] {
  const stripped = stripForAudit(source);
  const sites: CallSite[] = [];
  const re = /evaluateCompletion\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const before = stripped.slice(Math.max(0, m.index - 12), m.index);
    // Skip the function definition itself (the single completion oracle).
    if (/function\s+$/.test(before)) continue;
    // Parse arguments from the ORIGINAL source so string-literal caller args
    // (e.g. "cli.verdict") are correctly extracted.
    const openIdx = m.index + m[0].length - 1;
    const parsed = parseCallArgs(source, openIdx);
    if (!parsed) continue;
    const callerArg = parsed.args[1] ?? null;
    let callerLiteral: string | null = null;
    if (callerArg) {
      const lit = callerArg.match(/^["'`]([^"'`]+)["'`]$/);
      if (lit) callerLiteral = lit[1];
    }
    sites.push({ file: filePath, argCount: parsed.args.length, callerLiteral });
  }
  return sites;
}

function findCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of walkTsFiles(SRC_DIR)) {
    const source = readFileSync(file, "utf-8");
    sites.push(...findCallSitesInSource(source, file.replace(SRC_DIR, "src")));
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

// ---------------------------------------------------------------------------
// Regex robustness — strip string literals and comments before scanning.
//
// The A-SEC-6 caller audit scans source for `evaluateCompletion(`.  A naive
// regex false-positives when the token appears inside a string literal, template
// literal, or comment.  This makes a security-relevant audit fragile (false
// DENYs) and prone to future accidental bypass.  Before scanning, we strip
// string/template literals and comments so only real call sites are detected.
// The allowlist semantics are unchanged — a real unbranded call site is still
// caught.
// ---------------------------------------------------------------------------

describe("AC-5 — caller audit regex robustness (string/comment stripping)", () => {
  // --- stripForAudit unit tests ---

  it("stripForAudit removes single-quoted string content", () => {
    const src = `const x = 'evaluateCompletion(foo)'; codeHere()`;
    const stripped = stripForAudit(src);
    expect(stripped).not.toContain("evaluateCompletion(foo)");
    expect(stripped).toContain("codeHere()");
  });

  it("stripForAudit removes double-quoted string content", () => {
    const src = `const x = "evaluateCompletion(bar)"; codeHere()`;
    const stripped = stripForAudit(src);
    expect(stripped).not.toContain("evaluateCompletion(bar)");
    expect(stripped).toContain("codeHere()");
  });

  it("stripForAudit removes template literal string content", () => {
    const src = "const x = `evaluateCompletion(baz)`; codeHere()";
    const stripped = stripForAudit(src);
    expect(stripped).not.toContain("evaluateCompletion(baz)");
    expect(stripped).toContain("codeHere()");
  });

  it("stripForAudit honors backslash escapes inside strings", () => {
    // The escaped quote should NOT end the string, so the entire content
    // including the fake call is masked.
    const src = `const x = "evaluateCompletion(\\")"; codeHere()`;
    const stripped = stripForAudit(src);
    expect(stripped).not.toContain("evaluateCompletion(");
    expect(stripped).toContain("codeHere()");
  });

  it("stripForAudit removes line comments", () => {
    const src = `// evaluateCompletion(input, caller)\ncodeHere()`;
    const stripped = stripForAudit(src);
    expect(stripped).not.toContain("evaluateCompletion(input");
    expect(stripped).toContain("codeHere()");
  });

  it("stripForAudit removes block comments", () => {
    const src = `/* evaluateCompletion(input, caller) */ codeHere()`;
    const stripped = stripForAudit(src);
    expect(stripped).not.toContain("evaluateCompletion(input");
    expect(stripped).toContain("codeHere()");
  });

  it("stripForAudit removes block comments spanning multiple lines", () => {
    const src = `/*\n * evaluateCompletion(x, y)\n */ codeHere()`;
    const stripped = stripForAudit(src);
    expect(stripped).not.toContain("evaluateCompletion(x");
    expect(stripped).toContain("codeHere()");
  });

  it("stripForAudit preserves real code outside strings/comments", () => {
    const src = `function foo() { evaluateCompletion(a, "b"); }`;
    const stripped = stripForAudit(src);
    expect(stripped).toContain("evaluateCompletion(a");
  });

  it("stripForAudit preserves template interpolation expressions as code", () => {
    // A real call inside ${...} should be preserved (it's code, not string).
    const src = "const x = `prefix ${evaluateConfirmation(y)} suffix`";
    const stripped = stripForAudit(src);
    // The interpolation expression is code — evaluateConfirmation (not our
    // target, but proves code-in-interpolation is kept) should survive.
    expect(stripped).toContain("evaluateConfirmation(y)");
  });

  // --- findCallSitesInSource integration tests ---

  it("does NOT false-positive on evaluateCompletion( inside a double-quoted string", () => {
    const src = `const msg = "evaluateCompletion(input, caller) is the oracle";\n` +
                `evaluateCompletion(realInput, "cli.verdict");`;
    const sites = findCallSitesInSource(src);
    // Only the real call site (with "cli.verdict" caller) should be found.
    expect(sites).toHaveLength(1);
    expect(sites[0].callerLiteral).toBe("cli.verdict");
  });

  it("does NOT false-positive on evaluateCompletion( inside a single-quoted string", () => {
    const src = `const msg = 'evaluateCompletion(input, "cli.verdict")';\n` +
                `evaluateCompletion(realInput, "cli.verdict");`;
    const sites = findCallSitesInSource(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].callerLiteral).toBe("cli.verdict");
  });

  it("does NOT false-positive on evaluateCompletion( inside a template literal", () => {
    const src = "const msg = `evaluateCompletion(${caller}) called`;\n" +
                `evaluateCompletion(realInput, "cli.verdict");`;
    const sites = findCallSitesInSource(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].callerLiteral).toBe("cli.verdict");
  });

  it("does NOT false-positive on evaluateCompletion( in a line comment", () => {
    const src = `// evaluateCompletion(input, caller) is the oracle\n` +
                `evaluateCompletion(realInput, "cli.verdict");`;
    const sites = findCallSitesInSource(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].callerLiteral).toBe("cli.verdict");
  });

  it("does NOT false-positive on evaluateCompletion( in a block comment", () => {
    const src = `/* evaluateCompletion(input, caller) is the oracle */\n` +
                `evaluateCompletion(realInput, "cli.verdict");`;
    const sites = findCallSitesInSource(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].callerLiteral).toBe("cli.verdict");
  });

  it("does NOT false-positive on evaluateCompletion( in a JSDoc block comment", () => {
    const src = `/**\n * evaluateCompletion(input, caller) — the oracle\n */\n` +
                `evaluateCompletion(realInput, "cli.verdict");`;
    const sites = findCallSitesInSource(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].callerLiteral).toBe("cli.verdict");
  });

  it("the benign reworded log string can contain the oracle name without breaking the audit", () => {
    // Simulates the previously-reworded error/log string that a worker had to
    // change to get the audit to pass.  After the fix, the string can contain
    // evaluateCompletion( without triggering a false positive.
    const src = `throw new Error("evaluateCompletion(input, caller) called by rogue");\n` +
                `evaluateCompletion(realInput, "cli.verdict");`;
    const sites = findCallSitesInSource(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].callerLiteral).toBe("cli.verdict");
  });

  // --- The audit is NOT relaxed — real illicit call sites are still caught ---

  it("STILL detects a real unbranded evaluateCompletion call site (no caller)", () => {
    const src = `// benign comment\n` +
                `evaluateCompletion(input); // real illicit call — no caller`;
    const sites = findCallSitesInSource(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].argCount).toBe(1);
    expect(sites[0].callerLiteral).toBeNull();
  });

  it("STILL detects a real illicit call site alongside benign string occurrences", () => {
    const src = `const log = "evaluateCompletion(input, caller) logs here";\n` +
                `/* evaluateCompletion(x, y) in a comment */\n` +
                `evaluateCompletion(input); // real illicit — no caller arg`;
    const sites = findCallSitesInSource(src);
    // Only the real illicit call (1 arg, no caller) should be detected.
    expect(sites).toHaveLength(1);
    expect(sites[0].argCount).toBe(1);
    expect(sites[0].callerLiteral).toBeNull();
  });

  it("STILL detects a real call site with a rogue (non-allowlisted) caller string", () => {
    const src = `const msg = "evaluateCompletion(x, y) in a string";\n` +
                `evaluateCompletion(input, "rogue-caller");`;
    const sites = findCallSitesInSource(src);
    expect(sites).toHaveLength(1);
    expect(sites[0].callerLiteral).toBe("rogue-caller");
    // The audit detects it; the caller is not in the allowlist.
    expect(ALLOWED_COMPLETION_CALLERS.has("rogue-caller" as any)).toBe(false);
  });
});
