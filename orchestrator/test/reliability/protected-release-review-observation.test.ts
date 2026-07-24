import { describe, expect, it } from "vitest";
import {
  parseReviewDisposition,
  requireReviewedDelivery,
  requireIndependentReviewObservation,
} from "../../scripts/run-protected-release.mjs";

const candidateOid = "a".repeat(40);
const bundleSha256 = "b".repeat(64);

describe("protected release independent review observation", () => {
  it("requires the hosted branch and pull request to expose the reviewed commit", () => {
    const candidateOid = "a".repeat(40);
    expect(() => requireReviewedDelivery(
      candidateOid,
      { object: { sha: candidateOid } },
      { head: { sha: candidateOid } },
    )).not.toThrow();

    for (const [branchOid, pullOid] of [
      ["b".repeat(40), candidateOid],
      [candidateOid, "b".repeat(40)],
    ]) {
      expect(() => requireReviewedDelivery(
        candidateOid,
        { object: { sha: branchOid } },
        { head: { sha: pullOid } },
      )).toThrow(/hosted delivery/);
    }
  });

  it("parses only an exact disposition bound to the candidate", () => {
    expect(parseReviewDisposition(JSON.stringify({
      findings: [],
      reviewed_commit_oid: candidateOid,
      verdict: "accept",
    }), candidateOid)).toEqual({
      findings: [],
      reviewed_commit_oid: candidateOid,
      verdict: "accept",
    });
  });

  it.each([
    ["prose around JSON", `clean\n${JSON.stringify({
      findings: [],
      reviewed_commit_oid: candidateOid,
      verdict: "accept",
    })}`],
    ["another commit", JSON.stringify({
      findings: [],
      reviewed_commit_oid: "c".repeat(40),
      verdict: "accept",
    })],
    ["accepted findings", JSON.stringify({
      findings: ["not actually clean"],
      reviewed_commit_oid: candidateOid,
      verdict: "accept",
    })],
    ["empty rejection", JSON.stringify({
      findings: [],
      reviewed_commit_oid: candidateOid,
      verdict: "reject",
    })],
    ["extra fields", JSON.stringify({
      findings: [],
      reviewed_commit_oid: candidateOid,
      summary: "clean",
      verdict: "accept",
    })],
  ])("rejects %s", (_label, reply) => {
    expect(() => parseReviewDisposition(reply, candidateOid)).toThrow();
  });

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
