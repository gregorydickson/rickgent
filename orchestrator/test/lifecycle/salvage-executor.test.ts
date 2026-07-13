import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SalvageExecutor } from "../../src/lifecycle/salvage.js";
import type { SalvageInput } from "../../src/core/salvage.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";

describe("SalvageExecutor staging safety (A-SEC-5)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rickgent-salvage-exec-"));
    execSync("git init", { cwd: tempDir, timeout: 10000 });
    execSync('git config user.email "test@rickgent.dev"', { cwd: tempDir, timeout: 10000 });
    execSync('git config user.name "Test"', { cwd: tempDir, timeout: 10000 });
    execSync("git config commit.gpgsign false", { cwd: tempDir, timeout: 10000 });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function committedDoneInput(ownedPaths: string[]): SalvageInput {
    return {
      gatePassed: true,
      treeChanged: true,
      orphanReset: false,
      ffReattachPossible: false,
      ownedPaths,
    };
  }

  it("VAL-SEC-042: a staged path with $(...) substitution executes NO shell", () => {
    const executor = new SalvageExecutor(tempDir);
    executor.execute(committedDoneInput(["foo$(touch PWNED)"]));
    expect(existsSync(join(tempDir, "PWNED"))).toBe(false);
  });

  it("VAL-SEC-043: a staged path with ;rm/quote-break injection executes NO shell", () => {
    const sentinel = join(tempDir, "sentinel");
    writeFileSync(sentinel, "do-not-delete");
    const executor = new SalvageExecutor(tempDir);
    executor.execute(committedDoneInput(['foo";rm -rf sentinel;"']));
    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(join(tempDir, "PWNED2"))).toBe(false);
  });

  it("VAL-SEC-043b: a quote-break touch injection creates no artifact", () => {
    const executor = new SalvageExecutor(tempDir);
    executor.execute(committedDoneInput(['foo";touch PWNED2;"']));
    expect(existsSync(join(tempDir, "PWNED2"))).toBe(false);
  });

  it("VAL-SEC-046: a leading-dash staged path is treated as a path, not a git option", () => {
    const executor = new SalvageExecutor(tempDir);
    executor.execute(committedDoneInput(["--upload-pack=touch PWNED3"]));
    expect(existsSync(join(tempDir, "PWNED3"))).toBe(false);
  });

  it("stages and commits a genuinely owned path", () => {
    writeFileSync(join(tempDir, "real.txt"), "content");
    const executor = new SalvageExecutor(tempDir);
    const result = executor.execute(committedDoneInput(["real.txt"]));
    expect(result.decision.disposition).toBe("committed-done");
    expect(result.executed).toBe(true);
    expect(result.gitOutput).toMatch(/^[0-9a-f]{7,40}$/);
    const committed = execSync("git show --stat HEAD", { cwd: tempDir, encoding: "utf-8" });
    expect(committed).toContain("real.txt");
  });
});
