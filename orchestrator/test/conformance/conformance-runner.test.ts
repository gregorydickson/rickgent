import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { evaluateCompletion } from "../../src/core/completion.js";
import { decideSalvage } from "../../src/core/salvage.js";
import { evaluateConvergenceGate } from "../../src/core/convergence.js";
import { checkScope } from "../../src/core/scope.js";
import { evaluatePrd } from "../../src/core/prd.js";
import { createBreakerState, recordIterationResult, canExecute } from "../../src/core/breaker.js";

const fixturesDir = join(import.meta.dirname, "../../../conformance/fixtures");
const fixtureFiles = readdirSync(fixturesDir).filter(f => f.endsWith(".json"));

function loadFixture(file: string) {
  const raw = readFileSync(join(fixturesDir, file), "utf-8");
  return JSON.parse(raw);
}

function runCoreApi(fixture: any): any {
  switch (fixture.check) {
    case "completion":
      return evaluateCompletion(fixture.input);
    case "salvage":
      return decideSalvage(fixture.input);
    case "gate":
      return evaluateConvergenceGate(fixture.input);
    case "scope":
      return checkScope(fixture.input);
    case "prd":
      return evaluatePrd(fixture.input);
    case "breaker": {
      const state = createBreakerState(fixture.input.threshold);
      let lastTransition: any;
      for (const iter of fixture.input.iterations) {
        lastTransition = recordIterationResult(state, {
          error: iter.error ?? null,
          gitTreeChanged: iter.gitTreeChanged ?? false,
          workerClaimedFilesChanged: iter.workerClaimedFilesChanged ?? null,
        });
      }
      return {
        canExecute: canExecute(state),
        transition: lastTransition?.transition,
        reason: lastTransition?.reason,
        errorCount: Object.values(state.errorCounts)[0] ?? 0,
      };
    }
    default:
      throw new Error(`Unknown check: ${fixture.check}`);
  }
}

function runCliSubprocess(fixture: any): any {
  const input = typeof fixture.input === "string" ? fixture.input : JSON.stringify(fixture.input);
  try {
    const result = execSync(`rickgent verdict ${fixture.check} --json`, {
      input,
      encoding: "utf-8",
      timeout: 10000,
    });
    return JSON.parse(result);
  } catch (e: any) {
    // CLI may exit non-zero for malformed inputs — that's fail-closed behavior
    try {
      return JSON.parse(e.stdout);
    } catch {
      return { error: true, code: "CLI_FAILED", message: e.message };
    }
  }
}

// W4: meta-fields that appear in fixture `expected` blocks but are not part
// of the verdict shape produced by the core/CLI. They must be skipped during
// comparison.
const META_FIELDS = new Set(["note", "source", "failClosed"]);

function compareVerdict(actual: any, expected: any): boolean {
  if (expected.error) {
    return actual.error === true || actual.verdict === "UNVERIFIED" || actual.result === "DENY";
  }
  // Check ALL relevant fields present in the expected object, not just the
  // first one found. Previously this returned on the first matching branch,
  // so a fixture could pass on one field while contradicting every other.
  let checks = 0;
  for (const key of Object.keys(expected)) {
    if (META_FIELDS.has(key)) continue;
    checks++;
    const e = expected[key];
    const a = actual[key];
    if (e !== null && typeof e === "object") {
      if (JSON.stringify(a) !== JSON.stringify(e)) return false;
    } else {
      if (a !== e) return false;
    }
  }
  if (checks === 0) {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  return true;
}

describe("conformance fixtures — in-process core API", () => {
  for (const file of fixtureFiles) {
    const fixture = loadFixture(file);
    it(`${fixture.id}: ${file}`, () => {
      const result = runCoreApi(fixture);
      expect(compareVerdict(result, fixture.expected)).toBe(true);
    });
  }
});

describe("conformance fixtures — CLI subprocess path", () => {
  for (const file of fixtureFiles) {
    const fixture = loadFixture(file);
    // Breaker CLI check is now implemented (C2) — no longer skipped.
    it(`${fixture.id}: ${file}`, () => {
      const result = runCliSubprocess(fixture);
      expect(compareVerdict(result, fixture.expected)).toBe(true);
    });
  }
});
