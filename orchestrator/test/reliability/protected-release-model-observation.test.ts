import { describe, expect, it } from "vitest";
import { receiptModelObservation } from "../../scripts/run-protected-release.mjs";

describe("protected release receipt model observation", () => {
  it("projects internal provider evidence onto the closed receipt schema", () => {
    const observation = receiptModelObservation({
      adapter: "claude-code",
      bundle_sha256: "a".repeat(64),
      conversation_id: "conversation",
      dispatch_id: "dispatch",
      evidence_id: "run:1:model:review",
      identity_sha256: "b".repeat(64),
      invoked_model: "claude-opus-4-8[1m]",
      observed_model: "claude-opus-4-8[1m]",
      process_id: 123,
      requested_model: "claude-opus-4-8[1m]",
      review: {
        bundle_sha256: "a".repeat(64),
        findings: [],
        reviewed_commit_oid: "c".repeat(40),
        verdict: "accept",
      },
      role: "review",
    });

    expect(observation).toEqual({
      adapter: "claude-code",
      bundle_sha256: "a".repeat(64),
      conversation_id: "conversation",
      dispatch_id: "dispatch",
      evidence_id: "run:1:model:review",
      invoked_model: "claude-opus-4-8[1m]",
      observed_model: "claude-opus-4-8[1m]",
      process_id: 123,
      requested_model: "claude-opus-4-8[1m]",
      role: "review",
    });
    expect(observation).not.toHaveProperty("identity_sha256");
    expect(observation).not.toHaveProperty("review");
  });
});
