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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  workspace_id INTEGER NOT NULL DEFAULT 0,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  root_conversation_id TEXT,
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
export function insertConversation(dataDir, convId, itemCount, createdAt) {
  const db = openChatDb(dataDir);
  try {
    db.prepare(
      "INSERT OR IGNORE INTO conversations (workspace_id, id, created_at, root_conversation_id) VALUES (0, ?, ?, ?)",
    ).run(convId, createdAt, convId);
    for (let i = 0; i < itemCount; i++) {
      db.prepare(
        "INSERT OR IGNORE INTO conversation_items (workspace_id, conversation_id, id, position) VALUES (0, ?, ?, ?)",
      ).run(convId, `${convId}-item-${i}`, i);
    }
  } finally {
    db.close();
  }
}
