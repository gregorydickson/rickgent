import { describe, it, expect } from "vitest";
import { decideSalvage, type SalvageInput } from "../../src/core/salvage.js";

describe("salvage disposition", () => {
  const baseInput: SalvageInput = {
    gatePassed: true,
    treeChanged: true,
    orphanReset: false,
    ffReattachPossible: false,
    ownedPaths: ["src/feature.py"],
  };

  it("returns committed-done when gate green and tree changed", () => {
    const result = decideSalvage(baseInput);
    expect(result.disposition).toBe("committed-done");
  });

  it("returns archived-todo when gate failing but tree changed", () => {
    const result = decideSalvage({ ...baseInput, gatePassed: false });
    expect(result.disposition).toBe("archived-todo");
  });

  it("returns ff-reattached when orphan reset detected and reattach possible", () => {
    const result = decideSalvage({ ...baseInput, orphanReset: true, ffReattachPossible: true });
    expect(result.disposition).toBe("ff-reattached");
  });

  it("returns no-op when no tree changes", () => {
    const result = decideSalvage({ ...baseInput, treeChanged: false });
    expect(result.disposition).toBe("no-op");
  });
});
