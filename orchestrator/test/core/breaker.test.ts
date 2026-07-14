import { describe, it, expect } from "vitest";
import { createBreakerState, recordIterationResult, canExecute, extractErrorSignature } from "../../src/core/breaker.js";

describe("circuit breaker", () => {
  it("starts closed and can execute", () => {
    const state = createBreakerState(3);
    expect(canExecute(state)).toBe(true);
  });

  it("trips after threshold identical errors", () => {
    const state = createBreakerState(3);
    for (let i = 0; i < 3; i++) {
      recordIterationResult(state, { error: "ETIMEDOUT at line 42", gitTreeChanged: false, workerClaimedFilesChanged: null });
    }
    expect(canExecute(state)).toBe(false);
  });

  it("resets on git tree progress", () => {
    const state = createBreakerState(3);
    recordIterationResult(state, { error: "ETIMEDOUT", gitTreeChanged: false, workerClaimedFilesChanged: null });
    recordIterationResult(state, { error: "ETIMEDOUT", gitTreeChanged: false, workerClaimedFilesChanged: null });
    recordIterationResult(state, { error: null, gitTreeChanged: true, workerClaimedFilesChanged: null });
    expect(canExecute(state)).toBe(true);
    expect(state.open).toBe(false);
    expect(Object.keys(state.errorCounts)).toHaveLength(0);
  });

  it("rejects claimed progress without tree change", () => {
    const state = createBreakerState(3);
    recordIterationResult(state, { error: "ETIMEDOUT", gitTreeChanged: false, workerClaimedFilesChanged: null });
    recordIterationResult(state, { error: "ETIMEDOUT", gitTreeChanged: false, workerClaimedFilesChanged: 2 });
    // Still counting errors — claimed progress without tree change doesn't reset
    const sig = extractErrorSignature("ETIMEDOUT");
    expect(state.errorCounts[sig]).toBe(2);
  });

  it("normalizes error signatures for counting", () => {
    const sig1 = extractErrorSignature("Error at line 42: timeout");
    const sig2 = extractErrorSignature("Error at line 99: timeout");
    expect(sig1).toBe(sig2);
  });
});
