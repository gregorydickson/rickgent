import { describe, expect, it } from "vitest";
import { isGitHubHttpNotFound } from "../../scripts/run-protected-release.mjs";

describe("protected release hosted absence evidence", () => {
  it("accepts only an explicit GitHub HTTP 404 as resource absence", () => {
    expect(isGitHubHttpNotFound("gh: Not Found (HTTP 404)\n")).toBe(true);

    for (const stderr of [
      "gh: GH_TOKEN was not found in the environment\n",
      "gh: dial tcp: lookup github.com: no such host\n",
      "gh: upstream returned 404 without an HTTP response\n",
      "gh: Internal Server Error (HTTP 500)\n",
    ]) {
      expect(isGitHubHttpNotFound(stderr)).toBe(false);
    }
  });
});
