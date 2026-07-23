import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchProductionReview } from "../../src/protected-release/production-review.js";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function fixture(): { root: string; executable: string; bundle: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "rickgent-production-review-"));
  roots.add(root);
  const executable = join(root, "omnigent-fixture.mjs");
  const bundle = join(root, "reviewer");
  const dataDir = join(root, "data");
  mkdirSync(bundle);
  writeFileSync(join(bundle, "config.yaml"), "name: reviewer\n", "utf8");
  writeFileSync(executable, `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const root = process.env.OMNIGENT_DATA_DIR;
mkdirSync(root, { recursive: true });
const db = new DatabaseSync(join(root, "chat.db"));
db.exec(\`
  CREATE TABLE conversations (
    workspace_id INTEGER NOT NULL DEFAULT 0,
    id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    parent_conversation_id TEXT,
    root_conversation_id TEXT,
    agent_id TEXT,
    model_override TEXT,
    harness_override TEXT,
    provider_vendor TEXT,
    session_usage TEXT,
    PRIMARY KEY (workspace_id, id)
  );
\`);
const id = "review-conversation";
const model = flag("--model");
db.prepare("INSERT INTO conversations (workspace_id,id,created_at,parent_conversation_id,root_conversation_id,model_override,harness_override,provider_vendor,session_usage) VALUES (0,?,?,NULL,?,?,?,?,?)")
  .run(id, Date.now(), id, model, flag("--harness"), "anthropic", JSON.stringify({ by_model: { [model]: {} } }));
db.close();
process.stdout.write("read-only review complete\\n");
`, "utf8");
  chmodSync(executable, 0o755);
  return { root, executable, bundle, dataDir };
}

describe("production reviewer dispatch", () => {
  it("executes a separate Claude/Omnigent process and observes identity from its chat database", () => {
    const value = fixture();
    const result = dispatchProductionReview({
      omnigentExecutable: value.executable,
      dataDir: value.dataDir,
      reviewerBundle: value.bundle,
      prompt: "Review immutable evidence.",
      harness: "claude-sdk",
      model: "claude-opus-4-8[1m]",
      vendor: "anthropic",
      dispatchId: "review-dispatch",
      contextDigest: `sha256:${"a".repeat(64)}`,
      timeoutMs: 10_000,
    });

    expect(result.invoked.canonical_harness).toBe("claude-sdk");
    expect(result.observed.canonical_model).toBe("claude-opus-4-8[1m]");
    expect(result.observed.canonical_vendor).toBe("anthropic");
    expect(result.observed.conversation_id).toBe("review-conversation");
    expect(result.stdoutSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a non-Claude or non-Anthropic reviewer before spawning", () => {
    const value = fixture();
    expect(() => dispatchProductionReview({
      omnigentExecutable: value.executable,
      dataDir: value.dataDir,
      reviewerBundle: value.bundle,
      prompt: "Review immutable evidence.",
      harness: "codex",
      model: "gpt-5.6-sol",
      vendor: "openai",
      dispatchId: "review-dispatch",
      contextDigest: `sha256:${"b".repeat(64)}`,
      timeoutMs: 10_000,
    })).toThrow("RICKGENT_PRODUCTION_REVIEW_REQUIRES_CLAUDE");
  });
});
