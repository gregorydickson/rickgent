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

function compareVerdict(actual: any, expected: any): boolean {
  if (expected.error) {
    return actual.error === true || actual.verdict === "UNVERIFIED" || actual.result === "DENY";
  }
  if (expected.verdict) {
    return actual.verdict === expected.verdict;
  }
  if (expected.disposition) {
    return actual.disposition === expected.disposition;
  }
  if (expected.result) {
    return actual.result === expected.result;
  }
  if (expected.valid !== undefined) {
    return actual.valid === expected.valid;
  }
  if (expected.passed !== undefined) {
    return actual.passed === expected.passed;
  }
  if (expected.canExecute !== undefined) {
    return actual.canExecute === expected.canExecute;
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
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
    // Skip breaker fixtures for CLI (no breaker CLI check yet)
    const fixture = loadFixture(file);
    if (fixture.check === "breaker") continue;
    it(`${fixture.id}: ${file}`, () => {
      const result = runCliSubprocess(fixture);
      expect(compareVerdict(result, fixture.expected)).toBe(true);
    });
  }
});
