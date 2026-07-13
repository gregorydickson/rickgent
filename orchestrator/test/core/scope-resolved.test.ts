import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkScope, checkScopeResolved } from "../../src/core/scope.js";

// A-SEC-4: symlink / rename / not-yet-created write-path resolution.
// These drive the REAL filesystem (tmp dir + real symlinks) and observe the
// REAL scope verdict — never a mock.

describe("scope fence — symlink / rename resolution (checkScopeResolved)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rickgent-scope-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // VAL-SEC-037: TS core denies a symlink escaping a declared dir.
  it("denies a write through a symlink escaping the declared dir", () => {
    mkdirSync(join(root, "declared", "sub"), { recursive: true });
    symlinkSync("/", join(root, "declared", "root")); // declared/root -> /
    const verdict = checkScopeResolved({
      root,
      declaredPaths: ["declared"],
      targetPath: "declared/root/etc/passwd",
      isWrite: true,
    });
    expect(verdict.result).toBe("DENY");
  });

  // Guard sensitivity: the purely-lexical checkScope ALLOWs this same escape,
  // so the DENY above is produced by the realpath guard, not by lexical logic.
  it("guard sensitivity: lexical checkScope wrongly ALLOWs the symlink escape", () => {
    const lexical = checkScope({
      declaredPaths: ["declared"],
      targetPath: "declared/root/etc/passwd",
      isWrite: true,
    });
    expect(lexical.result).toBe("ALLOW");
  });

  // Control: a real in-scope file is allowed.
  it("allows a write to a real file inside the declared dir", () => {
    mkdirSync(join(root, "declared", "sub"), { recursive: true });
    writeFileSync(join(root, "declared", "sub", "login.py"), "x");
    const verdict = checkScopeResolved({
      root,
      declaredPaths: ["declared"],
      targetPath: "declared/sub/login.py",
      isWrite: true,
    });
    expect(verdict.result).toBe("ALLOW");
  });

  // VAL-SEC-056(a): not-yet-created path under a symlinked (escaping) parent -> DENY.
  it("denies a not-yet-created target whose nearest existing parent is an escaping symlink", () => {
    mkdirSync(join(root, "declared"), { recursive: true });
    symlinkSync("/", join(root, "declared", "link")); // declared/link -> /
    const verdict = checkScopeResolved({
      root,
      declaredPaths: ["declared"],
      targetPath: "declared/link/newfile",
      isWrite: true,
    });
    expect(verdict.result).toBe("DENY");
  });

  // VAL-SEC-056(b): not-yet-created path under a real in-scope parent -> ALLOW.
  it("allows a not-yet-created target whose nearest existing parent is in-scope", () => {
    mkdirSync(join(root, "declared", "sub"), { recursive: true });
    const verdict = checkScopeResolved({
      root,
      declaredPaths: ["declared"],
      targetPath: "declared/sub/newfile",
      isWrite: true,
    });
    expect(verdict.result).toBe("ALLOW");
  });

  // VAL-SEC-040: rename/link checks BOTH source and destination endpoints.
  it("denies a rename whose source is in-scope but destination escapes via symlink", () => {
    mkdirSync(join(root, "declared", "sub"), { recursive: true });
    writeFileSync(join(root, "declared", "sub", "a.py"), "x");
    symlinkSync("/", join(root, "declared", "root"));
    const verdict = checkScopeResolved({
      root,
      declaredPaths: ["declared"],
      targetPath: "declared/sub/a.py",
      destinationPath: "declared/root/tmp/evil",
      isWrite: true,
    });
    expect(verdict.result).toBe("DENY");
  });

  it("denies a rename whose source escapes via symlink but destination is in-scope", () => {
    mkdirSync(join(root, "declared", "sub"), { recursive: true });
    symlinkSync("/", join(root, "declared", "root"));
    const verdict = checkScopeResolved({
      root,
      declaredPaths: ["declared"],
      targetPath: "declared/root/etc/passwd",
      destinationPath: "declared/sub/b.py",
      isWrite: true,
    });
    expect(verdict.result).toBe("DENY");
  });

  it("allows a rename when both endpoints are in-scope", () => {
    mkdirSync(join(root, "declared", "sub"), { recursive: true });
    writeFileSync(join(root, "declared", "sub", "a.py"), "x");
    const verdict = checkScopeResolved({
      root,
      declaredPaths: ["declared"],
      targetPath: "declared/sub/a.py",
      destinationPath: "declared/sub/b.py",
      isWrite: true,
    });
    expect(verdict.result).toBe("ALLOW");
  });

  // VAL-SEC-041: existing `..`/absolute handling preserved (regression).
  it("denies a `..` traversal escaping the declared dir", () => {
    mkdirSync(join(root, "declared"), { recursive: true });
    mkdirSync(join(root, "outside"), { recursive: true });
    const verdict = checkScopeResolved({
      root,
      declaredPaths: ["declared"],
      targetPath: "declared/../outside/invoice.py",
      isWrite: true,
    });
    expect(verdict.result).toBe("DENY");
  });

  it("denies an absolute-path escape", () => {
    mkdirSync(join(root, "declared"), { recursive: true });
    const verdict = checkScopeResolved({
      root,
      declaredPaths: ["declared"],
      targetPath: "/etc/passwd",
      isWrite: true,
    });
    expect(verdict.result).toBe("DENY");
  });

  // Fail-closed: non-write is allowed; missing root/target DENY.
  it("allows non-write operations", () => {
    expect(
      checkScopeResolved({ root, declaredPaths: ["declared"], targetPath: "anywhere", isWrite: false }).result,
    ).toBe("ALLOW");
  });

  it("denies when the worktree root is missing", () => {
    expect(
      checkScopeResolved({ root: "", declaredPaths: ["declared"], targetPath: "declared/x", isWrite: true }).result,
    ).toBe("DENY");
  });

  it("denies when there is no resolvable target", () => {
    expect(
      checkScopeResolved({ root, declaredPaths: ["declared"], targetPath: "", isWrite: true }).result,
    ).toBe("DENY");
  });
});
