import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  validateBoundPath,
  validateEvidenceCommitOrder,
  validateEvidenceContent,
} from "../../scripts/validate-mission-completion.mjs";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

describe("mission completion evidence authority", () => {
  it("rejects malformed and semantically empty evidence by type", () => {
    expect(() => validateEvidenceContent("artifact.json", Buffer.from("{"))).toThrow(
      /malformed JSON/,
    );
    expect(() => validateEvidenceContent("artifact.json", Buffer.from("{}"))).toThrow(
      /no semantic content/,
    );
    expect(() => validateEvidenceContent("report.md", Buffer.from("plain prose"))).toThrow(
      /authority heading/,
    );
    expect(() => validateEvidenceContent("source.ts", Buffer.from("   "))).toThrow(
      /no semantic content/,
    );
    expect(() => validateEvidenceContent(
      "artifact.json",
      Buffer.from(JSON.stringify({ status: "pass" })),
    )).not.toThrow();
  });

  it("rejects missing, postdated, and unbound committed evidence", () => {
    const head = git("rev-parse", "HEAD");
    const parent = git("rev-parse", "HEAD^");
    expect(() => validateEvidenceCommitOrder(parent, head, "ticket")).not.toThrow();
    expect(() => validateEvidenceCommitOrder(head, parent, "ticket")).toThrow(
      /predates completion/,
    );
    expect(() => validateEvidenceCommitOrder(parent, "f".repeat(40), "ticket")).toThrow(
      /git rev-list/,
    );
    expect(() => validateBoundPath(
      "artifacts/reliability/definitely-missing.json",
      head,
      { id: "t99" },
      "output_artifacts",
    )).toThrow(/committed evidence is missing/);
  });
});
