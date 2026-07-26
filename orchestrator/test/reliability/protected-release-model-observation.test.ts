import { describe, expect, it } from "vitest";
import {
  receiptModelObservation,
  requireCodexDispatchObservation,
} from "../../scripts/run-protected-release.mjs";

describe("protected release receipt model observation", () => {
  it("projects internal provider evidence onto the closed receipt schema", () => {
    const observation = receiptModelObservation({
      adapter: "claude-code",
      bundle_sha256: "a".repeat(64),
      canonical_provider: "anthropic",
      conversation_id: "conversation",
      dispatch_id: "dispatch",
      evidence_id: "run:1:model:review",
      identity_sha256: "b".repeat(64),
      invoked_model: "claude-opus-4-8[1m]",
      observed_model: "claude-opus-4-8[1m]",
      observed_canonical_model: "claude-opus-4-8",
      observed_provider: "firstParty",
      process_id: 123,
      provider_process_id: 456,
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
      canonical_provider: "anthropic",
      conversation_id: "conversation",
      dispatch_id: "dispatch",
      evidence_id: "run:1:model:review",
      identity_sha256: "b".repeat(64),
      invoked_model: "claude-opus-4-8[1m]",
      observed_model: "claude-opus-4-8[1m]",
      observed_canonical_model: "claude-opus-4-8",
      observed_provider: "firstParty",
      process_id: 123,
      provider_process_id: 456,
      requested_model: "claude-opus-4-8[1m]",
      role: "review",
    });
    expect(observation.identity_sha256).toBe("b".repeat(64));
    expect(observation).not.toHaveProperty("review");
  });

  it("rejects every broken Codex runtime identity binding", () => {
    const valid = {
      assistant_reply: "reply",
      provider_process_id: 456,
      thread: {
        model: "gpt-5.6-sol",
        model_provider: "openai",
        session_id: "thread-1",
        thread_id: "thread-1",
      },
      turn: { status: "completed", thread_id: "thread-1", turn_id: "turn-1" },
    };
    expect(requireCodexDispatchObservation(valid, "gpt-5.6-sol")).toEqual(valid);
    for (const mutate of [
      (value: any) => { value.thread.model = "other"; },
      (value: any) => { value.thread.model_provider = "other"; },
      (value: any) => { value.thread.session_id = "other"; },
      (value: any) => { value.turn.thread_id = "other"; },
      (value: any) => { value.turn.status = "failed"; },
      (value: any) => { value.assistant_reply = ""; },
      (value: any) => { value.provider_process_id = 0; },
    ]) {
      const value = structuredClone(valid);
      mutate(value);
      expect(() => requireCodexDispatchObservation(value, "gpt-5.6-sol")).toThrow(
        /runtime identity/,
      );
    }
  });
});
