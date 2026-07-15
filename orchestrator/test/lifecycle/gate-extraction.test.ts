import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { runConformanceGate, type ConformanceResult } from "../../src/lifecycle/citadel.js";
import { FIXTURE_CAPABILITY_GATE } from "../helpers/capabilities.js";
import { runDeslopGate, type DeslopResult } from "../../src/lifecycle/szechuan.js";
import type { AcceptanceCriterion } from "../../src/core/prd.js";
import type { TicketPlan } from "../../src/lifecycle/prd-parse.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_TS = join(HERE, "..", "..", "src", "lifecycle", "build.ts");

// Foundation extraction (VAL-M0-001..006): runConformanceGate lives in citadel.ts
// and runDeslopGate lives in szechuan.ts; build.ts imports both. These tests pin
// the behavioral identity of the extracted gates against fixed fixtures so a
// future edit that drifts from the pre-extraction baseline fails loudly.

describe("Foundation extraction — build.ts imports the extracted gates (VAL-M0-001..003)", () => {
  const src = readFileSync(BUILD_TS, "utf-8");

  it("build.ts imports runConformanceGate from ./citadel and does not redefine it", () => {
    expect(src).toMatch(/import\s*\{\s*runConformanceGate\s*\}\s*from\s*["']\.\/citadel\.js["']/);
    expect(src).not.toMatch(/function\s+runConformanceGate\s*\(/);
  });

  it("build.ts imports runDeslopGate from ./szechuan and does not redefine it", () => {
    expect(src).toMatch(/import\s*\{\s*runDeslopGate\s*\}\s*from\s*["']\.\/szechuan\.js["']/);
    expect(src).not.toMatch(/function\s+runDeslopGate\s*\(/);
  });

  it("does not carry orphaned gate internals (interfaces / patterns) in build.ts", () => {
    expect(src).not.toMatch(/interface\s+ConformanceResult/);
    expect(src).not.toMatch(/interface\s+DeslopResult/);
    expect(src).not.toMatch(/DESLOP_PATTERNS/);
  });
});

describe("runConformanceGate parity (VAL-M0-005)", () => {
  it("produces the pre-extraction finding set for a fixed AC fixture", () => {
    const acceptanceCriteria: AcceptanceCriterion[] = [
      { description: "passing", type: "test", verifyCommand: "true", scope: [] },
      { description: "backtick-wrapped passing", type: "test", verifyCommand: "`true`", scope: [] },
      { description: "failing", type: "test", verifyCommand: "false", scope: [] },
      { description: "empty", type: "test", verifyCommand: "", scope: [] },
    ];

    const result: ConformanceResult = runConformanceGate(
      acceptanceCriteria,
      process.cwd(),
      process.env,
      FIXTURE_CAPABILITY_GATE,
    );

    expect(result.total).toBe(4);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.results.map((r) => ({ acId: r.acId, pass: r.pass }))).toEqual([
      { acId: "AC-1", pass: true },
      { acId: "AC-2", pass: true },
      { acId: "AC-3", pass: false },
      { acId: "AC-4", pass: true },
    ]);
    expect(result.results[3]!.detail).toBe("no verify command");
  });
});

describe("runDeslopGate parity (VAL-M0-005)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rickgent-deslop-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "slop.ts"), "// TODO fix this\nconsole.log('x');\n");
    writeFileSync(join(dir, "src", "clean.ts"), "export const answer = 42;\n");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces the pre-extraction violation set for a fixed file fixture", () => {
    const tickets: TicketPlan[] = [
      {
        id: "t1",
        title: "t1",
        description: "",
        declaredPaths: ["src/slop.ts", "src/clean.ts", "src/missing.ts"],
        acceptanceCriteria: [],
      },
    ];

    const result: DeslopResult = runDeslopGate(dir, tickets, process.env);

    expect(result.filesChecked).toBe(2);
    expect(result.findings).toBe(2);
    expect(result.details).toEqual([
      'src/slop.ts: slop pattern "TODO"',
      'src/slop.ts: slop pattern "console.log"',
    ]);
  });
});
