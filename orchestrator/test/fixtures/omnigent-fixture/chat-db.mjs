// Shared minimal chat.db schema for the deterministic fixture omnigent
// (architecture §4). A "DB session" is a `conversations` row; a non-empty
// transcript is `conversation_items` rows for that conversation. This is a
// column-compatible subset of the real omnigent schema (db_models.py) — only
// the columns the B2 evidence observer reads are modeled.

import { DatabaseSync } from "node:sqlite";
import { join } from "path";

export function chatDbPath(dataDir) {
  return join(dataDir, "chat.db");
}

// t31: Extended schema with identity columns matching the real omnigent
// db_models.py conversations table. These columns allow the model-identity
// observer to read harness_override, model_override, and session_usage from
// the root conversation row — the external t00 seam for observed identity.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
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
CREATE TABLE IF NOT EXISTS conversation_items (
  workspace_id INTEGER NOT NULL DEFAULT 0,
  conversation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, conversation_id, id)
);
`;

export function openChatDb(dataDir) {
  const db = new DatabaseSync(chatDbPath(dataDir));
  db.exec(SCHEMA);
  return db;
}

// Insert a conversation row plus `itemCount` transcript items. Used by both the
// fixture (to simulate a real worker session) and tests (to pre-seed a foreign
// conversation for the "created by THIS dispatch" assertion).
// t31: identity fields (harnessOverride, modelOverride, sessionUsage) are
// recorded in the conversations row so the model-identity observer can read
// them from the external chat.db seam.
export function insertConversation(dataDir, convId, itemCount, createdAt, opts = {}) {
  const db = openChatDb(dataDir);
  try {
    const harnessOverride = opts.harnessOverride ?? null;
    const modelOverride = opts.modelOverride ?? null;
    const sessionUsage = opts.sessionUsage ?? null;
    const providerVendor = opts.providerVendor ?? null;
    db.prepare(
      "INSERT OR IGNORE INTO conversations (workspace_id, id, created_at, root_conversation_id, parent_conversation_id, agent_id, model_override, harness_override, provider_vendor, session_usage) VALUES (0, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)",
    ).run(convId, createdAt, convId, modelOverride, harnessOverride, providerVendor, sessionUsage);
    for (let i = 0; i < itemCount; i++) {
      db.prepare(
        "INSERT OR IGNORE INTO conversation_items (workspace_id, conversation_id, id, position) VALUES (0, ?, ?, ?)",
      ).run(convId, `${convId}-item-${i}`, i);
    }
  } finally {
    db.close();
  }
}
