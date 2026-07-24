import { describe, expect, it } from "vitest";
import { requirePersistentLifecycleObservation } from "../../scripts/run-protected-release.mjs";

const crashBundle = "a".repeat(64);
const resumeBundle = "b".repeat(64);
const expected = {
  crash_provider_bundle_sha256: crashBundle,
  persistent_state_id: "state-protected-1",
  resume_provider_bundle_sha256: resumeBundle,
  run_id: "protected-1",
};

function observation() {
  return {
    checkpoint: {
      attempt_id: "protected-1:crash",
      persistent_state_id: "state-protected-1",
      provider_bundle_sha256: crashBundle,
      run_id: "protected-1",
    },
    attempts: [
      {
        attempt_id: "protected-1:crash",
        payload_sha256: crashBundle,
        persistent_state_id: "state-protected-1",
        phase: "crash",
        run_id: "protected-1",
      },
      {
        attempt_id: "protected-1:resume",
        payload_sha256: resumeBundle,
        persistent_state_id: "state-protected-1",
        phase: "resume",
        run_id: "protected-1",
      },
    ],
  };
}

describe("protected release persistent lifecycle evidence", () => {
  it("requires the exact crash checkpoint and ordered persisted attempts", () => {
    expect(() => requirePersistentLifecycleObservation(observation(), expected)).not.toThrow();

    const missingCrash = observation();
    missingCrash.attempts.shift();
    expect(() => requirePersistentLifecycleObservation(missingCrash, expected)).toThrow(
      "persistent crash/resume lifecycle was not independently read back",
    );

    const mismatchedState = observation();
    mismatchedState.attempts[1]!.persistent_state_id = "state-parent-asserted-only";
    expect(() => requirePersistentLifecycleObservation(mismatchedState, expected)).toThrow(
      "persistent crash/resume lifecycle was not independently read back",
    );

    const forgedCheckpoint = observation();
    forgedCheckpoint.checkpoint.provider_bundle_sha256 = resumeBundle;
    expect(() => requirePersistentLifecycleObservation(forgedCheckpoint, expected)).toThrow(
      "persistent crash/resume lifecycle was not independently read back",
    );
  });
});
