import { describe, expect, it } from "vitest";
import {
  codexProbeReply,
  requireExactProbeReply,
} from "../../scripts/run-protected-release.mjs";

const expected = "RICKGENT_IMPLEMENTATION_PROBE_OK";

function event(value: unknown): string {
  return JSON.stringify(value);
}

describe("protected release provider probe output", () => {
  it("accepts only the assistant message, not a marker echoed elsewhere in Codex JSONL", () => {
    const promptEchoOnly = [
      event({ type: "thread.started", thread_id: "fixture" }),
      event({ type: "user_message", text: `Reply with exactly ${expected}.` }),
      event({ type: "turn.completed", usage: {} }),
    ].join("\n");

    expect(() => codexProbeReply(promptEchoOnly))
      .toThrow("did not return exactly one assistant message");
  });

  it("requires the assistant reply to equal the bound marker", () => {
    const response = [
      event({ type: "thread.started", thread_id: "fixture" }),
      event({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: expected },
      }),
      event({ type: "turn.completed", usage: {} }),
    ].join("\n");

    expect(codexProbeReply(response)).toBe(expected);
    expect(() => requireExactProbeReply(
      `${expected} but not actually exact`,
      expected,
      "implementation",
    )).toThrow("did not return its bound marker");
    expect(() => requireExactProbeReply(expected, expected, "implementation")).not.toThrow();
  });
});
