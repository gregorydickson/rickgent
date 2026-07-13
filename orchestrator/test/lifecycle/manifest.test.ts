import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

describe("AC-4 — lifecycle coverage manifest", () => {
  const manifestPath = join(import.meta.dirname, "../../test/lifecycle_coverage_manifest.json");

  it("manifest file exists", () => {
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("every required incident class has a covered test", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    for (const cls of manifest.required_incident_classes) {
      expect(cls.covered).toBe(true);
      expect(cls.test).toBeTruthy();
    }
  });

  it("every required fixture is covered", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    for (const fixture of manifest.required_fixtures) {
      expect(fixture.covered).toBe(true);
      expect(fixture.file).toBeTruthy();
    }
  });
});
