// Compute the migration checksum and the new LATEST_STATE_SQLITE_SCHEMA_CHECKSUM
// for migration 006 (attempts_legal_edge failure-edge alignment).
//
// Usage: node orchestrator/scripts/compute-migration-006-checksums.mjs
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  STATE_MIGRATIONS,
} from "../dist/state/migrations.js";

const MIGRATION_006_SQL = `
DROP TRIGGER attempts_legal_edge;
CREATE TRIGGER attempts_legal_edge BEFORE UPDATE OF state ON attempts
WHEN NOT ((OLD.state = 'planned' AND NEW.state IN ('implementing','cleanup_pending')) OR
          (OLD.state = 'implementing' AND NEW.state IN ('implementation_captured','cleanup_pending')) OR
          (OLD.state = 'implementation_captured' AND NEW.state IN ('reviewing','cleanup_pending')) OR
          (OLD.state = 'reviewing' AND NEW.state IN ('verification_queued','remediating','cleanup_pending')) OR
          (OLD.state = 'remediating' AND NEW.state IN ('remediation_captured','cleanup_pending')) OR
          (OLD.state = 'remediation_captured' AND NEW.state IN ('reviewing','cleanup_pending')) OR
          (OLD.state = 'verification_queued' AND NEW.state IN ('verifying','cleanup_pending')) OR
          (OLD.state = 'verifying' AND NEW.state IN ('converging','cleanup_pending')) OR
          (OLD.state = 'converging' AND NEW.state = 'cleanup_pending') OR
          (OLD.state = 'cleanup_pending' AND NEW.state IN ('oracle_evaluation','failed_clean','quarantined')) OR
          (OLD.state = 'oracle_evaluation' AND NEW.state = 'verified'))
BEGIN SELECT RAISE(ABORT, 'illegal attempt state transition'); END;
`.trim();

function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function sqliteSchemaChecksum(database) {
  const rows = database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all();
  return sha256(JSON.stringify(rows));
}

// Build a fresh database with all existing migrations, then apply 006.
const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
const now = new Date().toISOString();
for (const migration of STATE_MIGRATIONS) {
  db.exec(migration.sql);
  db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
    .run(migration.version, migration.name, migration.checksum, now);
}

// Checksum before 006 (should match LATEST_STATE_SQLITE_SCHEMA_CHECKSUM).
const before = sqliteSchemaChecksum(db);
console.log("schema checksum BEFORE 006:", before);

// Apply migration 006.
db.exec(MIGRATION_006_SQL);
db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
  .run(6, "006_attempt_legal_edge_failure_edges", sha256(MIGRATION_006_SQL), now);

const after = sqliteSchemaChecksum(db);
console.log("schema checksum AFTER 006:", after);
console.log("migration 006 checksum:", sha256(MIGRATION_006_SQL));
console.log("migration 006 SQL:");
console.log(MIGRATION_006_SQL);

db.close();
