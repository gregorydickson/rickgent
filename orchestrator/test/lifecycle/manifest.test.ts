/**
 * C2 / VAL-COV-001..003 — Coverage manifest is GENERATED, not asserted.
 *
 * The manifest is generated from discovered executable test ids (not hardcoded
 * booleans). Every referenced file and test case is verified to exist. A
 * mutation check confirms removing any incident-class guard fails the suite.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { join } from "path";
import {
  generateManifest,
  INCIDENT_CLASSES,
} from "../../scripts/coverage-manifest.cjs";

interface MutationResult {
  guardFound: boolean;
  testFailed: boolean;
  sourceFile?: string;
  sourceUnchanged?: boolean;
  error?: string | null;
}

function runMutationCheckIsolated(id: string): Promise<MutationResult> {
  const script = join(import.meta.dirname, "../../scripts/coverage-manifest.cjs");
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, "mutate", id], {
      cwd: join(import.meta.dirname, "../.."),
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 90_000,
    }, (error, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout) as MutationResult);
      } catch (parseError) {
        reject(new Error(
          `mutation subprocess ${id} produced invalid JSON: ${error?.message ?? stderr ?? String(parseError)}`,
        ));
      }
    });
  });
}

describe("VAL-COV-001 — coverage manifest is GENERATED from discovered test ids", () => {
  const manifest = generateManifest();

  it("manifest is marked as generated (not hardcoded)", () => {
    expect(manifest.generated).toBe(true);
    expect(manifest.version).toBe("2.0");
  });

  it("every incident class has a discovered test file, test case, and guard", () => {
    for (const cls of manifest.incidentClasses) {
      expect(cls.fileExists, `${cls.id}: test file ${cls.test} must exist`).toBe(true);
      expect(cls.testCaseExists, `${cls.id}: test case "${cls.testCase}" must be discovered in ${cls.test}`).toBe(true);
      expect(cls.guardExists, `${cls.id}: guard marker must exist in ${cls.source}`).toBe(true);
      expect(cls.covered, `${cls.id}: must be covered (file + test case + guard all verified)`).toBe(true);
    }
  });

  it("manifest does not use hardcoded booleans — coverage is derived from discovery", () => {
    // The manifest's `covered` field is computed from fileExists + testCaseExists + guardExists,
    // not a hardcoded boolean. Verify the relationship holds for every entry.
    for (const cls of manifest.incidentClasses) {
      const expectedCovered = cls.fileExists && cls.testCaseExists && cls.guardExists;
      expect(cls.covered).toBe(expectedCovered);
    }
  });
});

describe("VAL-COV-002 — every referenced file and test case is verified to exist", () => {
  const manifest = generateManifest();

  it("every referenced test file exists on disk", () => {
    for (const cls of manifest.incidentClasses) {
      expect(cls.fileExists, `test file ${cls.test} for ${cls.id} does not exist`).toBe(true);
    }
  });

  it("every referenced test case is discoverable in its test file", () => {
    for (const cls of manifest.incidentClasses) {
      expect(cls.testCaseExists, `test case "${cls.testCase}" not found in ${cls.test}`).toBe(true);
    }
  });

  it("every referenced fixture file exists on disk", () => {
    for (const fixture of manifest.requiredFixtures) {
      expect(fixture.exists, `fixture ${fixture.file} does not exist`).toBe(true);
    }
  });
});

describe("VAL-COV-003 — mutation check: removing any incident-class guard fails the suite", () => {
  // Each incident class has a guard in the source code. We apply a minimal
  // mutation that breaks the guard, run the test, and confirm the test FAILS.
  // If the test passes with the mutation, the guard is not genuinely tested.
  //
  // This is the "silence is not success" invariant applied to the test suite
  // itself: a test that would pass with the guard removed is not a valid test.

  // Use a longer timeout since each mutation check runs a subprocess.
  for (const cls of INCIDENT_CLASSES) {
    it(`mutation: removing ${cls.id} guard fails the test suite`, { timeout: 90000 }, async () => {
      const result = await runMutationCheckIsolated(cls.id);

      // The guard must be found in the source
      expect(result.guardFound, `${cls.id}: guard marker not found in ${cls.sourceFile}`).toBe(true);

      // The mutation must cause the test to FAIL (non-zero exit)
      expect(result.testFailed, `${cls.id}: test passed with mutation applied — guard is not tested. ${result.error || ""}`).toBe(true);
      expect(result.sourceUnchanged, `${cls.id}: mutation tooling changed production source`).toBe(true);
    });
  }
});
