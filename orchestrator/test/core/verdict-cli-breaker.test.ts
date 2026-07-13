import { describe, it, expect, vi } from "vitest";
import { Readable } from "stream";
import { runVerdict } from "../../src/core/verdict-cli.js";

async function runBreakerCli(input: unknown): Promise<any> {
  const inputText = JSON.stringify(input);
  const originalStdin = process.stdin;
  const mockStdin = Readable.from([Buffer.from(inputText, "utf-8")]);
  Object.defineProperty(process, "stdin", { value: mockStdin, configurable: true });
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg));
  });
  try {
    await runVerdict(["breaker", "--json"]);
  } finally {
    spy.mockRestore();
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
  }
  return JSON.parse(logs[logs.length - 1]);
}

describe("verdict-cli breaker errorCount", () => {
  it("reports the maximal signature bucket, not the first-inserted one", async () => {
    // Insertion order: sigA(1), sigB(4), sigC(2). First bucket (sigA=1) is NOT the max.
    const input = {
      threshold: 10,
      iterations: [
        { error: "sigA", gitTreeChanged: false },
        { error: "sigB", gitTreeChanged: false },
        { error: "sigB", gitTreeChanged: false },
        { error: "sigB", gitTreeChanged: false },
        { error: "sigB", gitTreeChanged: false },
        { error: "sigC", gitTreeChanged: false },
        { error: "sigC", gitTreeChanged: false },
      ],
    };

    const out = await runBreakerCli(input);

    expect(out.errorCount).toBe(4);
    expect(out.errorCount).not.toBe(1);
  });

  it("reports the max even when the largest bucket is inserted last", async () => {
    const input = {
      threshold: 10,
      iterations: [
        { error: "first", gitTreeChanged: false },
        { error: "first", gitTreeChanged: false },
        { error: "first", gitTreeChanged: false },
        { error: "last", gitTreeChanged: false },
        { error: "last", gitTreeChanged: false },
        { error: "last", gitTreeChanged: false },
        { error: "last", gitTreeChanged: false },
        { error: "last", gitTreeChanged: false },
      ],
    };

    const out = await runBreakerCli(input);

    expect(out.errorCount).toBe(5);
  });

  it("reports 0 when no errors were recorded", async () => {
    const out = await runBreakerCli({ threshold: 3, iterations: [] });
    expect(out.errorCount).toBe(0);
  });
});
