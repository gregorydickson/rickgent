import { describe, expect, it } from "vitest";
import {
  parseImplementationArtifact,
  receiptModelObservation,
} from "../../scripts/run-protected-release.mjs";

const runId = "protected-1";

describe("protected release implementation provenance", () => {
  it("accepts only the exact run-bound implementation artifact", () => {
    expect(parseImplementationArtifact(
      JSON.stringify({ content: `${runId}\n`, run_id: runId }),
      runId,
    )).toEqual({ content: `${runId}\n`, run_id: runId });

    for (const reply of [
      "RICKGENT_IMPLEMENTATION_PROBE_OK",
      JSON.stringify({ content: "unbound\n", run_id: runId }),
      JSON.stringify({ content: `${runId}\n`, run_id: "protected-2" }),
      JSON.stringify({ content: `${runId}\n`, extra: true, run_id: runId }),
    ]) {
      expect(() => parseImplementationArtifact(reply, runId)).toThrow(
        /implementation provider/,
      );
    }
  });

  it("keeps the internal artifact outside the closed receipt dispatch schema", () => {
    const provider = {
      adapter: "codex-cli",
      bundle_sha256: "a".repeat(64),
      conversation_id: "conversation",
      dispatch_id: "dispatch",
      evidence_id: "run:1:model:implementation",
      identity_sha256: "b".repeat(64),
      implementation: {
        content: `${runId}\n`,
        content_sha256: "c".repeat(64),
        run_id: runId,
      },
      invoked_model: "gpt-5.6-sol",
      observed_model: "gpt-5.6-sol",
      process_id: 123,
      requested_model: "gpt-5.6-sol",
      role: "implementation",
    };

    expect(receiptModelObservation(provider)).not.toHaveProperty("implementation");
    expect(receiptModelObservation(provider)).not.toHaveProperty("identity_sha256");
  });
});
