import { describe, it, expect } from "vitest";
import { checkScope, type ScopeInput } from "../../src/core/scope.js";

describe("scope fence", () => {
  const baseInput: ScopeInput = {
    declaredPaths: ["src/auth/"],
    targetPath: "",
    isWrite: true,
  };

  it("allows writes inside declared paths", () => {
    expect(checkScope({ ...baseInput, targetPath: "src/auth/login.py" })).toEqual({ result: "ALLOW" });
  });

  it("denies writes outside declared paths", () => {
    const result = checkScope({ ...baseInput, targetPath: "src/billing/invoice.py" });
    expect(result.result).toBe("DENY");
  });

  it("denies path traversal attempts", () => {
    const result = checkScope({ ...baseInput, targetPath: "src/auth/../billing/invoice.py" });
    expect(result.result).toBe("DENY");
  });

  it("allows non-write operations", () => {
    expect(checkScope({ ...baseInput, isWrite: false, targetPath: "src/billing/invoice.py" })).toEqual({ result: "ALLOW" });
  });

  it("denies unresolvable targets", () => {
    const result = checkScope({ ...baseInput, targetPath: "" });
    expect(result.result).toBe("DENY");
  });

  it("denies absolute path escapes", () => {
    const result = checkScope({ ...baseInput, targetPath: "/etc/passwd" });
    expect(result.result).toBe("DENY");
  });
});
