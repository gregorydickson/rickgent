import { describe, expect, it } from "vitest";
import { requireIndependentReviewObservation } from "../../scripts/run-protected-release.mjs";

const candidateOid = "a".repeat(40);
const bundleSha256 = "b".repeat(64);

describe("protected release independent review observation", () => {
  it("rejects an authenticated identity probe with no candidate disposition", () => {
    expect(() => requireIndependentReviewObservation({
      bundle_sha256: bundleSha256,
      role: "review",
    }, candidateOid)).toThrow(
      "independent review did not accept the immutable candidate",
    );
  });

  it("accepts only a clean disposition bound to the candidate and transcript", () => {
    const review = {
      bundle_sha256: bundleSha256,
      findings: [],
      reviewed_commit_oid: candidateOid,
      verdict: "accept",
    };
    expect(requireIndependentReviewObservation({
      bundle_sha256: bundleSha256,
      review,
      role: "review",
    }, candidateOid)).toEqual(review);
  });

  it.each([
    ["another commit", { reviewed_commit_oid: "c".repeat(40) }],
    ["a rejection", { verdict: "reject" }],
    ["findings", { findings: ["candidate is not clean"] }],
    ["another transcript", { bundle_sha256: "d".repeat(64) }],
  ])("rejects %s", (_label, override) => {
    expect(() => requireIndependentReviewObservation({
      bundle_sha256: bundleSha256,
      review: {
        bundle_sha256: bundleSha256,
        findings: [],
        reviewed_commit_oid: candidateOid,
        verdict: "accept",
        ...override,
      },
      role: "review",
    }, candidateOid)).toThrow(
      "independent review did not accept the immutable candidate",
    );
  });
});
