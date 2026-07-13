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

  it("coerces a non-array ownedPaths to an empty array (VAL-BUG-008)", () => {
    const result = decideSalvage({ ...baseInput, ownedPaths: "notarray" } as unknown as SalvageInput);
    expect(result.disposition).toBe("committed-done");
    expect(Array.isArray(result.stagedPaths)).toBe(true);
    expect(result.stagedPaths).toHaveLength(0);
  });

  it("filters ownedPaths to string entries only (VAL-BUG-009)", () => {
    const result = decideSalvage({
      ...baseInput,
      ownedPaths: ["a", 5, null, "b"],
    } as unknown as SalvageInput);
    expect(result.stagedPaths).toEqual(["a", "b"]);
  });

  it("compares boolean fields with strict equality (VAL-BUG-010)", () => {
    const truthy = decideSalvage({
      ...baseInput,
      gatePassed: false,
      treeChanged: "yes",
    } as unknown as SalvageInput);
    const falsy = decideSalvage({ ...baseInput, gatePassed: false, treeChanged: false });
    expect(truthy.disposition).toBe(falsy.disposition);
    expect(truthy.disposition).not.toBe("archived-todo");
  });
});
