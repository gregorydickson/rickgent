import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Model the live Omnigent identity seam for AttemptRunner integration tests.
 * The caller supplies the already-isolated per-dispatch data directory; the
 * runner subsequently observes this row without reading router labels.
 */
export function writeObservedIdentityFixture(
  dataDir: string,
  input: {
    readonly harness: string;
    readonly model: string;
    readonly vendor: string;
    readonly conversationId: string;
  },
): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, "chat.db"));
  try {
    db.exec(`
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
    `);
    db.prepare(`
      INSERT INTO conversations (
        workspace_id, id, created_at, parent_conversation_id,
        root_conversation_id, agent_id, model_override, harness_override,
        provider_vendor, session_usage
      ) VALUES (0, ?, ?, NULL, ?, NULL, ?, ?, ?, ?)
    `).run(
      input.conversationId,
      Date.now(),
      input.conversationId,
      input.model,
      input.harness,
      input.vendor,
      JSON.stringify({ by_model: { [input.model]: { input_tokens: 1, output_tokens: 1 } } }),
    );
  } finally {
    db.close();
  }
}
