import { createHash } from "node:crypto";

export interface StateMigration {
  readonly version: number;
  readonly number: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: `sha256:${string}`;
}

const ID = (column: string): string => `CHECK (length(${column}) > 0)`;
const DIGEST = (column: string): string =>
  `CHECK (length(${column}) = 71 AND substr(${column}, 1, 7) = 'sha256:' AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*')`;
const OPTIONAL_DIGEST = (column: string): string =>
  `CHECK (${column} IS NULL OR (length(${column}) = 71 AND substr(${column}, 1, 7) = 'sha256:' AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*'))`;
const OID = (column: string): string =>
  `CHECK (length(${column}) IN (40, 64) AND ${column} NOT GLOB '*[^0-9a-f]*')`;
const OPTIONAL_OID = (column: string): string =>
  `CHECK (${column} IS NULL OR (length(${column}) IN (40, 64) AND ${column} NOT GLOB '*[^0-9a-f]*'))`;
const UTC = (column: string): string =>
  `CHECK (length(${column}) >= 20 AND substr(${column}, -1) = 'Z')`;
const JSON_OBJECT = (column: string): string =>
  `CHECK (json_valid(${column}) AND json_type(${column}) = 'object')`;
const OPTIONAL_JSON_OBJECT = (column: string): string =>
  `CHECK (${column} IS NULL OR (json_valid(${column}) AND json_type(${column}) = 'object'))`;
const JSON_ARRAY = (column: string): string =>
  `CHECK (json_valid(${column}) AND json_type(${column}) = 'array')`;
const OPTIONAL_JSON_ARRAY = (column: string): string =>
  `CHECK (${column} IS NULL OR (json_valid(${column}) AND json_type(${column}) = 'array'))`;

const BASE_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL ${ID("name")},
  checksum TEXT NOT NULL ${DIGEST("checksum")},
  applied_at TEXT NOT NULL ${UTC("applied_at")}
) STRICT;
CREATE UNIQUE INDEX schema_migrations_name_uq ON schema_migrations(name);

CREATE TABLE repositories (
  repository_id TEXT PRIMARY KEY ${ID("repository_id")},
  repo_realpath TEXT NOT NULL ${ID("repo_realpath")},
  git_common_dir_realpath TEXT NOT NULL ${ID("git_common_dir_realpath")},
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1','sha256')),
  state_directory TEXT NOT NULL ${ID("state_directory")},
  identity_digest TEXT NOT NULL ${DIGEST("identity_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  CHECK (state_directory = git_common_dir_realpath || '/rickgent')
) STRICT;
CREATE UNIQUE INDEX repositories_tuple_uq ON repositories(repo_realpath, git_common_dir_realpath, object_format);
CREATE UNIQUE INDEX repositories_digest_uq ON repositories(identity_digest);

CREATE TABLE run_manifests (
  manifest_digest TEXT PRIMARY KEY ${DIGEST("manifest_digest")},
  schema_version TEXT NOT NULL ${ID("schema_version")},
  canonical_manifest_json TEXT NOT NULL ${JSON_OBJECT("canonical_manifest_json")},
  capability_snapshot_digest TEXT NOT NULL ${DIGEST("capability_snapshot_digest")},
  context_schema_version TEXT NOT NULL ${ID("context_schema_version")},
  oracle_version TEXT NOT NULL ${ID("oracle_version")},
  created_at TEXT NOT NULL ${UTC("created_at")}
) STRICT;

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY ${ID("run_id")},
  repository_id TEXT NOT NULL ${ID("repository_id")},
  run_sequence INTEGER NOT NULL CHECK (run_sequence > 0),
  manifest_digest TEXT NOT NULL ${DIGEST("manifest_digest")},
  initial_delivery_oid TEXT NOT NULL ${OID("initial_delivery_oid")},
  delivery_ref TEXT NOT NULL ${ID("delivery_ref")},
  state TEXT NOT NULL CHECK (state IN ('planned','active','cleanup_pending','failed','delivery_failed','ready_for_delivery','delivered')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  current_delivery_oid TEXT NOT NULL ${OID("current_delivery_oid")},
  promotion_sequence INTEGER NOT NULL CHECK (promotion_sequence >= 0),
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (repository_id) REFERENCES repositories(repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (manifest_digest) REFERENCES run_manifests(manifest_digest) ON DELETE RESTRICT,
  CHECK (delivery_ref = 'refs/rickgent/runs/' || run_id || '/delivery')
) STRICT;
CREATE UNIQUE INDEX runs_repository_sequence_uq ON runs(repository_id, run_sequence);
CREATE UNIQUE INDEX runs_delivery_ref_uq ON runs(delivery_ref);

CREATE TABLE ticket_contracts (
  contract_digest TEXT PRIMARY KEY ${DIGEST("contract_digest")},
  schema_version TEXT NOT NULL ${ID("schema_version")},
  canonical_contract_json TEXT NOT NULL ${JSON_OBJECT("canonical_contract_json")},
  created_at TEXT NOT NULL ${UTC("created_at")}
) STRICT;

CREATE TABLE run_tickets (
  ticket_instance_id TEXT PRIMARY KEY ${ID("ticket_instance_id")},
  run_id TEXT NOT NULL ${ID("run_id")},
  ticket_id TEXT NOT NULL ${ID("ticket_id")},
  plan_index INTEGER NOT NULL CHECK (plan_index >= 0),
  contract_digest TEXT NOT NULL ${DIGEST("contract_digest")},
  state TEXT NOT NULL CHECK (state IN ('planned','active','cleanup_pending','failed','quarantined','ready_for_delivery')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (contract_digest) REFERENCES ticket_contracts(contract_digest) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX run_tickets_id_uq ON run_tickets(run_id, ticket_id);
CREATE UNIQUE INDEX run_tickets_plan_uq ON run_tickets(run_id, plan_index);
CREATE UNIQUE INDEX run_tickets_instance_contract_uq ON run_tickets(ticket_instance_id, contract_digest);
CREATE UNIQUE INDEX run_tickets_instance_run_uq ON run_tickets(ticket_instance_id, run_id);
CREATE UNIQUE INDEX run_tickets_full_scope_uq ON run_tickets(ticket_instance_id, run_id, ticket_id, contract_digest);

CREATE TABLE run_ticket_dependencies (
  run_id TEXT NOT NULL ${ID("run_id")},
  ticket_id TEXT NOT NULL ${ID("ticket_id")},
  depends_on_ticket_id TEXT NOT NULL ${ID("depends_on_ticket_id")},
  dependency_digest TEXT NOT NULL ${DIGEST("dependency_digest")},
  PRIMARY KEY (run_id, ticket_id, depends_on_ticket_id),
  FOREIGN KEY (run_id, ticket_id) REFERENCES run_tickets(run_id, ticket_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, depends_on_ticket_id) REFERENCES run_tickets(run_id, ticket_id) ON DELETE RESTRICT,
  CHECK (ticket_id <> depends_on_ticket_id)
) STRICT;
CREATE UNIQUE INDEX run_ticket_dependencies_edge_uq ON run_ticket_dependencies(run_id, ticket_id, depends_on_ticket_id);
CREATE UNIQUE INDEX run_ticket_dependencies_digest_uq ON run_ticket_dependencies(dependency_digest);

CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY ${ID("attempt_id")},
  ticket_instance_id TEXT NOT NULL ${ID("ticket_instance_id")},
  run_id TEXT NOT NULL ${ID("run_id")},
  ticket_id TEXT NOT NULL ${ID("ticket_id")},
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  contract_digest TEXT NOT NULL ${DIGEST("contract_digest")},
  allocation_owner_digest TEXT NOT NULL ${DIGEST("allocation_owner_digest")},
  delivery_baseline_oid TEXT NOT NULL ${OID("delivery_baseline_oid")},
  context_schema_version TEXT NOT NULL ${ID("context_schema_version")},
  oracle_version TEXT NOT NULL ${ID("oracle_version")},
  capability_snapshot_digest TEXT NOT NULL ${DIGEST("capability_snapshot_digest")},
  resource_identity_version TEXT NOT NULL ${ID("resource_identity_version")},
  state TEXT NOT NULL CHECK (state IN ('planned','implementing','implementation_captured','reviewing','remediating','remediation_captured','verification_queued','verifying','converging','cleanup_pending','oracle_evaluation','failed_clean','quarantined','verified')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (ticket_instance_id, contract_digest) REFERENCES run_tickets(ticket_instance_id, contract_digest) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, ticket_id) REFERENCES run_tickets(run_id, ticket_id) ON DELETE RESTRICT,
  FOREIGN KEY (ticket_instance_id, run_id, ticket_id, contract_digest) REFERENCES run_tickets(ticket_instance_id, run_id, ticket_id, contract_digest) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX attempts_run_ticket_number_uq ON attempts(run_id, ticket_id, attempt_number);
CREATE UNIQUE INDEX attempts_instance_number_uq ON attempts(ticket_instance_id, attempt_number);
CREATE UNIQUE INDEX attempts_identity_scope_uq ON attempts(attempt_id, ticket_instance_id, run_id);
CREATE UNIQUE INDEX attempts_identity_contract_uq ON attempts(attempt_id, contract_digest);

CREATE TABLE execution_contexts (
  context_id TEXT PRIMARY KEY ${ID("context_id")},
  context_digest TEXT NOT NULL ${DIGEST("context_digest")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  phase TEXT NOT NULL ${ID("phase")},
  phase_ordinal INTEGER NOT NULL CHECK (phase_ordinal >= 0),
  role TEXT NOT NULL ${ID("role")},
  canonical_context_json TEXT NOT NULL ${JSON_OBJECT("canonical_context_json")},
  contract_digest TEXT NOT NULL ${DIGEST("contract_digest")},
  capability_snapshot_digest TEXT NOT NULL ${DIGEST("capability_snapshot_digest")},
  policy_bundle_digest TEXT NOT NULL ${DIGEST("policy_bundle_digest")},
  model_selection_digest TEXT NOT NULL ${DIGEST("model_selection_digest")},
  budget_digest TEXT NOT NULL ${DIGEST("budget_digest")},
  scope_digest TEXT NOT NULL ${DIGEST("scope_digest")},
  context_schema_version TEXT NOT NULL ${ID("context_schema_version")},
  oracle_version TEXT NOT NULL ${ID("oracle_version")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (contract_digest) REFERENCES ticket_contracts(contract_digest) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, contract_digest) REFERENCES attempts(attempt_id, contract_digest) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX execution_contexts_digest_uq ON execution_contexts(context_digest);
CREATE UNIQUE INDEX execution_contexts_phase_role_uq ON execution_contexts(attempt_id, phase, phase_ordinal, role);
CREATE UNIQUE INDEX execution_contexts_identity_attempt_uq ON execution_contexts(context_id, attempt_id);

CREATE TABLE phase_executions (
  phase_execution_id TEXT PRIMARY KEY ${ID("phase_execution_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  context_id TEXT NOT NULL ${ID("context_id")},
  phase TEXT NOT NULL ${ID("phase")},
  phase_ordinal INTEGER NOT NULL CHECK (phase_ordinal >= 0),
  role TEXT NOT NULL ${ID("role")},
  identity_digest TEXT NOT NULL ${DIGEST("identity_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id) REFERENCES execution_contexts(context_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX phase_executions_context_uq ON phase_executions(context_id);
CREATE UNIQUE INDEX phase_executions_identity_uq ON phase_executions(identity_digest);
CREATE UNIQUE INDEX phase_executions_identity_attempt_uq ON phase_executions(phase_execution_id, attempt_id);
CREATE UNIQUE INDEX phase_executions_identity_context_uq ON phase_executions(phase_execution_id, context_id);

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY ${ID("evidence_id")},
  attempt_id TEXT,
  phase_execution_id TEXT,
  context_id TEXT NOT NULL ${ID("context_id")},
  producer_service TEXT NOT NULL ${ID("producer_service")},
  scope TEXT NOT NULL ${ID("scope")},
  schema_version TEXT NOT NULL ${ID("schema_version")},
  content_digest TEXT NOT NULL ${DIGEST("content_digest")},
  inline_payload_json TEXT ${OPTIONAL_JSON_OBJECT("inline_payload_json")},
  external_path TEXT,
  external_digest TEXT ${OPTIONAL_DIGEST("external_digest")},
  external_size INTEGER CHECK (external_size IS NULL OR external_size >= 0),
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (phase_execution_id) REFERENCES phase_executions(phase_execution_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id) REFERENCES execution_contexts(context_id) ON DELETE RESTRICT,
  FOREIGN KEY (phase_execution_id, attempt_id) REFERENCES phase_executions(phase_execution_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (phase_execution_id, context_id) REFERENCES phase_executions(phase_execution_id, context_id) ON DELETE RESTRICT,
  CHECK ((inline_payload_json IS NOT NULL AND external_path IS NULL AND external_digest IS NULL AND external_size IS NULL) OR
         (inline_payload_json IS NULL AND external_path IS NOT NULL AND length(external_path) > 0 AND external_digest IS NOT NULL AND external_size IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX evidence_producer_idempotency_uq ON evidence(producer_service, scope, idempotency_key);
CREATE UNIQUE INDEX evidence_producer_content_uq ON evidence(producer_service, scope, content_digest);
CREATE UNIQUE INDEX evidence_identity_attempt_uq ON evidence(evidence_id, attempt_id);

CREATE TABLE state_transitions (
  transition_id TEXT PRIMARY KEY ${ID("transition_id")},
  run_id TEXT,
  ticket_instance_id TEXT,
  attempt_id TEXT,
  entity_sequence INTEGER NOT NULL CHECK (entity_sequence > 0),
  from_state TEXT NOT NULL ${ID("from_state")},
  to_state TEXT NOT NULL ${ID("to_state")},
  owner_service TEXT NOT NULL ${ID("owner_service")},
  owner_context_digest TEXT NOT NULL ${DIGEST("owner_context_digest")},
  input_digest TEXT NOT NULL ${DIGEST("input_digest")},
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (ticket_instance_id) REFERENCES run_tickets(ticket_instance_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  CHECK ((run_id IS NOT NULL) + (ticket_instance_id IS NOT NULL) + (attempt_id IS NOT NULL) = 1),
  CHECK (from_state <> to_state)
) STRICT;
CREATE UNIQUE INDEX state_transitions_run_sequence_uq ON state_transitions(run_id, entity_sequence) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX state_transitions_ticket_sequence_uq ON state_transitions(ticket_instance_id, entity_sequence) WHERE ticket_instance_id IS NOT NULL;
CREATE UNIQUE INDEX state_transitions_attempt_sequence_uq ON state_transitions(attempt_id, entity_sequence) WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX state_transitions_run_idempotency_uq ON state_transitions(run_id, idempotency_key) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX state_transitions_ticket_idempotency_uq ON state_transitions(ticket_instance_id, idempotency_key) WHERE ticket_instance_id IS NOT NULL;
CREATE UNIQUE INDEX state_transitions_attempt_idempotency_uq ON state_transitions(attempt_id, idempotency_key) WHERE attempt_id IS NOT NULL;

CREATE TABLE transition_evidence_refs (
  transition_id TEXT NOT NULL ${ID("transition_id")},
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  purpose TEXT NOT NULL ${ID("purpose")},
  evidence_id TEXT NOT NULL ${ID("evidence_id")},
  PRIMARY KEY (transition_id, ordinal),
  FOREIGN KEY (transition_id) REFERENCES state_transitions(transition_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX transition_evidence_purpose_uq ON transition_evidence_refs(transition_id, purpose, evidence_id);

CREATE TABLE leases (
  lease_id TEXT PRIMARY KEY ${ID("lease_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  generation INTEGER NOT NULL CHECK (generation > 0),
  owner_token_digest TEXT NOT NULL ${DIGEST("owner_token_digest")},
  owner_context_id TEXT NOT NULL ${ID("owner_context_id")},
  heartbeat_at TEXT NOT NULL ${UTC("heartbeat_at")},
  expires_at TEXT NOT NULL ${UTC("expires_at")},
  state TEXT NOT NULL CHECK (state IN ('reserved','live','cleanup_pending','released','quarantined')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  acquisition_evidence_id TEXT NOT NULL ${ID("acquisition_evidence_id")},
  release_evidence_id TEXT,
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_context_id) REFERENCES execution_contexts(context_id) ON DELETE RESTRICT,
  FOREIGN KEY (acquisition_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (release_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (acquisition_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (release_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK (expires_at > heartbeat_at)
) STRICT;
CREATE UNIQUE INDEX leases_attempt_generation_uq ON leases(attempt_id, generation);
CREATE UNIQUE INDEX leases_one_live_uq ON leases(attempt_id) WHERE state IN ('live','cleanup_pending');
CREATE UNIQUE INDEX leases_identity_attempt_uq ON leases(lease_id, attempt_id);
CREATE UNIQUE INDEX leases_identity_generation_uq ON leases(lease_id, generation);

CREATE TABLE attempt_resources (
  resource_id TEXT PRIMARY KEY ${ID("resource_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  slot TEXT NOT NULL ${ID("slot")},
  kind TEXT NOT NULL CHECK (kind IN ('delivery_ref','attempt_ref','worktree','isolated_index','policy_context','policy_bundle','process_group','stdout','stderr','verification_output','salvage_archive')),
  canonical_identity TEXT NOT NULL ${ID("canonical_identity")},
  identity_digest TEXT NOT NULL ${DIGEST("identity_digest")},
  allocation_lease_id TEXT NOT NULL ${ID("allocation_lease_id")},
  allocation_evidence_id TEXT NOT NULL ${ID("allocation_evidence_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  owner_context_id TEXT NOT NULL ${ID("owner_context_id")},
  state TEXT NOT NULL CHECK (state IN ('reserved','allocated','active','cleanup_pending','released','quarantined')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  release_evidence_id TEXT,
  quarantine_evidence_id TEXT,
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (allocation_lease_id) REFERENCES leases(lease_id) ON DELETE RESTRICT,
  FOREIGN KEY (allocation_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_context_id) REFERENCES execution_contexts(context_id) ON DELETE RESTRICT,
  FOREIGN KEY (release_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (quarantine_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (allocation_lease_id, attempt_id) REFERENCES leases(lease_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (allocation_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (release_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (quarantine_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX attempt_resources_slot_uq ON attempt_resources(attempt_id, slot);
CREATE UNIQUE INDEX attempt_resources_active_identity_uq ON attempt_resources(kind, identity_digest) WHERE state IN ('reserved','allocated','active','cleanup_pending');

CREATE TABLE process_receipts (
  process_receipt_id TEXT PRIMARY KEY ${ID("process_receipt_id")},
  phase_execution_id TEXT NOT NULL ${ID("phase_execution_id")},
  context_id TEXT NOT NULL ${ID("context_id")},
  lease_id TEXT NOT NULL ${ID("lease_id")},
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  pid INTEGER NOT NULL CHECK (pid > 0),
  pgid INTEGER NOT NULL CHECK (pgid > 0),
  boot_identity TEXT NOT NULL ${ID("boot_identity")},
  process_start_identity TEXT NOT NULL ${ID("process_start_identity")},
  argv_digest TEXT NOT NULL ${DIGEST("argv_digest")},
  environment_digest TEXT NOT NULL ${DIGEST("environment_digest")},
  launch_evidence_id TEXT NOT NULL ${ID("launch_evidence_id")},
  exit_evidence_id TEXT,
  termination_evidence_id TEXT,
  group_death_evidence_id TEXT,
  stdout_evidence_id TEXT,
  stderr_evidence_id TEXT,
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (phase_execution_id) REFERENCES phase_executions(phase_execution_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id) REFERENCES execution_contexts(context_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id) REFERENCES leases(lease_id) ON DELETE RESTRICT,
  FOREIGN KEY (launch_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (exit_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (termination_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (group_death_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (stdout_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (stderr_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (phase_execution_id, context_id) REFERENCES phase_executions(phase_execution_id, context_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, lease_generation) REFERENCES leases(lease_id, generation) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX process_receipts_phase_uq ON process_receipts(phase_execution_id);

CREATE TABLE gate_results (
  gate_result_id TEXT PRIMARY KEY ${ID("gate_result_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  gate_id TEXT NOT NULL ${ID("gate_id")},
  evaluation_ordinal INTEGER NOT NULL CHECK (evaluation_ordinal >= 0),
  status TEXT NOT NULL CHECK (status IN ('passed','failed','missing','null','skipped','unavailable','infrastructure_error','stale','conflicting')),
  required INTEGER NOT NULL CHECK (required IN (0,1)),
  context_id TEXT NOT NULL ${ID("context_id")},
  contract_digest TEXT NOT NULL ${DIGEST("contract_digest")},
  evidence_id TEXT NOT NULL ${ID("evidence_id")},
  result_digest TEXT NOT NULL ${DIGEST("result_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id) REFERENCES execution_contexts(context_id) ON DELETE RESTRICT,
  FOREIGN KEY (contract_digest) REFERENCES ticket_contracts(contract_digest) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, contract_digest) REFERENCES attempts(attempt_id, contract_digest) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX gate_results_evaluation_uq ON gate_results(attempt_id, gate_id, evaluation_ordinal);

CREATE TABLE review_records (
  review_record_id TEXT PRIMARY KEY ${ID("review_record_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  cycle INTEGER NOT NULL CHECK (cycle > 0),
  reviewer_context_id TEXT NOT NULL ${ID("reviewer_context_id")},
  verdict TEXT NOT NULL ${ID("verdict")},
  verdict_evidence_id TEXT NOT NULL ${ID("verdict_evidence_id")},
  findings_evidence_id TEXT NOT NULL ${ID("findings_evidence_id")},
  input_tree_oid TEXT NOT NULL ${OID("input_tree_oid")},
  input_diff_digest TEXT NOT NULL ${DIGEST("input_diff_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (reviewer_context_id) REFERENCES execution_contexts(context_id) ON DELETE RESTRICT,
  FOREIGN KEY (verdict_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (findings_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (reviewer_context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (verdict_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (findings_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX review_records_cycle_uq ON review_records(attempt_id, cycle);

CREATE TABLE remediation_records (
  remediation_record_id TEXT PRIMARY KEY ${ID("remediation_record_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  cycle INTEGER NOT NULL CHECK (cycle > 0),
  context_id TEXT NOT NULL ${ID("context_id")},
  findings_evidence_id TEXT NOT NULL ${ID("findings_evidence_id")},
  output_evidence_id TEXT NOT NULL ${ID("output_evidence_id")},
  result_tree_oid TEXT NOT NULL ${OID("result_tree_oid")},
  result_diff_digest TEXT NOT NULL ${DIGEST("result_diff_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id) REFERENCES execution_contexts(context_id) ON DELETE RESTRICT,
  FOREIGN KEY (findings_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (output_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (findings_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (output_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX remediation_records_cycle_uq ON remediation_records(attempt_id, cycle);

CREATE TABLE commit_attributions (
  commit_attribution_id TEXT PRIMARY KEY ${ID("commit_attribution_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  baseline_oid TEXT NOT NULL ${OID("baseline_oid")},
  parent_oid TEXT NOT NULL ${OID("parent_oid")},
  tree_before_oid TEXT NOT NULL ${OID("tree_before_oid")},
  tree_after_oid TEXT NOT NULL ${OID("tree_after_oid")},
  commit_oid TEXT NOT NULL ${OID("commit_oid")},
  contract_digest TEXT NOT NULL ${DIGEST("contract_digest")},
  context_digest TEXT NOT NULL ${DIGEST("context_digest")},
  path_set_digest TEXT NOT NULL ${DIGEST("path_set_digest")},
  change_kind_set_digest TEXT NOT NULL ${DIGEST("change_kind_set_digest")},
  mode_set_digest TEXT NOT NULL ${DIGEST("mode_set_digest")},
  attribution_evidence_id TEXT NOT NULL ${ID("attribution_evidence_id")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (contract_digest) REFERENCES ticket_contracts(contract_digest) ON DELETE RESTRICT,
  FOREIGN KEY (attribution_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, contract_digest) REFERENCES attempts(attempt_id, contract_digest) ON DELETE RESTRICT,
  FOREIGN KEY (attribution_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK (parent_oid = baseline_oid)
) STRICT;
CREATE UNIQUE INDEX commit_attributions_attempt_uq ON commit_attributions(attempt_id);
CREATE UNIQUE INDEX commit_attributions_commit_uq ON commit_attributions(commit_oid);
CREATE UNIQUE INDEX commit_attributions_identity_attempt_uq ON commit_attributions(commit_attribution_id, attempt_id);

CREATE TABLE salvage_records (
  salvage_record_id TEXT PRIMARY KEY ${ID("salvage_record_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  disposition TEXT NOT NULL ${ID("disposition")},
  artifact_path TEXT,
  artifact_digest TEXT ${OPTIONAL_DIGEST("artifact_digest")},
  artifact_size INTEGER CHECK (artifact_size IS NULL OR artifact_size >= 0),
  evidence_id TEXT NOT NULL ${ID("evidence_id")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK ((artifact_path IS NULL AND artifact_digest IS NULL AND artifact_size IS NULL) OR
         (artifact_path IS NOT NULL AND length(artifact_path) > 0 AND artifact_digest IS NOT NULL AND artifact_size IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX salvage_records_attempt_disposition_uq ON salvage_records(attempt_id, disposition);

CREATE TABLE cleanup_records (
  cleanup_record_id TEXT PRIMARY KEY ${ID("cleanup_record_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  context_id TEXT NOT NULL ${ID("context_id")},
  outcome TEXT NOT NULL ${ID("outcome")},
  group_dead INTEGER NOT NULL CHECK (group_dead IN (0,1)),
  worktree_disposition TEXT NOT NULL ${ID("worktree_disposition")},
  index_disposition TEXT NOT NULL ${ID("index_disposition")},
  ref_disposition TEXT NOT NULL ${ID("ref_disposition")},
  context_disposition TEXT NOT NULL ${ID("context_disposition")},
  bundle_disposition TEXT NOT NULL ${ID("bundle_disposition")},
  delivery_ref_observed_oid TEXT NOT NULL ${OID("delivery_ref_observed_oid")},
  resources_absent INTEGER NOT NULL CHECK (resources_absent IN (0,1)),
  lease_release_eligible INTEGER NOT NULL CHECK (lease_release_eligible IN (0,1)),
  evidence_id TEXT NOT NULL ${ID("evidence_id")},
  record_digest TEXT NOT NULL ${DIGEST("record_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id) REFERENCES execution_contexts(context_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK (lease_release_eligible = 0 OR (group_dead = 1 AND resources_absent = 1))
) STRICT;
CREATE UNIQUE INDEX cleanup_records_sequence_uq ON cleanup_records(attempt_id, sequence);
CREATE UNIQUE INDEX cleanup_records_digest_uq ON cleanup_records(record_digest);

CREATE TABLE oracle_decisions (
  oracle_decision_id TEXT PRIMARY KEY ${ID("oracle_decision_id")},
  oracle_version TEXT NOT NULL ${ID("oracle_version")},
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('run','ticket','attempt')),
  run_id TEXT NOT NULL ${ID("run_id")},
  ticket_instance_id TEXT,
  attempt_id TEXT,
  input_set_digest TEXT NOT NULL ${DIGEST("input_set_digest")},
  result TEXT NOT NULL CHECK (result IN ('accepted','rejected')),
  reasons_json TEXT NOT NULL ${JSON_ARRAY("reasons_json")},
  output_digest TEXT NOT NULL ${DIGEST("output_digest")},
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (ticket_instance_id, run_id) REFERENCES run_tickets(ticket_instance_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, ticket_instance_id, run_id) REFERENCES attempts(attempt_id, ticket_instance_id, run_id) ON DELETE RESTRICT,
  CHECK ((scope_kind = 'run' AND ticket_instance_id IS NULL AND attempt_id IS NULL) OR
         (scope_kind = 'ticket' AND ticket_instance_id IS NOT NULL AND attempt_id IS NULL) OR
         (scope_kind = 'attempt' AND ticket_instance_id IS NOT NULL AND attempt_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX oracle_decisions_input_uq ON oracle_decisions(oracle_version, scope_kind, input_set_digest);
CREATE UNIQUE INDEX oracle_decisions_identity_run_scope_uq ON oracle_decisions(oracle_decision_id, run_id);
CREATE UNIQUE INDEX oracle_decisions_identity_ticket_scope_uq ON oracle_decisions(oracle_decision_id, run_id, ticket_instance_id);
CREATE UNIQUE INDEX oracle_decisions_identity_attempt_scope_uq ON oracle_decisions(oracle_decision_id, run_id, ticket_instance_id, attempt_id);
CREATE UNIQUE INDEX oracle_decisions_run_idempotency_uq ON oracle_decisions(run_id, idempotency_key) WHERE scope_kind = 'run';
CREATE UNIQUE INDEX oracle_decisions_ticket_idempotency_uq ON oracle_decisions(ticket_instance_id, idempotency_key) WHERE scope_kind = 'ticket';
CREATE UNIQUE INDEX oracle_decisions_attempt_idempotency_uq ON oracle_decisions(attempt_id, idempotency_key) WHERE scope_kind = 'attempt';

CREATE TABLE oracle_input_references (
  oracle_decision_id TEXT NOT NULL ${ID("oracle_decision_id")},
  run_id TEXT NOT NULL ${ID("run_id")},
  ticket_instance_id TEXT,
  attempt_id TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  reference_kind TEXT NOT NULL CHECK (reference_kind IN ('run_manifest','ticket_contract','execution_context','evidence','gate_result','review_record','commit_attribution','cleanup_record','dependency_edge','attempt_resource_snapshot','lease_snapshot','process_receipt')),
  run_manifest_digest TEXT ${OPTIONAL_DIGEST("run_manifest_digest")},
  contract_digest TEXT ${OPTIONAL_DIGEST("contract_digest")},
  context_id TEXT,
  evidence_id TEXT,
  gate_result_id TEXT,
  review_record_id TEXT,
  commit_attribution_id TEXT,
  cleanup_record_id TEXT,
  dependency_digest TEXT ${OPTIONAL_DIGEST("dependency_digest")},
  resource_snapshot_evidence_id TEXT,
  lease_snapshot_evidence_id TEXT,
  process_receipt_id TEXT,
  content_digest TEXT NOT NULL ${DIGEST("content_digest")},
  PRIMARY KEY (oracle_decision_id, ordinal),
  FOREIGN KEY (oracle_decision_id, run_id) REFERENCES oracle_decisions(oracle_decision_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (oracle_decision_id, run_id, ticket_instance_id) REFERENCES oracle_decisions(oracle_decision_id, run_id, ticket_instance_id) ON DELETE RESTRICT,
  FOREIGN KEY (oracle_decision_id, run_id, ticket_instance_id, attempt_id) REFERENCES oracle_decisions(oracle_decision_id, run_id, ticket_instance_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_manifest_digest) REFERENCES run_manifests(manifest_digest) ON DELETE RESTRICT,
  FOREIGN KEY (contract_digest) REFERENCES ticket_contracts(contract_digest) ON DELETE RESTRICT,
  FOREIGN KEY (context_id) REFERENCES execution_contexts(context_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (gate_result_id) REFERENCES gate_results(gate_result_id) ON DELETE RESTRICT,
  FOREIGN KEY (review_record_id) REFERENCES review_records(review_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (commit_attribution_id) REFERENCES commit_attributions(commit_attribution_id) ON DELETE RESTRICT,
  FOREIGN KEY (cleanup_record_id) REFERENCES cleanup_records(cleanup_record_id) ON DELETE RESTRICT,
  FOREIGN KEY (dependency_digest) REFERENCES run_ticket_dependencies(dependency_digest) ON DELETE RESTRICT,
  FOREIGN KEY (resource_snapshot_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (resource_snapshot_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_snapshot_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_snapshot_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (process_receipt_id) REFERENCES process_receipts(process_receipt_id) ON DELETE RESTRICT,
  CHECK ((run_manifest_digest IS NOT NULL) + (contract_digest IS NOT NULL) + (context_id IS NOT NULL) +
         (evidence_id IS NOT NULL) + (gate_result_id IS NOT NULL) + (review_record_id IS NOT NULL) +
         (commit_attribution_id IS NOT NULL) + (cleanup_record_id IS NOT NULL) + (dependency_digest IS NOT NULL) +
         (resource_snapshot_evidence_id IS NOT NULL) + (lease_snapshot_evidence_id IS NOT NULL) + (process_receipt_id IS NOT NULL) = 1),
  CHECK ((reference_kind = 'run_manifest' AND run_manifest_digest IS NOT NULL) OR
         (reference_kind = 'ticket_contract' AND contract_digest IS NOT NULL) OR
         (reference_kind = 'execution_context' AND context_id IS NOT NULL) OR
         (reference_kind = 'evidence' AND evidence_id IS NOT NULL) OR
         (reference_kind = 'gate_result' AND gate_result_id IS NOT NULL) OR
         (reference_kind = 'review_record' AND review_record_id IS NOT NULL) OR
         (reference_kind = 'commit_attribution' AND commit_attribution_id IS NOT NULL) OR
         (reference_kind = 'cleanup_record' AND cleanup_record_id IS NOT NULL) OR
         (reference_kind = 'dependency_edge' AND dependency_digest IS NOT NULL) OR
         (reference_kind = 'attempt_resource_snapshot' AND resource_snapshot_evidence_id IS NOT NULL) OR
         (reference_kind = 'lease_snapshot' AND lease_snapshot_evidence_id IS NOT NULL) OR
         (reference_kind = 'process_receipt' AND process_receipt_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX oracle_input_reference_identity_uq ON oracle_input_references(oracle_decision_id, reference_kind, content_digest);

CREATE TABLE promotion_intents (
  promotion_intent_id TEXT PRIMARY KEY ${ID("promotion_intent_id")},
  run_id TEXT NOT NULL ${ID("run_id")},
  ticket_instance_id TEXT NOT NULL ${ID("ticket_instance_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  promotion_sequence INTEGER NOT NULL CHECK (promotion_sequence > 0),
  delivery_ref TEXT NOT NULL ${ID("delivery_ref")},
  expected_old_oid TEXT NOT NULL ${OID("expected_old_oid")},
  candidate_oid TEXT NOT NULL ${OID("candidate_oid")},
  oracle_decision_id TEXT NOT NULL ${ID("oracle_decision_id")},
  commit_attribution_id TEXT NOT NULL ${ID("commit_attribution_id")},
  owner_context_id TEXT NOT NULL ${ID("owner_context_id")},
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  state TEXT NOT NULL CHECK (state IN ('intent_recorded','ref_observed_old','ref_observed_candidate','conflicted','finalized')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  observed_oid TEXT ${OPTIONAL_OID("observed_oid")},
  observation_evidence_id TEXT,
  finalization_evidence_id TEXT,
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (ticket_instance_id, run_id) REFERENCES run_tickets(ticket_instance_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, ticket_instance_id, run_id) REFERENCES attempts(attempt_id, ticket_instance_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (oracle_decision_id, run_id, ticket_instance_id, attempt_id) REFERENCES oracle_decisions(oracle_decision_id, run_id, ticket_instance_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (commit_attribution_id, attempt_id) REFERENCES commit_attributions(commit_attribution_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (observation_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (finalization_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX promotion_intents_attempt_uq ON promotion_intents(attempt_id);
CREATE UNIQUE INDEX promotion_intents_ticket_inflight_uq ON promotion_intents(ticket_instance_id) WHERE state NOT IN ('finalized','conflicted');
CREATE UNIQUE INDEX promotion_intents_sequence_uq ON promotion_intents(run_id, promotion_sequence);
CREATE UNIQUE INDEX promotion_intents_idempotency_uq ON promotion_intents(run_id, idempotency_key);
CREATE UNIQUE INDEX promotion_intents_one_inflight_uq ON promotion_intents(run_id) WHERE state NOT IN ('finalized','conflicted');

CREATE TABLE delivery_intents (
  delivery_intent_id TEXT PRIMARY KEY ${ID("delivery_intent_id")},
  run_id TEXT NOT NULL ${ID("run_id")},
  delivery_oid TEXT NOT NULL ${OID("delivery_oid")},
  remote_name TEXT NOT NULL ${ID("remote_name")},
  branch_name TEXT NOT NULL ${ID("branch_name")},
  expected_remote_oid TEXT ${OPTIONAL_OID("expected_remote_oid")},
  base_branch TEXT NOT NULL ${ID("base_branch")},
  provider_identity_digest TEXT NOT NULL ${DIGEST("provider_identity_digest")},
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX delivery_intents_run_uq ON delivery_intents(run_id);
CREATE UNIQUE INDEX delivery_intents_idempotency_uq ON delivery_intents(run_id, idempotency_key);

CREATE TABLE remote_observations (
  remote_observation_id TEXT PRIMARY KEY ${ID("remote_observation_id")},
  delivery_intent_id TEXT NOT NULL ${ID("delivery_intent_id")},
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  operation TEXT NOT NULL ${ID("operation")},
  outcome TEXT NOT NULL ${ID("outcome")},
  observed_remote_oid TEXT ${OPTIONAL_OID("observed_remote_oid")},
  evidence_id TEXT NOT NULL ${ID("evidence_id")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (delivery_intent_id) REFERENCES delivery_intents(delivery_intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX remote_observations_sequence_uq ON remote_observations(delivery_intent_id, sequence);
CREATE UNIQUE INDEX remote_observations_identity_intent_uq ON remote_observations(remote_observation_id, delivery_intent_id);

CREATE TABLE pr_observations (
  pr_observation_id TEXT PRIMARY KEY ${ID("pr_observation_id")},
  delivery_intent_id TEXT NOT NULL ${ID("delivery_intent_id")},
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  provider_repository_id TEXT NOT NULL ${ID("provider_repository_id")},
  base_branch TEXT NOT NULL ${ID("base_branch")},
  head_branch TEXT NOT NULL ${ID("head_branch")},
  pr_identity TEXT NOT NULL ${ID("pr_identity")},
  observed_head_oid TEXT NOT NULL ${OID("observed_head_oid")},
  evidence_id TEXT NOT NULL ${ID("evidence_id")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (delivery_intent_id) REFERENCES delivery_intents(delivery_intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX pr_observations_sequence_uq ON pr_observations(delivery_intent_id, sequence);
CREATE UNIQUE INDEX pr_observations_identity_uq ON pr_observations(provider_repository_id, pr_identity, sequence);
CREATE UNIQUE INDEX pr_observations_identity_intent_uq ON pr_observations(pr_observation_id, delivery_intent_id);

CREATE TABLE delivery_records (
  delivery_record_id TEXT PRIMARY KEY ${ID("delivery_record_id")},
  delivery_intent_id TEXT NOT NULL ${ID("delivery_intent_id")},
  terminal_from_state TEXT NOT NULL CHECK (terminal_from_state IN ('intent_recorded','remote_observed','pr_observed')),
  remote_observation_id TEXT,
  pr_observation_id TEXT,
  decision_evidence_id TEXT NOT NULL ${ID("decision_evidence_id")},
  cleanup_evidence_id TEXT NOT NULL ${ID("cleanup_evidence_id")},
  delivery_oid TEXT NOT NULL ${OID("delivery_oid")},
  decision TEXT NOT NULL CHECK (decision IN ('delivered','delivery_failed')),
  output_digest TEXT NOT NULL ${DIGEST("output_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (delivery_intent_id) REFERENCES delivery_intents(delivery_intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (remote_observation_id, delivery_intent_id) REFERENCES remote_observations(remote_observation_id, delivery_intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (pr_observation_id, delivery_intent_id) REFERENCES pr_observations(pr_observation_id, delivery_intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (decision_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  FOREIGN KEY (cleanup_evidence_id) REFERENCES evidence(evidence_id) ON DELETE RESTRICT,
  CHECK ((decision = 'delivered' AND terminal_from_state = 'pr_observed' AND remote_observation_id IS NOT NULL AND pr_observation_id IS NOT NULL) OR
         (decision = 'delivery_failed' AND ((terminal_from_state = 'intent_recorded' AND remote_observation_id IS NULL AND pr_observation_id IS NULL) OR
                                            (terminal_from_state = 'remote_observed' AND remote_observation_id IS NOT NULL AND pr_observation_id IS NULL) OR
                                            (terminal_from_state = 'pr_observed' AND remote_observation_id IS NOT NULL AND pr_observation_id IS NOT NULL))))
) STRICT;
CREATE UNIQUE INDEX delivery_records_intent_uq ON delivery_records(delivery_intent_id);

CREATE TABLE legacy_artifacts (
  legacy_artifact_id TEXT PRIMARY KEY ${ID("legacy_artifact_id")},
  repository_id TEXT NOT NULL ${ID("repository_id")},
  kind TEXT NOT NULL ${ID("kind")},
  bounded_path_identity TEXT NOT NULL ${ID("bounded_path_identity")},
  stat_digest TEXT ${OPTIONAL_DIGEST("stat_digest")},
  content_digest TEXT ${OPTIONAL_DIGEST("content_digest")},
  discovered_at TEXT NOT NULL ${UTC("discovered_at")},
  disposition TEXT NOT NULL ${ID("disposition")},
  FOREIGN KEY (repository_id) REFERENCES repositories(repository_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX legacy_artifacts_identity_uq ON legacy_artifacts(repository_id, kind, bounded_path_identity);
`;

const APPEND_ONLY_TABLES = [
  "schema_migrations", "repositories", "run_manifests", "ticket_contracts",
  "run_ticket_dependencies", "execution_contexts", "phase_executions", "evidence",
  "state_transitions", "transition_evidence_refs", "process_receipts", "gate_results",
  "review_records", "remediation_records", "commit_attributions", "salvage_records",
  "cleanup_records", "oracle_decisions", "oracle_input_references", "delivery_intents",
  "remote_observations", "pr_observations", "delivery_records", "legacy_artifacts",
] as const;

const SNAPSHOT_IDENTITIES = {
  runs: ["run_id", "repository_id", "run_sequence", "manifest_digest", "initial_delivery_oid", "delivery_ref", "created_at"],
  run_tickets: ["ticket_instance_id", "run_id", "ticket_id", "plan_index", "contract_digest", "created_at"],
  attempts: ["attempt_id", "ticket_instance_id", "run_id", "ticket_id", "attempt_number", "contract_digest", "allocation_owner_digest", "delivery_baseline_oid", "context_schema_version", "oracle_version", "capability_snapshot_digest", "resource_identity_version", "created_at"],
  leases: ["lease_id", "attempt_id", "generation", "owner_token_digest", "owner_context_id", "acquisition_evidence_id", "created_at"],
  attempt_resources: ["resource_id", "attempt_id", "slot", "kind", "canonical_identity", "identity_digest", "allocation_lease_id", "allocation_evidence_id", "created_at"],
  promotion_intents: ["promotion_intent_id", "run_id", "ticket_instance_id", "attempt_id", "promotion_sequence", "delivery_ref", "expected_old_oid", "candidate_oid", "oracle_decision_id", "commit_attribution_id", "owner_context_id", "idempotency_key", "created_at"],
} as const;

function appendOnlyTriggers(table: string): string {
  return `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`;
}

function snapshotTriggers(table: string, immutableColumns: readonly string[]): string {
  const immutableChange = immutableColumns.map((column) => `NEW.${column} IS NOT OLD.${column}`).join(" OR ");
  return `
CREATE TRIGGER ${table}_immutable_identity BEFORE UPDATE ON ${table}
WHEN ${immutableChange}
BEGIN SELECT RAISE(ABORT, '${table} identity is immutable'); END;
CREATE TRIGGER ${table}_state_version BEFORE UPDATE ON ${table}
WHEN NEW.state_version <> OLD.state_version + 1
BEGIN SELECT RAISE(ABORT, '${table} state_version must advance by one'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} cannot be deleted'); END;`;
}

const LEGAL_STATE_TRIGGERS = `
CREATE TRIGGER runs_legal_edge BEFORE UPDATE OF state ON runs
WHEN NOT ((OLD.state = 'planned' AND NEW.state = 'active') OR
          (OLD.state = 'active' AND NEW.state IN ('cleanup_pending','failed','ready_for_delivery')) OR
          (OLD.state = 'cleanup_pending' AND NEW.state IN ('active','failed')) OR
          (OLD.state = 'ready_for_delivery' AND NEW.state IN ('delivered','delivery_failed')))
BEGIN SELECT RAISE(ABORT, 'illegal run state transition'); END;
CREATE TRIGGER run_tickets_legal_edge BEFORE UPDATE OF state ON run_tickets
WHEN NOT ((OLD.state = 'planned' AND NEW.state = 'active') OR
          (OLD.state = 'active' AND NEW.state = 'cleanup_pending') OR
          (OLD.state = 'cleanup_pending' AND NEW.state IN ('active','failed','quarantined','ready_for_delivery')))
BEGIN SELECT RAISE(ABORT, 'illegal ticket state transition'); END;
CREATE TRIGGER attempts_legal_edge BEFORE UPDATE OF state ON attempts
WHEN NOT ((OLD.state = 'planned' AND NEW.state = 'implementing') OR
          (OLD.state = 'implementing' AND NEW.state = 'implementation_captured') OR
          (OLD.state = 'implementation_captured' AND NEW.state = 'reviewing') OR
          (OLD.state = 'reviewing' AND NEW.state IN ('verification_queued','remediating')) OR
          (OLD.state = 'remediating' AND NEW.state = 'remediation_captured') OR
          (OLD.state = 'remediation_captured' AND NEW.state = 'reviewing') OR
          (OLD.state = 'verification_queued' AND NEW.state = 'verifying') OR
          (OLD.state = 'verifying' AND NEW.state = 'converging') OR
          (OLD.state = 'converging' AND NEW.state = 'cleanup_pending') OR
          (OLD.state = 'cleanup_pending' AND NEW.state IN ('oracle_evaluation','failed_clean','quarantined')) OR
          (OLD.state = 'oracle_evaluation' AND NEW.state = 'verified'))
BEGIN SELECT RAISE(ABORT, 'illegal attempt state transition'); END;
CREATE TRIGGER leases_legal_edge BEFORE UPDATE OF state ON leases
WHEN NOT ((OLD.state = 'reserved' AND NEW.state = 'live') OR
          (OLD.state = 'live' AND NEW.state = 'cleanup_pending') OR
          (OLD.state = 'cleanup_pending' AND NEW.state IN ('released','quarantined')))
BEGIN SELECT RAISE(ABORT, 'illegal lease state transition'); END;
CREATE TRIGGER attempt_resources_legal_edge BEFORE UPDATE OF state ON attempt_resources
WHEN NOT ((OLD.state = 'reserved' AND NEW.state = 'allocated') OR
          (OLD.state = 'allocated' AND NEW.state IN ('active','cleanup_pending')) OR
          (OLD.state = 'active' AND NEW.state = 'cleanup_pending') OR
          (OLD.state = 'cleanup_pending' AND NEW.state IN ('released','quarantined')))
BEGIN SELECT RAISE(ABORT, 'illegal resource state transition'); END;
CREATE TRIGGER promotion_intents_legal_edge BEFORE UPDATE OF state ON promotion_intents
WHEN NOT ((OLD.state = 'intent_recorded' AND NEW.state IN ('ref_observed_old','ref_observed_candidate','conflicted')) OR
          (OLD.state = 'ref_observed_old' AND NEW.state IN ('ref_observed_candidate','conflicted')) OR
          (OLD.state = 'ref_observed_candidate' AND NEW.state IN ('finalized','conflicted')))
BEGIN SELECT RAISE(ABORT, 'illegal promotion state transition'); END;
`;

const INITIAL_SQL = [
  BASE_SQL.trim(),
  ...APPEND_ONLY_TABLES.map(appendOnlyTriggers),
  ...Object.entries(SNAPSHOT_IDENTITIES).map(([table, columns]) => snapshotTriggers(table, columns)),
  LEGAL_STATE_TRIGGERS.trim(),
].join("\n") + "\n";

/*
 * Migration 002 deliberately adds a new ownership aggregate instead of
 * rewriting the released v1 lease tables. The v1 tables bind ownership to a
 * materialized execution_context, which cannot exist before the resource and
 * policy side effects that ownership must guard. These tables make the
 * pre-side-effect identity explicit while preserving every released v1 row.
 */
const ATTEMPT_OWNERSHIP_SQL = `
CREATE TABLE attempt_ownership_leases (
  ownership_id TEXT PRIMARY KEY ${ID("ownership_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  generation INTEGER NOT NULL CHECK (generation > 0),
  owner_token_digest TEXT NOT NULL ${DIGEST("owner_token_digest")},
  context_digest TEXT NOT NULL ${DIGEST("context_digest")},
  canonical_context_json TEXT NOT NULL ${JSON_OBJECT("canonical_context_json")},
  recovered_from_ownership_id TEXT,
  heartbeat_at TEXT NOT NULL ${UTC("heartbeat_at")},
  expires_at TEXT NOT NULL ${UTC("expires_at")},
  state TEXT NOT NULL CHECK (state IN ('live','cleanup_pending','released','quarantined')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (recovered_from_ownership_id) REFERENCES attempt_ownership_leases(ownership_id) ON DELETE RESTRICT,
  CHECK (expires_at > heartbeat_at),
  CHECK ((generation = 1 AND recovered_from_ownership_id IS NULL) OR
         (generation > 1 AND recovered_from_ownership_id IS NOT NULL)),
  CHECK ((state = 'live' AND recovered_from_ownership_id IS NULL) OR
         (state <> 'live'))
) STRICT;
CREATE UNIQUE INDEX attempt_ownership_leases_attempt_generation_uq
  ON attempt_ownership_leases(attempt_id, generation);
CREATE UNIQUE INDEX attempt_ownership_leases_context_uq
  ON attempt_ownership_leases(context_digest);
CREATE UNIQUE INDEX attempt_ownership_leases_one_current_uq
  ON attempt_ownership_leases(attempt_id) WHERE state IN ('live','cleanup_pending');
CREATE UNIQUE INDEX attempt_ownership_leases_identity_attempt_uq
  ON attempt_ownership_leases(ownership_id, attempt_id);
CREATE UNIQUE INDEX attempt_ownership_leases_identity_attempt_generation_uq
  ON attempt_ownership_leases(ownership_id, attempt_id, generation);

CREATE TABLE attempt_resource_claims (
  resource_claim_id TEXT PRIMARY KEY ${ID("resource_claim_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  slot TEXT NOT NULL ${ID("slot")},
  kind TEXT NOT NULL CHECK (kind IN ('delivery_ref','attempt_ref','worktree','isolated_index','policy_context','policy_bundle','process_group','stdout','stderr','verification_output','salvage_archive')),
  canonical_identity TEXT NOT NULL ${ID("canonical_identity")},
  identity_digest TEXT NOT NULL ${DIGEST("identity_digest")},
  allocation_ownership_id TEXT NOT NULL ${ID("allocation_ownership_id")},
  current_ownership_id TEXT NOT NULL ${ID("current_ownership_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved','allocated','active','cleanup_pending','released','quarantined')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  release_proof_digest TEXT ${OPTIONAL_DIGEST("release_proof_digest")},
  quarantine_proof_digest TEXT ${OPTIONAL_DIGEST("quarantine_proof_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (allocation_ownership_id, attempt_id) REFERENCES attempt_ownership_leases(ownership_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_ownership_id, attempt_id) REFERENCES attempt_ownership_leases(ownership_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_ownership_id, attempt_id, owner_generation) REFERENCES attempt_ownership_leases(ownership_id, attempt_id, generation) ON DELETE RESTRICT,
  CHECK (slot = kind),
  CHECK ((state = 'released' AND release_proof_digest IS NOT NULL AND quarantine_proof_digest IS NULL) OR
         (state = 'quarantined' AND quarantine_proof_digest IS NOT NULL AND release_proof_digest IS NULL) OR
         (state NOT IN ('released','quarantined') AND release_proof_digest IS NULL AND quarantine_proof_digest IS NULL))
) STRICT;
CREATE UNIQUE INDEX attempt_resource_claims_slot_uq
  ON attempt_resource_claims(attempt_id, slot);
CREATE UNIQUE INDEX attempt_resource_claims_active_identity_uq
  ON attempt_resource_claims(kind, identity_digest)
  WHERE state IN ('reserved','allocated','active','cleanup_pending');
CREATE UNIQUE INDEX attempt_resource_claims_identity_attempt_uq
  ON attempt_resource_claims(resource_claim_id, attempt_id);

CREATE TABLE attempt_ownership_operations (
  operation_id TEXT PRIMARY KEY ${ID("operation_id")},
  ownership_id TEXT NOT NULL ${ID("ownership_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('acquire','heartbeat','advance_resource','begin_cleanup','release_resource','quarantine_resource','release','quarantine','stale_recovery')),
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  input_digest TEXT NOT NULL ${DIGEST("input_digest")},
  canonical_input_json TEXT NOT NULL ${JSON_OBJECT("canonical_input_json")},
  result_digest TEXT NOT NULL ${DIGEST("result_digest")},
  canonical_result_json TEXT NOT NULL ${JSON_OBJECT("canonical_result_json")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (ownership_id, attempt_id) REFERENCES attempt_ownership_leases(ownership_id, attempt_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX attempt_ownership_operations_attempt_idempotency_uq
  ON attempt_ownership_operations(attempt_id, idempotency_key);
CREATE UNIQUE INDEX attempt_ownership_operations_result_uq
  ON attempt_ownership_operations(operation_id, result_digest);

CREATE TRIGGER attempt_ownership_leases_immutable_identity BEFORE UPDATE ON attempt_ownership_leases
WHEN NEW.ownership_id IS NOT OLD.ownership_id OR
     NEW.attempt_id IS NOT OLD.attempt_id OR
     NEW.generation IS NOT OLD.generation OR
     NEW.owner_token_digest IS NOT OLD.owner_token_digest OR
     NEW.context_digest IS NOT OLD.context_digest OR
     NEW.canonical_context_json IS NOT OLD.canonical_context_json OR
     NEW.recovered_from_ownership_id IS NOT OLD.recovered_from_ownership_id OR
     NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'attempt ownership identity is immutable'); END;
CREATE TRIGGER attempt_ownership_leases_state_version BEFORE UPDATE ON attempt_ownership_leases
WHEN NEW.state_version <> OLD.state_version + 1
BEGIN SELECT RAISE(ABORT, 'attempt ownership state_version must advance by one'); END;
CREATE TRIGGER attempt_ownership_leases_legal_edge BEFORE UPDATE OF state ON attempt_ownership_leases
WHEN NOT ((OLD.state = 'live' AND NEW.state IN ('cleanup_pending','quarantined')) OR
          (OLD.state = 'cleanup_pending' AND NEW.state IN ('released','quarantined')))
BEGIN SELECT RAISE(ABORT, 'illegal attempt ownership state transition'); END;
CREATE TRIGGER attempt_ownership_leases_no_delete BEFORE DELETE ON attempt_ownership_leases
BEGIN SELECT RAISE(ABORT, 'attempt ownership cannot be deleted'); END;

CREATE TRIGGER attempt_resource_claims_immutable_identity BEFORE UPDATE ON attempt_resource_claims
WHEN NEW.resource_claim_id IS NOT OLD.resource_claim_id OR
     NEW.attempt_id IS NOT OLD.attempt_id OR
     NEW.slot IS NOT OLD.slot OR
     NEW.kind IS NOT OLD.kind OR
     NEW.canonical_identity IS NOT OLD.canonical_identity OR
     NEW.identity_digest IS NOT OLD.identity_digest OR
     NEW.allocation_ownership_id IS NOT OLD.allocation_ownership_id OR
     NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'attempt resource claim identity is immutable'); END;
CREATE TRIGGER attempt_resource_claims_state_version BEFORE UPDATE ON attempt_resource_claims
WHEN NEW.state_version <> OLD.state_version + 1
BEGIN SELECT RAISE(ABORT, 'attempt resource claim state_version must advance by one'); END;
CREATE TRIGGER attempt_resource_claims_legal_edge BEFORE UPDATE OF state ON attempt_resource_claims
WHEN NOT ((OLD.state = 'reserved' AND NEW.state IN ('allocated','cleanup_pending','quarantined')) OR
          (OLD.state = 'allocated' AND NEW.state IN ('active','cleanup_pending','quarantined')) OR
          (OLD.state = 'active' AND NEW.state IN ('cleanup_pending','quarantined')) OR
          (OLD.state = 'cleanup_pending' AND NEW.state IN ('released','quarantined')))
BEGIN SELECT RAISE(ABORT, 'illegal attempt resource claim state transition'); END;
CREATE TRIGGER attempt_resource_claims_no_delete BEFORE DELETE ON attempt_resource_claims
BEGIN SELECT RAISE(ABORT, 'attempt resource claim cannot be deleted'); END;

CREATE TRIGGER attempt_ownership_operations_no_update BEFORE UPDATE ON attempt_ownership_operations
BEGIN SELECT RAISE(ABORT, 'attempt ownership operations are append-only'); END;
CREATE TRIGGER attempt_ownership_operations_no_delete BEFORE DELETE ON attempt_ownership_operations
BEGIN SELECT RAISE(ABORT, 'attempt ownership operations are append-only'); END;
`;

/*
 * Migration 003 is the durable ProcessSupervisor substrate. It deliberately
 * does not extend the released v1 process_receipts table: that table is tied
 * to the legacy leases aggregate and cannot represent a launch-first,
 * append-only lifecycle. The new launch is the immutable pre-exec identity,
 * observations are its ordered evidence chain, and one terminal receipt seals
 * the chain. Ownership and execution-context digests remain separate facts.
 */
const PROCESS_SUPERVISION_SQL = `
CREATE TABLE attempt_process_launches (
  launch_id TEXT PRIMARY KEY ${ID("launch_id")},
  process_receipt_id TEXT NOT NULL ${ID("process_receipt_id")},
  repository_id TEXT NOT NULL ${ID("repository_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  ownership_id TEXT NOT NULL ${ID("ownership_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  ownership_context_digest TEXT NOT NULL ${DIGEST("ownership_context_digest")},
  phase_execution_id TEXT NOT NULL ${ID("phase_execution_id")},
  context_id TEXT NOT NULL ${ID("context_id")},
  execution_context_digest TEXT NOT NULL ${DIGEST("execution_context_digest")},
  spawn_authorization_digest TEXT NOT NULL ${DIGEST("spawn_authorization_digest")},
  pid INTEGER NOT NULL CHECK (pid > 0),
  pgid INTEGER NOT NULL CHECK (pgid > 0),
  platform TEXT NOT NULL ${ID("platform")},
  boot_identity TEXT NOT NULL ${ID("boot_identity")},
  process_start_identity TEXT NOT NULL ${ID("process_start_identity")},
  argv_digest TEXT NOT NULL ${DIGEST("argv_digest")},
  environment_digest TEXT NOT NULL ${DIGEST("environment_digest")},
  stdout_path TEXT NOT NULL ${ID("stdout_path")},
  stderr_path TEXT NOT NULL ${ID("stderr_path")},
  output_limit_bytes INTEGER NOT NULL CHECK (output_limit_bytes > 0),
  tail_limit_bytes INTEGER NOT NULL CHECK (tail_limit_bytes > 0 AND tail_limit_bytes <= output_limit_bytes),
  process_group_expected_version INTEGER NOT NULL CHECK (process_group_expected_version >= 0),
  stdout_expected_version INTEGER NOT NULL CHECK (stdout_expected_version >= 0),
  stderr_expected_version INTEGER NOT NULL CHECK (stderr_expected_version >= 0),
  launch_evidence_id TEXT NOT NULL ${ID("launch_evidence_id")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (repository_id) REFERENCES repositories(repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (ownership_id, attempt_id, owner_generation)
    REFERENCES attempt_ownership_leases(ownership_id, attempt_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY (phase_execution_id, attempt_id)
    REFERENCES phase_executions(phase_execution_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id)
    REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (phase_execution_id, context_id)
    REFERENCES phase_executions(phase_execution_id, context_id) ON DELETE RESTRICT,
  FOREIGN KEY (launch_evidence_id, attempt_id)
    REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX attempt_process_launches_receipt_uq
  ON attempt_process_launches(process_receipt_id);
CREATE UNIQUE INDEX attempt_process_launches_phase_uq
  ON attempt_process_launches(phase_execution_id);
CREATE UNIQUE INDEX attempt_process_launches_identity_attempt_uq
  ON attempt_process_launches(launch_id, attempt_id);
CREATE UNIQUE INDEX attempt_process_launches_receipt_chain_uq
  ON attempt_process_launches(process_receipt_id, launch_id, attempt_id);

CREATE TABLE attempt_process_observations (
  observation_id TEXT PRIMARY KEY ${ID("observation_id")},
  launch_id TEXT NOT NULL ${ID("launch_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  kind TEXT NOT NULL ${ID("kind")},
  evidence_id TEXT NOT NULL ${ID("evidence_id")},
  schema_version TEXT NOT NULL ${ID("schema_version")},
  payload_digest TEXT NOT NULL ${DIGEST("payload_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (launch_id, attempt_id)
    REFERENCES attempt_process_launches(launch_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id, attempt_id)
    REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK (kind <> 'group_death' OR schema_version = 'rickgent.process-group-death.v1')
) STRICT;
CREATE UNIQUE INDEX attempt_process_observations_sequence_uq
  ON attempt_process_observations(launch_id, sequence);
CREATE UNIQUE INDEX attempt_process_observations_evidence_uq
  ON attempt_process_observations(evidence_id);
CREATE UNIQUE INDEX attempt_process_observations_identity_launch_uq
  ON attempt_process_observations(observation_id, launch_id);

CREATE TABLE attempt_process_terminal_receipts (
  process_receipt_id TEXT PRIMARY KEY ${ID("process_receipt_id")},
  launch_id TEXT NOT NULL ${ID("launch_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  outcome TEXT NOT NULL ${ID("outcome")},
  exit_code INTEGER,
  signal TEXT,
  timed_out INTEGER NOT NULL CHECK (timed_out IN (0,1)),
  group_dead INTEGER NOT NULL CHECK (group_dead IN (0,1)),
  descendants_confirmed_dead INTEGER NOT NULL CHECK (descendants_confirmed_dead IN (0,1)),
  observation_count INTEGER NOT NULL CHECK (observation_count > 0),
  result_digest TEXT NOT NULL ${DIGEST("result_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (process_receipt_id, launch_id, attempt_id)
    REFERENCES attempt_process_launches(process_receipt_id, launch_id, attempt_id) ON DELETE RESTRICT,
  CHECK (exit_code IS NULL OR exit_code >= 0),
  CHECK (signal IS NULL OR length(signal) > 0),
  CHECK (descendants_confirmed_dead <= group_dead)
) STRICT;
CREATE UNIQUE INDEX attempt_process_terminal_receipts_launch_uq
  ON attempt_process_terminal_receipts(launch_id);

CREATE TRIGGER attempt_process_launches_evidence_lineage BEFORE INSERT ON attempt_process_launches
WHEN NOT EXISTS (
  SELECT 1 FROM evidence e
  WHERE e.evidence_id = NEW.launch_evidence_id
    AND e.attempt_id = NEW.attempt_id
    AND e.phase_execution_id = NEW.phase_execution_id
    AND e.context_id = NEW.context_id
    AND e.producer_service = 'ProcessSupervisor'
    AND e.schema_version = 'rickgent.process-launch.v1'
)
BEGIN SELECT RAISE(ABORT, 'process launch evidence lineage is invalid'); END;

CREATE TRIGGER attempt_process_observations_evidence_lineage BEFORE INSERT ON attempt_process_observations
WHEN NOT EXISTS (
  SELECT 1
  FROM evidence e
  JOIN attempt_process_launches l ON l.launch_id = NEW.launch_id
  WHERE e.evidence_id = NEW.evidence_id
    AND e.attempt_id = NEW.attempt_id
    AND e.phase_execution_id = l.phase_execution_id
    AND e.context_id = l.context_id
    AND e.producer_service = 'ProcessSupervisor'
    AND e.schema_version = NEW.schema_version
    AND e.content_digest = NEW.payload_digest
)
BEGIN SELECT RAISE(ABORT, 'process observation evidence lineage is invalid'); END;

CREATE TRIGGER attempt_process_terminal_receipts_complete_chain BEFORE INSERT ON attempt_process_terminal_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM attempt_process_observations o
  WHERE o.launch_id = NEW.launch_id
  GROUP BY o.launch_id
  HAVING COUNT(*) = NEW.observation_count
     AND MIN(o.sequence) = 1
     AND MAX(o.sequence) = NEW.observation_count
)
BEGIN SELECT RAISE(ABORT, 'process terminal receipt requires a contiguous observation chain'); END;

CREATE TRIGGER attempt_process_terminal_receipts_death_claim BEFORE INSERT ON attempt_process_terminal_receipts
WHEN NEW.group_dead = 1 AND NOT EXISTS (
  SELECT 1 FROM attempt_process_observations o
  WHERE o.launch_id = NEW.launch_id AND o.kind = 'group_death'
)
BEGIN SELECT RAISE(ABORT, 'process terminal death claim lacks group-death evidence'); END;

CREATE TRIGGER attempt_process_observations_no_after_terminal BEFORE INSERT ON attempt_process_observations
WHEN EXISTS (SELECT 1 FROM attempt_process_terminal_receipts t WHERE t.launch_id = NEW.launch_id)
BEGIN SELECT RAISE(ABORT, 'process observation chain is terminal'); END;

${appendOnlyTriggers("attempt_process_launches")}
${appendOnlyTriggers("attempt_process_observations")}
${appendOnlyTriggers("attempt_process_terminal_receipts")}
`;

/*
 * Migration 004 is the durable CommitService intent/finalization bridge. The
 * released v1 commit_attributions table remains the stable oracle/promotion
 * summary; this CAS aggregate proves that the summary came from the sole Git
 * mutation authority and pins the exact owner, phase, process, resources, refs,
 * normalized delta, deterministic metadata, and command observations.
 */
const COMMIT_ATTRIBUTION_SQL = `
CREATE TABLE attempt_commit_intents (
  commit_intent_id TEXT PRIMARY KEY ${ID("commit_intent_id")},
  repository_id TEXT NOT NULL ${ID("repository_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  ownership_id TEXT NOT NULL ${ID("ownership_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  ownership_state_version INTEGER NOT NULL CHECK (ownership_state_version >= 0),
  ownership_context_digest TEXT NOT NULL ${DIGEST("ownership_context_digest")},
  phase_execution_id TEXT NOT NULL ${ID("phase_execution_id")},
  context_id TEXT NOT NULL ${ID("context_id")},
  execution_context_digest TEXT NOT NULL ${DIGEST("execution_context_digest")},
  launch_id TEXT NOT NULL ${ID("launch_id")},
  process_receipt_id TEXT NOT NULL ${ID("process_receipt_id")},
  delivery_ref TEXT NOT NULL ${ID("delivery_ref")},
  attempt_ref TEXT NOT NULL ${ID("attempt_ref")},
  baseline_oid TEXT NOT NULL ${OID("baseline_oid")},
  contract_digest TEXT NOT NULL ${DIGEST("contract_digest")},
  delivery_ref_claim_id TEXT NOT NULL ${ID("delivery_ref_claim_id")},
  delivery_ref_expected_version INTEGER NOT NULL CHECK (delivery_ref_expected_version >= 0),
  attempt_ref_claim_id TEXT NOT NULL ${ID("attempt_ref_claim_id")},
  attempt_ref_expected_version INTEGER NOT NULL CHECK (attempt_ref_expected_version >= 0),
  worktree_claim_id TEXT NOT NULL ${ID("worktree_claim_id")},
  worktree_expected_version INTEGER NOT NULL CHECK (worktree_expected_version >= 0),
  isolated_index_claim_id TEXT NOT NULL ${ID("isolated_index_claim_id")},
  isolated_index_expected_version INTEGER NOT NULL CHECK (isolated_index_expected_version >= 0),
  tree_before_oid TEXT NOT NULL ${OID("tree_before_oid")},
  tree_after_oid TEXT NOT NULL ${OID("tree_after_oid")},
  candidate_diff_digest TEXT NOT NULL ${DIGEST("candidate_diff_digest")},
  path_set_digest TEXT NOT NULL ${DIGEST("path_set_digest")},
  change_kind_set_digest TEXT NOT NULL ${DIGEST("change_kind_set_digest")},
  mode_set_digest TEXT NOT NULL ${DIGEST("mode_set_digest")},
  normalized_delta_json TEXT NOT NULL ${JSON_ARRAY("normalized_delta_json")},
  verification_receipt_digests_json TEXT NOT NULL ${JSON_ARRAY("verification_receipt_digests_json")},
  commit_metadata_json TEXT NOT NULL ${JSON_OBJECT("commit_metadata_json")},
  input_digest TEXT NOT NULL ${DIGEST("input_digest")},
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  state TEXT NOT NULL CHECK (state IN ('intent_recorded','finalized')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  commit_attribution_id TEXT,
  commit_oid TEXT ${OPTIONAL_OID("commit_oid")},
  delivery_ref_observed_oid TEXT ${OPTIONAL_OID("delivery_ref_observed_oid")},
  attempt_ref_before_oid TEXT ${OPTIONAL_OID("attempt_ref_before_oid")},
  attempt_ref_after_oid TEXT ${OPTIONAL_OID("attempt_ref_after_oid")},
  command_receipts_json TEXT ${OPTIONAL_JSON_ARRAY("command_receipts_json")},
  result_digest TEXT ${OPTIONAL_DIGEST("result_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  finalized_at TEXT CHECK (finalized_at IS NULL OR (length(finalized_at) >= 20 AND substr(finalized_at, -1) = 'Z')),
  FOREIGN KEY (repository_id) REFERENCES repositories(repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, contract_digest) REFERENCES attempts(attempt_id, contract_digest) ON DELETE RESTRICT,
  FOREIGN KEY (ownership_id, attempt_id, owner_generation)
    REFERENCES attempt_ownership_leases(ownership_id, attempt_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY (phase_execution_id, attempt_id)
    REFERENCES phase_executions(phase_execution_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id)
    REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (phase_execution_id, context_id)
    REFERENCES phase_executions(phase_execution_id, context_id) ON DELETE RESTRICT,
  FOREIGN KEY (process_receipt_id)
    REFERENCES attempt_process_terminal_receipts(process_receipt_id) ON DELETE RESTRICT,
  FOREIGN KEY (process_receipt_id, launch_id, attempt_id)
    REFERENCES attempt_process_launches(process_receipt_id, launch_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (delivery_ref_claim_id, attempt_id)
    REFERENCES attempt_resource_claims(resource_claim_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_ref_claim_id, attempt_id)
    REFERENCES attempt_resource_claims(resource_claim_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (worktree_claim_id, attempt_id)
    REFERENCES attempt_resource_claims(resource_claim_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (isolated_index_claim_id, attempt_id)
    REFERENCES attempt_resource_claims(resource_claim_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (commit_attribution_id, attempt_id)
    REFERENCES commit_attributions(commit_attribution_id, attempt_id) ON DELETE RESTRICT,
  CHECK (json_array_length(normalized_delta_json) > 0),
  CHECK (json_array_length(verification_receipt_digests_json) > 0),
  CHECK ((state = 'intent_recorded' AND state_version = 0 AND commit_attribution_id IS NULL AND commit_oid IS NULL AND
         delivery_ref_observed_oid IS NULL AND attempt_ref_before_oid IS NULL AND attempt_ref_after_oid IS NULL AND
         command_receipts_json IS NULL AND result_digest IS NULL AND finalized_at IS NULL) OR
         (state = 'finalized' AND state_version = 1 AND commit_attribution_id IS NOT NULL AND commit_oid IS NOT NULL AND
         delivery_ref_observed_oid IS NOT NULL AND attempt_ref_before_oid IS NOT NULL AND attempt_ref_after_oid IS NOT NULL AND
         command_receipts_json IS NOT NULL AND json_array_length(command_receipts_json) > 0 AND result_digest IS NOT NULL AND finalized_at IS NOT NULL)),
  CHECK (state <> 'finalized' OR (delivery_ref_observed_oid = baseline_oid AND attempt_ref_before_oid = baseline_oid AND attempt_ref_after_oid = commit_oid))
) STRICT;
CREATE UNIQUE INDEX attempt_commit_intents_attempt_uq
  ON attempt_commit_intents(attempt_id);
CREATE UNIQUE INDEX attempt_commit_intents_idempotency_uq
  ON attempt_commit_intents(attempt_id, idempotency_key);
CREATE UNIQUE INDEX attempt_commit_intents_attribution_uq
  ON attempt_commit_intents(commit_attribution_id) WHERE commit_attribution_id IS NOT NULL;
CREATE UNIQUE INDEX attempt_commit_intents_commit_uq
  ON attempt_commit_intents(commit_oid) WHERE commit_oid IS NOT NULL;

CREATE TRIGGER attempt_commit_intents_immutable_preimage BEFORE UPDATE ON attempt_commit_intents
WHEN NEW.commit_intent_id IS NOT OLD.commit_intent_id OR
     NEW.repository_id IS NOT OLD.repository_id OR
     NEW.attempt_id IS NOT OLD.attempt_id OR
     NEW.ownership_id IS NOT OLD.ownership_id OR
     NEW.owner_generation IS NOT OLD.owner_generation OR
     NEW.ownership_state_version IS NOT OLD.ownership_state_version OR
     NEW.ownership_context_digest IS NOT OLD.ownership_context_digest OR
     NEW.phase_execution_id IS NOT OLD.phase_execution_id OR
     NEW.context_id IS NOT OLD.context_id OR
     NEW.execution_context_digest IS NOT OLD.execution_context_digest OR
     NEW.launch_id IS NOT OLD.launch_id OR
     NEW.process_receipt_id IS NOT OLD.process_receipt_id OR
     NEW.delivery_ref IS NOT OLD.delivery_ref OR
     NEW.attempt_ref IS NOT OLD.attempt_ref OR
     NEW.baseline_oid IS NOT OLD.baseline_oid OR
     NEW.contract_digest IS NOT OLD.contract_digest OR
     NEW.delivery_ref_claim_id IS NOT OLD.delivery_ref_claim_id OR
     NEW.delivery_ref_expected_version IS NOT OLD.delivery_ref_expected_version OR
     NEW.attempt_ref_claim_id IS NOT OLD.attempt_ref_claim_id OR
     NEW.attempt_ref_expected_version IS NOT OLD.attempt_ref_expected_version OR
     NEW.worktree_claim_id IS NOT OLD.worktree_claim_id OR
     NEW.worktree_expected_version IS NOT OLD.worktree_expected_version OR
     NEW.isolated_index_claim_id IS NOT OLD.isolated_index_claim_id OR
     NEW.isolated_index_expected_version IS NOT OLD.isolated_index_expected_version OR
     NEW.tree_before_oid IS NOT OLD.tree_before_oid OR
     NEW.tree_after_oid IS NOT OLD.tree_after_oid OR
     NEW.candidate_diff_digest IS NOT OLD.candidate_diff_digest OR
     NEW.path_set_digest IS NOT OLD.path_set_digest OR
     NEW.change_kind_set_digest IS NOT OLD.change_kind_set_digest OR
     NEW.mode_set_digest IS NOT OLD.mode_set_digest OR
     NEW.normalized_delta_json IS NOT OLD.normalized_delta_json OR
     NEW.verification_receipt_digests_json IS NOT OLD.verification_receipt_digests_json OR
     NEW.commit_metadata_json IS NOT OLD.commit_metadata_json OR
     NEW.input_digest IS NOT OLD.input_digest OR
     NEW.idempotency_key IS NOT OLD.idempotency_key OR
     NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'attempt commit intent preimage is immutable'); END;
CREATE TRIGGER attempt_commit_intents_legal_finalize BEFORE UPDATE ON attempt_commit_intents
WHEN OLD.state <> 'intent_recorded' OR NEW.state <> 'finalized' OR NEW.state_version <> OLD.state_version + 1
BEGIN SELECT RAISE(ABORT, 'illegal attempt commit intent transition'); END;
CREATE TRIGGER attempt_commit_intents_no_delete BEFORE DELETE ON attempt_commit_intents
BEGIN SELECT RAISE(ABORT, 'attempt commit intents cannot be deleted'); END;
`;

/*
 * Migration 005 separates nonterminal oracle eligibility from the three
 * terminal cleanup meanings. Target release is a CAS gate so absence of a
 * launch is never treated as proof that user code did not run.
 */
const ATTEMPT_CLEANUP_PROOF_SQL = `
CREATE UNIQUE INDEX attempt_commit_intents_identity_attempt_uq
  ON attempt_commit_intents(commit_intent_id, attempt_id);
CREATE UNIQUE INDEX attempt_process_terminal_receipts_identity_attempt_uq
  ON attempt_process_terminal_receipts(process_receipt_id, attempt_id);
CREATE UNIQUE INDEX salvage_records_identity_attempt_uq
  ON salvage_records(salvage_record_id, attempt_id);
CREATE UNIQUE INDEX promotion_intents_identity_attempt_uq
  ON promotion_intents(promotion_intent_id, attempt_id);
CREATE UNIQUE INDEX oracle_decisions_identity_attempt_uq
  ON oracle_decisions(oracle_decision_id, attempt_id);
CREATE UNIQUE INDEX attempt_process_launches_target_proof_uq
  ON attempt_process_launches(
    launch_id, process_receipt_id, attempt_id, ownership_id, owner_generation,
    phase_execution_id, context_id
  );
CREATE UNIQUE INDEX attempt_process_terminal_receipts_target_proof_uq
  ON attempt_process_terminal_receipts(
    process_receipt_id, launch_id, attempt_id, group_dead, descendants_confirmed_dead
  );
CREATE UNIQUE INDEX attempt_resource_claims_quarantine_snapshot_uq
  ON attempt_resource_claims(
    resource_claim_id, attempt_id, slot, kind, current_ownership_id,
    owner_generation, state, state_version
  );

CREATE TABLE target_start_gates (
  target_start_gate_id TEXT PRIMARY KEY ${ID("target_start_gate_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  ownership_id TEXT NOT NULL ${ID("ownership_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  phase_execution_id TEXT NOT NULL ${ID("phase_execution_id")},
  context_id TEXT NOT NULL ${ID("context_id")},
  execution_context_digest TEXT NOT NULL ${DIGEST("execution_context_digest")},
  start_authorization_digest TEXT NOT NULL ${DIGEST("start_authorization_digest")},
  state TEXT NOT NULL CHECK (state IN ('held','released','closed_never_released')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  release_evidence_id TEXT,
  never_released_evidence_id TEXT,
  input_digest TEXT NOT NULL ${DIGEST("input_digest")},
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (ownership_id, attempt_id, owner_generation)
    REFERENCES attempt_ownership_leases(ownership_id, attempt_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY (phase_execution_id, attempt_id)
    REFERENCES phase_executions(phase_execution_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id)
    REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (phase_execution_id, context_id)
    REFERENCES phase_executions(phase_execution_id, context_id) ON DELETE RESTRICT,
  FOREIGN KEY (release_evidence_id, attempt_id)
    REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (never_released_evidence_id, attempt_id)
    REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK ((state = 'held' AND state_version = 0 AND release_evidence_id IS NULL AND never_released_evidence_id IS NULL) OR
         (state = 'released' AND state_version = 1 AND release_evidence_id IS NOT NULL AND never_released_evidence_id IS NULL) OR
         (state = 'closed_never_released' AND state_version = 1 AND release_evidence_id IS NULL AND never_released_evidence_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX target_start_gates_phase_uq ON target_start_gates(phase_execution_id);
CREATE UNIQUE INDEX target_start_gates_attempt_idempotency_uq ON target_start_gates(attempt_id, idempotency_key);
CREATE UNIQUE INDEX target_start_gates_identity_attempt_uq ON target_start_gates(target_start_gate_id, attempt_id);
CREATE UNIQUE INDEX target_start_gates_proof_snapshot_uq
  ON target_start_gates(
    target_start_gate_id, attempt_id, ownership_id, owner_generation,
    phase_execution_id, context_id, state, state_version
  );

CREATE TABLE attempt_target_proof_sets (
  target_proof_set_id TEXT PRIMARY KEY ${ID("target_proof_set_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  ownership_id TEXT NOT NULL ${ID("ownership_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  ownership_context_digest TEXT NOT NULL ${DIGEST("ownership_context_digest")},
  target_count INTEGER NOT NULL CHECK (target_count >= 0),
  state TEXT NOT NULL CHECK (state IN ('collecting','sealed_complete','sealed_incomplete')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  proof_set_digest TEXT ${OPTIONAL_DIGEST("proof_set_digest")},
  evidence_id TEXT,
  input_digest TEXT NOT NULL ${DIGEST("input_digest")},
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  sealed_at TEXT CHECK (sealed_at IS NULL OR (length(sealed_at) >= 20 AND substr(sealed_at, -1) = 'Z')),
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (ownership_id, attempt_id, owner_generation)
    REFERENCES attempt_ownership_leases(ownership_id, attempt_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK ((state = 'collecting' AND state_version = 0 AND proof_set_digest IS NULL AND evidence_id IS NULL AND sealed_at IS NULL) OR
         (state IN ('sealed_complete','sealed_incomplete') AND state_version = 1 AND proof_set_digest IS NOT NULL AND evidence_id IS NOT NULL AND sealed_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX attempt_target_proof_sets_attempt_uq ON attempt_target_proof_sets(attempt_id);
CREATE UNIQUE INDEX attempt_target_proof_sets_attempt_idempotency_uq
  ON attempt_target_proof_sets(attempt_id, idempotency_key);
CREATE UNIQUE INDEX attempt_target_proof_sets_identity_owner_uq
  ON attempt_target_proof_sets(target_proof_set_id, attempt_id, ownership_id, owner_generation);
CREATE UNIQUE INDEX attempt_target_proof_sets_sealed_identity_uq
  ON attempt_target_proof_sets(
    target_proof_set_id, attempt_id, ownership_id, owner_generation, state,
    proof_set_digest, evidence_id, target_count
  );
CREATE UNIQUE INDEX attempt_target_proof_sets_sealed_attempt_uq
  ON attempt_target_proof_sets(
    target_proof_set_id, attempt_id, state, proof_set_digest, evidence_id, target_count
  );

CREATE TABLE attempt_target_proof_members (
  target_proof_set_id TEXT NOT NULL ${ID("target_proof_set_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  ownership_id TEXT NOT NULL ${ID("ownership_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  phase_execution_id TEXT NOT NULL ${ID("phase_execution_id")},
  context_id TEXT NOT NULL ${ID("context_id")},
  target_start_gate_id TEXT,
  gate_state TEXT CHECK (gate_state IS NULL OR gate_state IN ('held','released','closed_never_released')),
  gate_state_version INTEGER CHECK (gate_state_version IS NULL OR gate_state_version >= 0),
  gate_release_evidence_id TEXT,
  gate_never_released_evidence_id TEXT,
  proof_kind TEXT NOT NULL CHECK (proof_kind IN ('terminal_process','never_released','unproven')),
  launch_id TEXT,
  process_receipt_id TEXT,
  terminal_group_dead INTEGER CHECK (terminal_group_dead IS NULL OR terminal_group_dead = 1),
  terminal_descendants_confirmed_dead INTEGER CHECK (terminal_descendants_confirmed_dead IS NULL OR terminal_descendants_confirmed_dead = 1),
  group_death_evidence_id TEXT,
  unproven_evidence_id TEXT,
  member_digest TEXT NOT NULL ${DIGEST("member_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  PRIMARY KEY (target_proof_set_id, ordinal),
  UNIQUE (target_proof_set_id, phase_execution_id),
  UNIQUE (target_proof_set_id, target_start_gate_id),
  FOREIGN KEY (target_proof_set_id, attempt_id, ownership_id, owner_generation)
    REFERENCES attempt_target_proof_sets(target_proof_set_id, attempt_id, ownership_id, owner_generation) ON DELETE RESTRICT,
  FOREIGN KEY (phase_execution_id, attempt_id)
    REFERENCES phase_executions(phase_execution_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id)
    REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (phase_execution_id, context_id)
    REFERENCES phase_executions(phase_execution_id, context_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    target_start_gate_id, attempt_id, ownership_id, owner_generation,
    phase_execution_id, context_id, gate_state, gate_state_version
  ) REFERENCES target_start_gates(
    target_start_gate_id, attempt_id, ownership_id, owner_generation,
    phase_execution_id, context_id, state, state_version
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    launch_id, process_receipt_id, attempt_id, ownership_id, owner_generation,
    phase_execution_id, context_id
  ) REFERENCES attempt_process_launches(
    launch_id, process_receipt_id, attempt_id, ownership_id, owner_generation,
    phase_execution_id, context_id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    process_receipt_id, launch_id, attempt_id,
    terminal_group_dead, terminal_descendants_confirmed_dead
  ) REFERENCES attempt_process_terminal_receipts(
    process_receipt_id, launch_id, attempt_id, group_dead, descendants_confirmed_dead
  ) ON DELETE RESTRICT,
  FOREIGN KEY (gate_release_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (gate_never_released_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (group_death_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (unproven_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK ((target_start_gate_id IS NULL AND gate_state IS NULL AND gate_state_version IS NULL AND gate_release_evidence_id IS NULL AND gate_never_released_evidence_id IS NULL) OR
         (target_start_gate_id IS NOT NULL AND gate_state IS NOT NULL AND gate_state_version IS NOT NULL)),
  CHECK ((launch_id IS NULL AND process_receipt_id IS NULL) OR (launch_id IS NOT NULL AND process_receipt_id IS NOT NULL)),
  CHECK ((proof_kind = 'terminal_process' AND target_start_gate_id IS NOT NULL AND gate_state = 'released' AND
          gate_release_evidence_id IS NOT NULL AND gate_never_released_evidence_id IS NULL AND
          launch_id IS NOT NULL AND process_receipt_id IS NOT NULL AND terminal_group_dead = 1 AND
          terminal_descendants_confirmed_dead = 1 AND group_death_evidence_id IS NOT NULL AND unproven_evidence_id IS NULL) OR
         (proof_kind = 'never_released' AND target_start_gate_id IS NOT NULL AND gate_state = 'closed_never_released' AND
          gate_release_evidence_id IS NULL AND gate_never_released_evidence_id IS NOT NULL AND
          ((launch_id IS NULL AND process_receipt_id IS NULL AND terminal_group_dead IS NULL AND
            terminal_descendants_confirmed_dead IS NULL AND group_death_evidence_id IS NULL) OR
           (launch_id IS NOT NULL AND process_receipt_id IS NOT NULL AND terminal_group_dead = 1 AND
            terminal_descendants_confirmed_dead = 1 AND group_death_evidence_id IS NOT NULL)) AND
          unproven_evidence_id IS NULL) OR
         (proof_kind = 'unproven' AND (target_start_gate_id IS NOT NULL OR launch_id IS NOT NULL) AND
          terminal_group_dead IS NULL AND terminal_descendants_confirmed_dead IS NULL AND
          group_death_evidence_id IS NULL AND unproven_evidence_id IS NOT NULL))
) STRICT;

CREATE TABLE cleanup_eligibility_records (
  cleanup_eligibility_record_id TEXT PRIMARY KEY ${ID("cleanup_eligibility_record_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  ownership_id TEXT NOT NULL ${ID("ownership_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  ownership_state_version INTEGER NOT NULL CHECK (ownership_state_version >= 0),
  ownership_context_digest TEXT NOT NULL ${DIGEST("ownership_context_digest")},
  context_id TEXT NOT NULL ${ID("context_id")},
  commit_intent_id TEXT NOT NULL ${ID("commit_intent_id")},
  commit_attribution_id TEXT NOT NULL ${ID("commit_attribution_id")},
  candidate_oid TEXT NOT NULL ${OID("candidate_oid")},
  attempt_ref TEXT NOT NULL ${ID("attempt_ref")},
  attempt_ref_observed_oid TEXT NOT NULL ${OID("attempt_ref_observed_oid")},
  delivery_ref TEXT NOT NULL ${ID("delivery_ref")},
  delivery_baseline_oid TEXT NOT NULL ${OID("delivery_baseline_oid")},
  delivery_observed_oid TEXT NOT NULL ${OID("delivery_observed_oid")},
  target_proof_set_id TEXT NOT NULL ${ID("target_proof_set_id")},
  target_proof_set_state TEXT NOT NULL CHECK (target_proof_set_state = 'sealed_complete'),
  target_proof_set_digest TEXT NOT NULL ${DIGEST("target_proof_set_digest")},
  target_proof_set_evidence_id TEXT NOT NULL ${ID("target_proof_set_evidence_id")},
  target_proof_count INTEGER NOT NULL CHECK (target_proof_count > 0),
  ownership_snapshot_evidence_id TEXT NOT NULL ${ID("ownership_snapshot_evidence_id")},
  claim_snapshot_evidence_ids_json TEXT NOT NULL ${JSON_ARRAY("claim_snapshot_evidence_ids_json")},
  claim_snapshot_set_digest TEXT NOT NULL ${DIGEST("claim_snapshot_set_digest")},
  evidence_id TEXT NOT NULL ${ID("evidence_id")},
  input_digest TEXT NOT NULL ${DIGEST("input_digest")},
  record_digest TEXT NOT NULL ${DIGEST("record_digest")},
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (ownership_id, attempt_id, owner_generation)
    REFERENCES attempt_ownership_leases(ownership_id, attempt_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (commit_intent_id, attempt_id)
    REFERENCES attempt_commit_intents(commit_intent_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (commit_attribution_id, attempt_id)
    REFERENCES commit_attributions(commit_attribution_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    target_proof_set_id, attempt_id, target_proof_set_state,
    target_proof_set_digest, target_proof_set_evidence_id, target_proof_count
  ) REFERENCES attempt_target_proof_sets(
    target_proof_set_id, attempt_id, state, proof_set_digest, evidence_id, target_count
  ) ON DELETE RESTRICT,
  FOREIGN KEY (ownership_snapshot_evidence_id, attempt_id)
    REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK (candidate_oid = attempt_ref_observed_oid),
  CHECK (delivery_baseline_oid = delivery_observed_oid),
  CHECK (json_array_length(claim_snapshot_evidence_ids_json) = 11)
) STRICT;
CREATE UNIQUE INDEX cleanup_eligibility_records_attempt_uq ON cleanup_eligibility_records(attempt_id);
CREATE UNIQUE INDEX cleanup_eligibility_records_attempt_idempotency_uq
  ON cleanup_eligibility_records(attempt_id, idempotency_key);
CREATE UNIQUE INDEX cleanup_eligibility_records_digest_uq ON cleanup_eligibility_records(record_digest);
CREATE UNIQUE INDEX cleanup_eligibility_records_identity_attempt_uq
  ON cleanup_eligibility_records(cleanup_eligibility_record_id, attempt_id);

CREATE TABLE failure_cleanup_records (
  failure_cleanup_record_id TEXT PRIMARY KEY ${ID("failure_cleanup_record_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  ownership_id TEXT NOT NULL ${ID("ownership_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  ownership_state_version INTEGER NOT NULL CHECK (ownership_state_version >= 0),
  ownership_context_digest TEXT NOT NULL ${DIGEST("ownership_context_digest")},
  context_id TEXT NOT NULL ${ID("context_id")},
  failure_kind TEXT NOT NULL CHECK (failure_kind IN ('pre_oracle','oracle_rejected','promotion_aborted')),
  cause_evidence_id TEXT NOT NULL ${ID("cause_evidence_id")},
  cleanup_eligibility_record_id TEXT,
  oracle_decision_id TEXT,
  promotion_intent_id TEXT,
  target_proof_set_id TEXT NOT NULL ${ID("target_proof_set_id")},
  target_proof_set_state TEXT NOT NULL CHECK (target_proof_set_state = 'sealed_complete'),
  target_proof_set_digest TEXT NOT NULL ${DIGEST("target_proof_set_digest")},
  target_proof_set_evidence_id TEXT NOT NULL ${ID("target_proof_set_evidence_id")},
  target_proof_count INTEGER NOT NULL CHECK (target_proof_count >= 0),
  salvage_record_id TEXT NOT NULL ${ID("salvage_record_id")},
  delivery_ref TEXT NOT NULL ${ID("delivery_ref")},
  delivery_baseline_oid TEXT NOT NULL ${OID("delivery_baseline_oid")},
  delivery_observed_oid TEXT NOT NULL ${OID("delivery_observed_oid")},
  claim_preimage_digest TEXT NOT NULL ${DIGEST("claim_preimage_digest")},
  worktree_disposition TEXT NOT NULL CHECK (worktree_disposition = 'removed'),
  index_disposition TEXT NOT NULL CHECK (index_disposition = 'removed'),
  ref_disposition TEXT NOT NULL CHECK (ref_disposition = 'removed'),
  context_disposition TEXT NOT NULL CHECK (context_disposition = 'removed'),
  bundle_disposition TEXT NOT NULL CHECK (bundle_disposition = 'removed'),
  group_dead INTEGER NOT NULL CHECK (group_dead = 1),
  resources_absent INTEGER NOT NULL CHECK (resources_absent = 1),
  ownership_release_eligible INTEGER NOT NULL CHECK (ownership_release_eligible = 1),
  evidence_id TEXT NOT NULL ${ID("evidence_id")},
  input_digest TEXT NOT NULL ${DIGEST("input_digest")},
  record_digest TEXT NOT NULL ${DIGEST("record_digest")},
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (ownership_id, attempt_id, owner_generation)
    REFERENCES attempt_ownership_leases(ownership_id, attempt_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (cause_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (cleanup_eligibility_record_id, attempt_id)
    REFERENCES cleanup_eligibility_records(cleanup_eligibility_record_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (oracle_decision_id, attempt_id)
    REFERENCES oracle_decisions(oracle_decision_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (promotion_intent_id, attempt_id)
    REFERENCES promotion_intents(promotion_intent_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    target_proof_set_id, attempt_id, target_proof_set_state,
    target_proof_set_digest, target_proof_set_evidence_id, target_proof_count
  ) REFERENCES attempt_target_proof_sets(
    target_proof_set_id, attempt_id, state, proof_set_digest, evidence_id, target_count
  ) ON DELETE RESTRICT,
  FOREIGN KEY (salvage_record_id, attempt_id)
    REFERENCES salvage_records(salvage_record_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK (delivery_baseline_oid = delivery_observed_oid),
  CHECK ((failure_kind = 'pre_oracle' AND cleanup_eligibility_record_id IS NULL AND oracle_decision_id IS NULL AND promotion_intent_id IS NULL) OR
         (failure_kind = 'oracle_rejected' AND cleanup_eligibility_record_id IS NOT NULL AND oracle_decision_id IS NOT NULL AND promotion_intent_id IS NULL) OR
         (failure_kind = 'promotion_aborted' AND cleanup_eligibility_record_id IS NOT NULL AND oracle_decision_id IS NOT NULL AND promotion_intent_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX failure_cleanup_records_attempt_uq ON failure_cleanup_records(attempt_id);
CREATE UNIQUE INDEX failure_cleanup_records_attempt_idempotency_uq ON failure_cleanup_records(attempt_id, idempotency_key);
CREATE UNIQUE INDEX failure_cleanup_records_digest_uq ON failure_cleanup_records(record_digest);

CREATE TABLE promotion_cleanup_records (
  promotion_cleanup_record_id TEXT PRIMARY KEY ${ID("promotion_cleanup_record_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  ownership_id TEXT NOT NULL ${ID("ownership_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  ownership_state_version INTEGER NOT NULL CHECK (ownership_state_version >= 0),
  ownership_context_digest TEXT NOT NULL ${DIGEST("ownership_context_digest")},
  context_id TEXT NOT NULL ${ID("context_id")},
  cleanup_eligibility_record_id TEXT NOT NULL ${ID("cleanup_eligibility_record_id")},
  oracle_decision_id TEXT NOT NULL ${ID("oracle_decision_id")},
  promotion_intent_id TEXT NOT NULL ${ID("promotion_intent_id")},
  promotion_observation_evidence_id TEXT NOT NULL ${ID("promotion_observation_evidence_id")},
  delivery_ref TEXT NOT NULL ${ID("delivery_ref")},
  expected_old_oid TEXT NOT NULL ${OID("expected_old_oid")},
  candidate_oid TEXT NOT NULL ${OID("candidate_oid")},
  delivery_observed_oid TEXT NOT NULL ${OID("delivery_observed_oid")},
  claim_preimage_digest TEXT NOT NULL ${DIGEST("claim_preimage_digest")},
  worktree_disposition TEXT NOT NULL CHECK (worktree_disposition = 'removed'),
  index_disposition TEXT NOT NULL CHECK (index_disposition = 'removed'),
  ref_disposition TEXT NOT NULL CHECK (ref_disposition = 'removed'),
  context_disposition TEXT NOT NULL CHECK (context_disposition = 'removed'),
  bundle_disposition TEXT NOT NULL CHECK (bundle_disposition = 'removed'),
  group_dead INTEGER NOT NULL CHECK (group_dead = 1),
  resources_absent INTEGER NOT NULL CHECK (resources_absent = 1),
  ownership_release_eligible INTEGER NOT NULL CHECK (ownership_release_eligible = 1),
  evidence_id TEXT NOT NULL ${ID("evidence_id")},
  input_digest TEXT NOT NULL ${DIGEST("input_digest")},
  record_digest TEXT NOT NULL ${DIGEST("record_digest")},
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (ownership_id, attempt_id, owner_generation)
    REFERENCES attempt_ownership_leases(ownership_id, attempt_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (cleanup_eligibility_record_id, attempt_id)
    REFERENCES cleanup_eligibility_records(cleanup_eligibility_record_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (oracle_decision_id, attempt_id)
    REFERENCES oracle_decisions(oracle_decision_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (promotion_intent_id, attempt_id)
    REFERENCES promotion_intents(promotion_intent_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (promotion_observation_evidence_id, attempt_id)
    REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK (candidate_oid = delivery_observed_oid),
  CHECK (candidate_oid <> expected_old_oid)
) STRICT;
CREATE UNIQUE INDEX promotion_cleanup_records_attempt_uq ON promotion_cleanup_records(attempt_id);
CREATE UNIQUE INDEX promotion_cleanup_records_intent_uq ON promotion_cleanup_records(promotion_intent_id);
CREATE UNIQUE INDEX promotion_cleanup_records_attempt_idempotency_uq ON promotion_cleanup_records(attempt_id, idempotency_key);
CREATE UNIQUE INDEX promotion_cleanup_records_digest_uq ON promotion_cleanup_records(record_digest);

CREATE TABLE quarantine_claim_sets (
  quarantine_claim_set_id TEXT PRIMARY KEY ${ID("quarantine_claim_set_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  ownership_id TEXT NOT NULL ${ID("ownership_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  ownership_context_digest TEXT NOT NULL ${DIGEST("ownership_context_digest")},
  ownership_snapshot_evidence_id TEXT NOT NULL ${ID("ownership_snapshot_evidence_id")},
  claim_count INTEGER NOT NULL CHECK (claim_count = 11),
  absent_count INTEGER NOT NULL CHECK (absent_count >= 0),
  retained_count INTEGER NOT NULL CHECK (retained_count >= 0),
  unknown_count INTEGER NOT NULL CHECK (unknown_count >= 0),
  not_applicable_count INTEGER NOT NULL CHECK (not_applicable_count >= 0),
  all_required_absent INTEGER NOT NULL CHECK (all_required_absent IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('collecting','sealed')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  claim_set_digest TEXT ${OPTIONAL_DIGEST("claim_set_digest")},
  evidence_id TEXT,
  input_digest TEXT NOT NULL ${DIGEST("input_digest")},
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  sealed_at TEXT CHECK (sealed_at IS NULL OR (length(sealed_at) >= 20 AND substr(sealed_at, -1) = 'Z')),
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (ownership_id, attempt_id, owner_generation)
    REFERENCES attempt_ownership_leases(ownership_id, attempt_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY (ownership_snapshot_evidence_id, attempt_id)
    REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK (absent_count + retained_count + unknown_count + not_applicable_count = claim_count),
  CHECK ((state = 'collecting' AND state_version = 0 AND claim_set_digest IS NULL AND evidence_id IS NULL AND sealed_at IS NULL) OR
         (state = 'sealed' AND state_version = 1 AND claim_set_digest IS NOT NULL AND evidence_id IS NOT NULL AND sealed_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX quarantine_claim_sets_attempt_uq ON quarantine_claim_sets(attempt_id);
CREATE UNIQUE INDEX quarantine_claim_sets_attempt_idempotency_uq
  ON quarantine_claim_sets(attempt_id, idempotency_key);
CREATE UNIQUE INDEX quarantine_claim_sets_identity_owner_uq
  ON quarantine_claim_sets(quarantine_claim_set_id, attempt_id, ownership_id, owner_generation);
CREATE UNIQUE INDEX quarantine_claim_sets_sealed_identity_uq
  ON quarantine_claim_sets(
    quarantine_claim_set_id, attempt_id, ownership_id, owner_generation,
    state, claim_set_digest, evidence_id, all_required_absent
  );

CREATE TABLE quarantine_claim_members (
  quarantine_claim_set_id TEXT NOT NULL ${ID("quarantine_claim_set_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  resource_claim_id TEXT NOT NULL ${ID("resource_claim_id")},
  slot TEXT NOT NULL CHECK (slot IN ('delivery_ref','attempt_ref','worktree','isolated_index','policy_context','policy_bundle','process_group','stdout','stderr','verification_output','salvage_archive')),
  kind TEXT NOT NULL CHECK (kind = slot),
  current_ownership_id TEXT NOT NULL ${ID("current_ownership_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  claim_state TEXT NOT NULL CHECK (claim_state = 'quarantined'),
  claim_state_version INTEGER NOT NULL CHECK (claim_state_version >= 0),
  claim_snapshot_evidence_id TEXT NOT NULL ${ID("claim_snapshot_evidence_id")},
  absence_required INTEGER NOT NULL CHECK (absence_required IN (0,1)),
  physical_disposition TEXT NOT NULL CHECK (physical_disposition IN ('absent','retained','unknown','not_applicable')),
  disposition_evidence_id TEXT NOT NULL ${ID("disposition_evidence_id")},
  member_digest TEXT NOT NULL ${DIGEST("member_digest")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  PRIMARY KEY (quarantine_claim_set_id, ordinal),
  UNIQUE (quarantine_claim_set_id, resource_claim_id),
  UNIQUE (quarantine_claim_set_id, slot),
  FOREIGN KEY (quarantine_claim_set_id, attempt_id, current_ownership_id, owner_generation)
    REFERENCES quarantine_claim_sets(quarantine_claim_set_id, attempt_id, ownership_id, owner_generation) ON DELETE RESTRICT,
  FOREIGN KEY (
    resource_claim_id, attempt_id, slot, kind, current_ownership_id,
    owner_generation, claim_state, claim_state_version
  ) REFERENCES attempt_resource_claims(
    resource_claim_id, attempt_id, slot, kind, current_ownership_id,
    owner_generation, state, state_version
  ) ON DELETE RESTRICT,
  FOREIGN KEY (claim_snapshot_evidence_id, attempt_id)
    REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (disposition_evidence_id, attempt_id)
    REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK ((absence_required = 0 AND slot = 'delivery_ref' AND physical_disposition = 'not_applicable') OR
         (absence_required = 1 AND slot <> 'delivery_ref' AND physical_disposition IN ('absent','retained','unknown')))
) STRICT;

CREATE TABLE quarantine_records (
  quarantine_record_id TEXT PRIMARY KEY ${ID("quarantine_record_id")},
  attempt_id TEXT NOT NULL ${ID("attempt_id")},
  ownership_id TEXT NOT NULL ${ID("ownership_id")},
  owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
  ownership_state_version INTEGER NOT NULL CHECK (ownership_state_version >= 0),
  ownership_context_digest TEXT NOT NULL ${DIGEST("ownership_context_digest")},
  context_id TEXT NOT NULL ${ID("context_id")},
  quarantine_stage TEXT NOT NULL CHECK (quarantine_stage IN ('pre_oracle','oracle','promotion')),
  reason_code TEXT NOT NULL ${ID("reason_code")},
  cause_evidence_id TEXT NOT NULL ${ID("cause_evidence_id")},
  cleanup_eligibility_record_id TEXT,
  oracle_decision_id TEXT,
  promotion_intent_id TEXT,
  target_proof_set_id TEXT NOT NULL ${ID("target_proof_set_id")},
  target_proof_set_state TEXT NOT NULL CHECK (target_proof_set_state = 'sealed_complete'),
  target_proof_set_digest TEXT NOT NULL ${DIGEST("target_proof_set_digest")},
  target_proof_set_evidence_id TEXT NOT NULL ${ID("target_proof_set_evidence_id")},
  target_proof_count INTEGER NOT NULL CHECK (target_proof_count >= 0),
  quarantine_claim_set_id TEXT NOT NULL ${ID("quarantine_claim_set_id")},
  quarantine_claim_set_state TEXT NOT NULL CHECK (quarantine_claim_set_state = 'sealed'),
  quarantine_claim_set_digest TEXT NOT NULL ${DIGEST("quarantine_claim_set_digest")},
  quarantine_claim_set_evidence_id TEXT NOT NULL ${ID("quarantine_claim_set_evidence_id")},
  delivery_ref TEXT NOT NULL ${ID("delivery_ref")},
  expected_delivery_oid TEXT ${OPTIONAL_OID("expected_delivery_oid")},
  observed_delivery_oid TEXT ${OPTIONAL_OID("observed_delivery_oid")},
  group_dead INTEGER NOT NULL CHECK (group_dead = 1),
  resources_absent INTEGER NOT NULL CHECK (resources_absent IN (0,1)),
  evidence_id TEXT NOT NULL ${ID("evidence_id")},
  input_digest TEXT NOT NULL ${DIGEST("input_digest")},
  record_digest TEXT NOT NULL ${DIGEST("record_digest")},
  idempotency_key TEXT NOT NULL ${ID("idempotency_key")},
  created_at TEXT NOT NULL ${UTC("created_at")},
  FOREIGN KEY (attempt_id) REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (ownership_id, attempt_id, owner_generation)
    REFERENCES attempt_ownership_leases(ownership_id, attempt_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY (context_id, attempt_id) REFERENCES execution_contexts(context_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (cause_evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (cleanup_eligibility_record_id, attempt_id)
    REFERENCES cleanup_eligibility_records(cleanup_eligibility_record_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (oracle_decision_id, attempt_id)
    REFERENCES oracle_decisions(oracle_decision_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (promotion_intent_id, attempt_id)
    REFERENCES promotion_intents(promotion_intent_id, attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    target_proof_set_id, attempt_id, target_proof_set_state,
    target_proof_set_digest, target_proof_set_evidence_id, target_proof_count
  ) REFERENCES attempt_target_proof_sets(
    target_proof_set_id, attempt_id, state, proof_set_digest, evidence_id, target_count
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    quarantine_claim_set_id, attempt_id, ownership_id, owner_generation,
    quarantine_claim_set_state, quarantine_claim_set_digest,
    quarantine_claim_set_evidence_id, resources_absent
  ) REFERENCES quarantine_claim_sets(
    quarantine_claim_set_id, attempt_id, ownership_id, owner_generation,
    state, claim_set_digest, evidence_id, all_required_absent
  ) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_id, attempt_id) REFERENCES evidence(evidence_id, attempt_id) ON DELETE RESTRICT,
  CHECK ((quarantine_stage = 'pre_oracle' AND cleanup_eligibility_record_id IS NULL AND oracle_decision_id IS NULL AND promotion_intent_id IS NULL) OR
         (quarantine_stage = 'oracle' AND cleanup_eligibility_record_id IS NOT NULL AND oracle_decision_id IS NOT NULL AND promotion_intent_id IS NULL) OR
         (quarantine_stage = 'promotion' AND cleanup_eligibility_record_id IS NOT NULL AND oracle_decision_id IS NOT NULL AND promotion_intent_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX quarantine_records_attempt_uq ON quarantine_records(attempt_id);
CREATE UNIQUE INDEX quarantine_records_attempt_idempotency_uq ON quarantine_records(attempt_id, idempotency_key);
CREATE UNIQUE INDEX quarantine_records_digest_uq ON quarantine_records(record_digest);

CREATE TRIGGER target_start_gates_immutable_identity BEFORE UPDATE ON target_start_gates
WHEN NEW.target_start_gate_id IS NOT OLD.target_start_gate_id OR
     NEW.attempt_id IS NOT OLD.attempt_id OR NEW.ownership_id IS NOT OLD.ownership_id OR
     NEW.owner_generation IS NOT OLD.owner_generation OR NEW.phase_execution_id IS NOT OLD.phase_execution_id OR
     NEW.context_id IS NOT OLD.context_id OR NEW.execution_context_digest IS NOT OLD.execution_context_digest OR
     NEW.start_authorization_digest IS NOT OLD.start_authorization_digest OR NEW.input_digest IS NOT OLD.input_digest OR
     NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'target start gate identity is immutable'); END;
CREATE TRIGGER target_start_gates_state_version BEFORE UPDATE ON target_start_gates
WHEN NEW.state_version <> OLD.state_version + 1
BEGIN SELECT RAISE(ABORT, 'target start gate state_version must advance by one'); END;
CREATE TRIGGER target_start_gates_legal_edge BEFORE UPDATE OF state ON target_start_gates
WHEN OLD.state <> 'held' OR NEW.state NOT IN ('released','closed_never_released')
BEGIN SELECT RAISE(ABORT, 'illegal target start gate transition'); END;
CREATE TRIGGER target_start_gates_no_delete BEFORE DELETE ON target_start_gates
BEGIN SELECT RAISE(ABORT, 'target start gates cannot be deleted'); END;

CREATE TRIGGER target_start_gates_no_insert_after_proof_seal BEFORE INSERT ON target_start_gates
WHEN EXISTS (
  SELECT 1 FROM attempt_target_proof_sets proof
  WHERE proof.attempt_id = NEW.attempt_id AND proof.state <> 'collecting'
)
BEGIN SELECT RAISE(ABORT, 'target start gates cannot append after target proof sealing'); END;
CREATE TRIGGER target_start_gates_no_update_after_proof_seal BEFORE UPDATE ON target_start_gates
WHEN EXISTS (
  SELECT 1 FROM attempt_target_proof_sets proof
  WHERE proof.attempt_id = NEW.attempt_id AND proof.state <> 'collecting'
)
BEGIN SELECT RAISE(ABORT, 'target start gates cannot advance after target proof sealing'); END;
CREATE TRIGGER attempt_process_launches_no_insert_after_proof_seal BEFORE INSERT ON attempt_process_launches
WHEN EXISTS (
  SELECT 1 FROM attempt_target_proof_sets proof
  WHERE proof.attempt_id = NEW.attempt_id AND proof.state <> 'collecting'
)
BEGIN SELECT RAISE(ABORT, 'process launches cannot append after target proof sealing'); END;

CREATE TRIGGER attempt_target_proof_members_collecting_only BEFORE INSERT ON attempt_target_proof_members
WHEN NOT EXISTS (
  SELECT 1 FROM attempt_target_proof_sets proof
  WHERE proof.target_proof_set_id = NEW.target_proof_set_id
    AND proof.attempt_id = NEW.attempt_id
    AND proof.ownership_id = NEW.ownership_id
    AND proof.owner_generation = NEW.owner_generation
    AND proof.state = 'collecting'
)
BEGIN SELECT RAISE(ABORT, 'target proof members require their collecting proof set'); END;
CREATE TRIGGER attempt_target_proof_members_gate_snapshot BEFORE INSERT ON attempt_target_proof_members
WHEN NEW.target_start_gate_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM target_start_gates gate
  WHERE gate.target_start_gate_id = NEW.target_start_gate_id
    AND gate.attempt_id = NEW.attempt_id
    AND gate.ownership_id = NEW.ownership_id
    AND gate.owner_generation = NEW.owner_generation
    AND gate.phase_execution_id = NEW.phase_execution_id
    AND gate.context_id = NEW.context_id
    AND gate.state = NEW.gate_state
    AND gate.state_version = NEW.gate_state_version
    AND gate.release_evidence_id IS NEW.gate_release_evidence_id
    AND gate.never_released_evidence_id IS NEW.gate_never_released_evidence_id
)
BEGIN SELECT RAISE(ABORT, 'target proof member gate snapshot is not exact'); END;
CREATE TRIGGER attempt_target_proof_members_terminal_death_evidence BEFORE INSERT ON attempt_target_proof_members
WHEN NEW.proof_kind IN ('terminal_process','never_released') AND NEW.launch_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM attempt_process_observations observation
  JOIN evidence death ON death.evidence_id = observation.evidence_id
  JOIN attempt_process_launches launch ON launch.launch_id = observation.launch_id
  WHERE observation.launch_id = NEW.launch_id
    AND observation.attempt_id = NEW.attempt_id
    AND observation.kind = 'group_death'
    AND observation.schema_version = 'rickgent.process-group-death.v1'
    AND observation.evidence_id = NEW.group_death_evidence_id
    AND death.attempt_id = NEW.attempt_id
    AND death.phase_execution_id = NEW.phase_execution_id
    AND death.context_id = NEW.context_id
    AND death.producer_service = 'ProcessSupervisor'
    AND death.schema_version = 'rickgent.process-group-death.v1'
    AND death.content_digest = observation.payload_digest
    AND launch.process_receipt_id = NEW.process_receipt_id
    AND launch.ownership_id = NEW.ownership_id
    AND launch.owner_generation = NEW.owner_generation
)
BEGIN SELECT RAISE(ABORT, 'terminal target proof lacks exact group-death observation evidence'); END;
CREATE TRIGGER attempt_target_proof_members_no_update BEFORE UPDATE ON attempt_target_proof_members
BEGIN SELECT RAISE(ABORT, 'target proof members are append-only'); END;
CREATE TRIGGER attempt_target_proof_members_no_delete BEFORE DELETE ON attempt_target_proof_members
BEGIN SELECT RAISE(ABORT, 'target proof members are append-only'); END;

CREATE TRIGGER attempt_target_proof_sets_immutable_identity BEFORE UPDATE ON attempt_target_proof_sets
WHEN NEW.target_proof_set_id IS NOT OLD.target_proof_set_id OR
     NEW.attempt_id IS NOT OLD.attempt_id OR NEW.ownership_id IS NOT OLD.ownership_id OR
     NEW.owner_generation IS NOT OLD.owner_generation OR
     NEW.ownership_context_digest IS NOT OLD.ownership_context_digest OR
     NEW.target_count IS NOT OLD.target_count OR NEW.input_digest IS NOT OLD.input_digest OR
     NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'target proof set identity is immutable'); END;
CREATE TRIGGER attempt_target_proof_sets_state_version BEFORE UPDATE ON attempt_target_proof_sets
WHEN NEW.state_version <> OLD.state_version + 1
BEGIN SELECT RAISE(ABORT, 'target proof set state_version must advance by one'); END;
CREATE TRIGGER attempt_target_proof_sets_legal_edge BEFORE UPDATE OF state ON attempt_target_proof_sets
WHEN OLD.state <> 'collecting' OR NEW.state NOT IN ('sealed_complete','sealed_incomplete')
BEGIN SELECT RAISE(ABORT, 'illegal target proof set transition'); END;
CREATE TRIGGER attempt_target_proof_sets_inventory_complete BEFORE UPDATE OF state ON attempt_target_proof_sets
WHEN NEW.state IN ('sealed_complete','sealed_incomplete') AND (
  NEW.target_count <> (
    SELECT COUNT(*) FROM (
      SELECT phase_execution_id FROM target_start_gates WHERE attempt_id = NEW.attempt_id
      UNION
      SELECT phase_execution_id FROM attempt_process_launches WHERE attempt_id = NEW.attempt_id
    ) target_phases
  ) OR
  NEW.target_count <> (
    SELECT COUNT(*) FROM attempt_target_proof_members member
    WHERE member.target_proof_set_id = NEW.target_proof_set_id
  ) OR
  (NEW.target_count > 0 AND (
    (SELECT MIN(ordinal) FROM attempt_target_proof_members WHERE target_proof_set_id = NEW.target_proof_set_id) <> 0 OR
    (SELECT MAX(ordinal) FROM attempt_target_proof_members WHERE target_proof_set_id = NEW.target_proof_set_id) <> NEW.target_count - 1
  )) OR
  EXISTS (
    SELECT 1 FROM (
      SELECT phase_execution_id FROM target_start_gates WHERE attempt_id = NEW.attempt_id
      UNION
      SELECT phase_execution_id FROM attempt_process_launches WHERE attempt_id = NEW.attempt_id
    ) target
    LEFT JOIN attempt_target_proof_members member
      ON member.target_proof_set_id = NEW.target_proof_set_id
     AND member.phase_execution_id = target.phase_execution_id
    WHERE member.phase_execution_id IS NULL
  )
)
BEGIN SELECT RAISE(ABORT, 'target proof set does not inventory every gate or launch phase'); END;
CREATE TRIGGER attempt_target_proof_sets_complete_semantics BEFORE UPDATE OF state ON attempt_target_proof_sets
WHEN NEW.state = 'sealed_complete' AND (
  EXISTS (
    SELECT 1 FROM attempt_target_proof_members member
    WHERE member.target_proof_set_id = NEW.target_proof_set_id AND member.proof_kind = 'unproven'
  ) OR
  EXISTS (
    SELECT 1 FROM target_start_gates gate
    LEFT JOIN attempt_target_proof_members member
      ON member.target_proof_set_id = NEW.target_proof_set_id
     AND member.target_start_gate_id = gate.target_start_gate_id
    WHERE gate.attempt_id = NEW.attempt_id AND (
      member.target_start_gate_id IS NULL OR
      (gate.state = 'released' AND member.proof_kind <> 'terminal_process') OR
      (gate.state = 'closed_never_released' AND member.proof_kind <> 'never_released') OR
      gate.state = 'held'
    )
  ) OR
  EXISTS (
    SELECT 1 FROM attempt_process_launches launch
    LEFT JOIN attempt_target_proof_members member
      ON member.target_proof_set_id = NEW.target_proof_set_id
     AND member.phase_execution_id = launch.phase_execution_id
     AND member.launch_id = launch.launch_id
     AND member.process_receipt_id = launch.process_receipt_id
     AND member.proof_kind IN ('terminal_process','never_released')
    WHERE launch.attempt_id = NEW.attempt_id AND member.launch_id IS NULL
  )
)
BEGIN SELECT RAISE(ABORT, 'complete target proof set contains an unproven, live, or orphan target'); END;
CREATE TRIGGER attempt_target_proof_sets_incomplete_semantics BEFORE UPDATE OF state ON attempt_target_proof_sets
WHEN NEW.state = 'sealed_incomplete' AND NOT EXISTS (
  SELECT 1 FROM attempt_target_proof_members member
  WHERE member.target_proof_set_id = NEW.target_proof_set_id AND member.proof_kind = 'unproven'
)
BEGIN SELECT RAISE(ABORT, 'incomplete target proof set requires an explicit unproven member'); END;
CREATE TRIGGER attempt_target_proof_sets_no_delete BEFORE DELETE ON attempt_target_proof_sets
BEGIN SELECT RAISE(ABORT, 'target proof sets cannot be deleted'); END;

CREATE TRIGGER quarantine_claim_members_collecting_only BEFORE INSERT ON quarantine_claim_members
WHEN NOT EXISTS (
  SELECT 1 FROM quarantine_claim_sets claims
  WHERE claims.quarantine_claim_set_id = NEW.quarantine_claim_set_id
    AND claims.attempt_id = NEW.attempt_id
    AND claims.ownership_id = NEW.current_ownership_id
    AND claims.owner_generation = NEW.owner_generation
    AND claims.state = 'collecting'
)
BEGIN SELECT RAISE(ABORT, 'quarantine claim members require their collecting claim set'); END;
CREATE TRIGGER quarantine_claim_members_no_update BEFORE UPDATE ON quarantine_claim_members
BEGIN SELECT RAISE(ABORT, 'quarantine claim members are append-only'); END;
CREATE TRIGGER quarantine_claim_members_no_delete BEFORE DELETE ON quarantine_claim_members
BEGIN SELECT RAISE(ABORT, 'quarantine claim members are append-only'); END;

CREATE TRIGGER quarantine_claim_sets_immutable_identity BEFORE UPDATE ON quarantine_claim_sets
WHEN NEW.quarantine_claim_set_id IS NOT OLD.quarantine_claim_set_id OR
     NEW.attempt_id IS NOT OLD.attempt_id OR NEW.ownership_id IS NOT OLD.ownership_id OR
     NEW.owner_generation IS NOT OLD.owner_generation OR
     NEW.ownership_context_digest IS NOT OLD.ownership_context_digest OR
     NEW.ownership_snapshot_evidence_id IS NOT OLD.ownership_snapshot_evidence_id OR
     NEW.claim_count IS NOT OLD.claim_count OR NEW.absent_count IS NOT OLD.absent_count OR
     NEW.retained_count IS NOT OLD.retained_count OR NEW.unknown_count IS NOT OLD.unknown_count OR
     NEW.not_applicable_count IS NOT OLD.not_applicable_count OR
     NEW.all_required_absent IS NOT OLD.all_required_absent OR
     NEW.input_digest IS NOT OLD.input_digest OR NEW.idempotency_key IS NOT OLD.idempotency_key OR
     NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'quarantine claim set identity is immutable'); END;
CREATE TRIGGER quarantine_claim_sets_state_version BEFORE UPDATE ON quarantine_claim_sets
WHEN NEW.state_version <> OLD.state_version + 1
BEGIN SELECT RAISE(ABORT, 'quarantine claim set state_version must advance by one'); END;
CREATE TRIGGER quarantine_claim_sets_legal_edge BEFORE UPDATE OF state ON quarantine_claim_sets
WHEN OLD.state <> 'collecting' OR NEW.state <> 'sealed'
BEGIN SELECT RAISE(ABORT, 'illegal quarantine claim set transition'); END;
CREATE TRIGGER quarantine_claim_sets_complete_seal BEFORE UPDATE OF state ON quarantine_claim_sets
WHEN NEW.state = 'sealed' AND (
  NEW.claim_count <> (
    SELECT COUNT(*) FROM quarantine_claim_members member
    WHERE member.quarantine_claim_set_id = NEW.quarantine_claim_set_id
  ) OR
  (SELECT MIN(ordinal) FROM quarantine_claim_members WHERE quarantine_claim_set_id = NEW.quarantine_claim_set_id) <> 0 OR
  (SELECT MAX(ordinal) FROM quarantine_claim_members WHERE quarantine_claim_set_id = NEW.quarantine_claim_set_id) <> NEW.claim_count - 1 OR
  NEW.claim_count <> (
    SELECT COUNT(*) FROM attempt_resource_claims claim
    WHERE claim.attempt_id = NEW.attempt_id
      AND claim.current_ownership_id = NEW.ownership_id
      AND claim.owner_generation = NEW.owner_generation
      AND claim.state = 'quarantined'
  ) OR
  EXISTS (
    SELECT 1 FROM attempt_resource_claims claim
    LEFT JOIN quarantine_claim_members member
      ON member.quarantine_claim_set_id = NEW.quarantine_claim_set_id
     AND member.resource_claim_id = claim.resource_claim_id
    WHERE claim.attempt_id = NEW.attempt_id
      AND claim.current_ownership_id = NEW.ownership_id
      AND claim.owner_generation = NEW.owner_generation
      AND claim.state = 'quarantined'
      AND member.resource_claim_id IS NULL
  ) OR
  NEW.absent_count <> (
    SELECT COUNT(*) FROM quarantine_claim_members WHERE quarantine_claim_set_id = NEW.quarantine_claim_set_id AND physical_disposition = 'absent'
  ) OR
  NEW.retained_count <> (
    SELECT COUNT(*) FROM quarantine_claim_members WHERE quarantine_claim_set_id = NEW.quarantine_claim_set_id AND physical_disposition = 'retained'
  ) OR
  NEW.unknown_count <> (
    SELECT COUNT(*) FROM quarantine_claim_members WHERE quarantine_claim_set_id = NEW.quarantine_claim_set_id AND physical_disposition = 'unknown'
  ) OR
  NEW.not_applicable_count <> (
    SELECT COUNT(*) FROM quarantine_claim_members WHERE quarantine_claim_set_id = NEW.quarantine_claim_set_id AND physical_disposition = 'not_applicable'
  ) OR
  NEW.all_required_absent <> CASE WHEN EXISTS (
    SELECT 1 FROM quarantine_claim_members
    WHERE quarantine_claim_set_id = NEW.quarantine_claim_set_id
      AND absence_required = 1 AND physical_disposition <> 'absent'
  ) THEN 0 ELSE 1 END
)
BEGIN SELECT RAISE(ABORT, 'quarantine claim set does not exactly inventory terminal claims'); END;
CREATE TRIGGER quarantine_claim_sets_no_delete BEFORE DELETE ON quarantine_claim_sets
BEGIN SELECT RAISE(ABORT, 'quarantine claim sets cannot be deleted'); END;

CREATE TRIGGER cleanup_eligibility_records_target_owner_lineage BEFORE INSERT ON cleanup_eligibility_records
WHEN NOT EXISTS (
  WITH RECURSIVE ownership_chain(ownership_id, generation, recovered_from_ownership_id) AS (
    SELECT ownership_id, generation, recovered_from_ownership_id
    FROM attempt_ownership_leases
    WHERE ownership_id = NEW.ownership_id AND attempt_id = NEW.attempt_id AND generation = NEW.owner_generation
    UNION ALL
    SELECT parent.ownership_id, parent.generation, parent.recovered_from_ownership_id
    FROM attempt_ownership_leases parent
    JOIN ownership_chain child ON child.recovered_from_ownership_id = parent.ownership_id
    WHERE parent.attempt_id = NEW.attempt_id
  )
  SELECT 1 FROM ownership_chain chain
  JOIN attempt_target_proof_sets proof
    ON proof.target_proof_set_id = NEW.target_proof_set_id
   AND proof.attempt_id = NEW.attempt_id
   AND proof.ownership_id = chain.ownership_id
   AND proof.owner_generation = chain.generation
)
BEGIN SELECT RAISE(ABORT, 'cleanup eligibility target proofs are outside current ownership recovery lineage'); END;

CREATE TRIGGER failure_cleanup_records_target_owner_lineage BEFORE INSERT ON failure_cleanup_records
WHEN NOT EXISTS (
  WITH RECURSIVE ownership_chain(ownership_id, generation, recovered_from_ownership_id) AS (
    SELECT ownership_id, generation, recovered_from_ownership_id FROM attempt_ownership_leases
    WHERE ownership_id = NEW.ownership_id AND attempt_id = NEW.attempt_id AND generation = NEW.owner_generation
    UNION ALL
    SELECT parent.ownership_id, parent.generation, parent.recovered_from_ownership_id
    FROM attempt_ownership_leases parent JOIN ownership_chain child ON child.recovered_from_ownership_id = parent.ownership_id
    WHERE parent.attempt_id = NEW.attempt_id
  )
  SELECT 1 FROM ownership_chain chain JOIN attempt_target_proof_sets proof
    ON proof.target_proof_set_id = NEW.target_proof_set_id AND proof.attempt_id = NEW.attempt_id
   AND proof.ownership_id = chain.ownership_id AND proof.owner_generation = chain.generation
)
BEGIN SELECT RAISE(ABORT, 'failure cleanup target proofs are outside current ownership recovery lineage'); END;

CREATE TRIGGER quarantine_records_target_owner_lineage BEFORE INSERT ON quarantine_records
WHEN NOT EXISTS (
  WITH RECURSIVE ownership_chain(ownership_id, generation, recovered_from_ownership_id) AS (
    SELECT ownership_id, generation, recovered_from_ownership_id FROM attempt_ownership_leases
    WHERE ownership_id = NEW.ownership_id AND attempt_id = NEW.attempt_id AND generation = NEW.owner_generation
    UNION ALL
    SELECT parent.ownership_id, parent.generation, parent.recovered_from_ownership_id
    FROM attempt_ownership_leases parent JOIN ownership_chain child ON child.recovered_from_ownership_id = parent.ownership_id
    WHERE parent.attempt_id = NEW.attempt_id
  )
  SELECT 1 FROM ownership_chain chain JOIN attempt_target_proof_sets proof
    ON proof.target_proof_set_id = NEW.target_proof_set_id AND proof.attempt_id = NEW.attempt_id
   AND proof.ownership_id = chain.ownership_id AND proof.owner_generation = chain.generation
)
BEGIN SELECT RAISE(ABORT, 'quarantine target proofs are outside current ownership recovery lineage'); END;

${appendOnlyTriggers("cleanup_eligibility_records")}
${appendOnlyTriggers("failure_cleanup_records")}
${appendOnlyTriggers("promotion_cleanup_records")}
${appendOnlyTriggers("quarantine_records")}
`;

function releasedObjectNames(sql: string, kind: "TABLE" | "INDEX" | "TRIGGER"): readonly string[] {
  const names = [...sql.matchAll(new RegExp(`CREATE (?:UNIQUE )?${kind} ([a-z0-9_]+)`, "g"))]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  return Object.freeze([...new Set(names)]);
}

export const INITIAL_STATE_SCHEMA_OBJECTS = Object.freeze({
  tables: releasedObjectNames(INITIAL_SQL, "TABLE"),
  indexes: releasedObjectNames(INITIAL_SQL, "INDEX"),
  triggers: releasedObjectNames(INITIAL_SQL, "TRIGGER"),
});

const ATTEMPT_OWNERSHIP_STATE_SQL = `${INITIAL_SQL}${ATTEMPT_OWNERSHIP_SQL}`;
const PROCESS_SUPERVISION_STATE_SQL = `${ATTEMPT_OWNERSHIP_STATE_SQL}${PROCESS_SUPERVISION_SQL}`;
const COMMIT_ATTRIBUTION_STATE_SQL = `${PROCESS_SUPERVISION_STATE_SQL}${COMMIT_ATTRIBUTION_SQL}`;
const ATTEMPT_CLEANUP_PROOF_STATE_SQL = `${COMMIT_ATTRIBUTION_STATE_SQL}${ATTEMPT_CLEANUP_PROOF_SQL}`;

// Migration 006 — align the persisted attempts_legal_edge SQLite trigger with
// the normative PHASE_TRANSITION_TABLE failure edges.  The original trigger
// (from migration 005) only allowed cleanup_pending from "converging" (the
// success path).  This migration drops and recreates the trigger to also
// allow cleanup_pending from every pre-cleanup state (planned, implementing,
// implementation_captured, reviewing, remediating, remediation_captured,
// verification_queued, verifying), so every declared legal failure edge is
// executable through the persisted SQLite trigger.
const ATTEMPT_LEGAL_EDGE_FAILURE_MIGRATION_SQL = `
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

const LATEST_SQL = `${ATTEMPT_CLEANUP_PROOF_STATE_SQL}${ATTEMPT_LEGAL_EDGE_FAILURE_MIGRATION_SQL}\n`;

export const ATTEMPT_OWNERSHIP_STATE_SCHEMA_OBJECTS = Object.freeze({
  tables: releasedObjectNames(ATTEMPT_OWNERSHIP_STATE_SQL, "TABLE"),
  indexes: releasedObjectNames(ATTEMPT_OWNERSHIP_STATE_SQL, "INDEX"),
  triggers: releasedObjectNames(ATTEMPT_OWNERSHIP_STATE_SQL, "TRIGGER"),
});

export const PROCESS_SUPERVISION_STATE_SCHEMA_OBJECTS = Object.freeze({
  tables: releasedObjectNames(PROCESS_SUPERVISION_STATE_SQL, "TABLE"),
  indexes: releasedObjectNames(PROCESS_SUPERVISION_STATE_SQL, "INDEX"),
  triggers: releasedObjectNames(PROCESS_SUPERVISION_STATE_SQL, "TRIGGER"),
});

export const COMMIT_ATTRIBUTION_STATE_SCHEMA_OBJECTS = Object.freeze({
  tables: releasedObjectNames(COMMIT_ATTRIBUTION_STATE_SQL, "TABLE"),
  indexes: releasedObjectNames(COMMIT_ATTRIBUTION_STATE_SQL, "INDEX"),
  triggers: releasedObjectNames(COMMIT_ATTRIBUTION_STATE_SQL, "TRIGGER"),
});

export const LATEST_STATE_SCHEMA_OBJECTS = Object.freeze({
  tables: releasedObjectNames(LATEST_SQL, "TABLE"),
  indexes: releasedObjectNames(LATEST_SQL, "INDEX"),
  triggers: releasedObjectNames(LATEST_SQL, "TRIGGER"),
});

function checksum(sql: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(sql, "utf8").digest("hex")}`;
}

/**
 * Released migration checksums are literals on purpose. Computing the value
 * only from the current SQL would prove self-consistency but would not detect
 * an accidental edit to a released migration.
 */
export const INITIAL_STATE_MIGRATION_CHECKSUM =
  "sha256:473f6581359fb59da29236aeb77acaba74aa46504fb0ac8c0089c59afca586a8" as const;

/** Digest of the ordered non-SQLite-owned rows in sqlite_schema after 001. */
export const INITIAL_STATE_SQLITE_SCHEMA_CHECKSUM =
  "sha256:11f061a28bffe7ed02a6d5b974cca09dcff189e18fb18834659a3aad175ecef9" as const;

export const ATTEMPT_OWNERSHIP_MIGRATION_CHECKSUM =
  "sha256:8dc1be6f92fbe281149b651c89fd1b2e8d7b4f3464c2f85a2113aa851123473d" as const;

export const ATTEMPT_OWNERSHIP_STATE_SQLITE_SCHEMA_CHECKSUM =
  "sha256:eb83ea80db2cc06eb46ffe135994fe79cf4f53146b5f71ac8a876b46f6224bbc" as const;

export const PROCESS_SUPERVISION_MIGRATION_CHECKSUM =
  "sha256:c94e5b62aa8dae64740685c13159f2d19610909729c789e6638deb59855ff8ce" as const;

export const COMMIT_ATTRIBUTION_MIGRATION_CHECKSUM =
  "sha256:66f819b89e1781ca7fdc7311e269a4991a86706224eaa269b0198ad434ce6469" as const;

export const ATTEMPT_CLEANUP_PROOF_MIGRATION_CHECKSUM =
  "sha256:e9c6896dd23d8d07127fa8ddb05483ad00ff9a59b2042dc32ce75428371ac6f1" as const;

export const ATTEMPT_LEGAL_EDGE_FAILURE_MIGRATION_CHECKSUM =
  "sha256:b513d8e031d557dec10109c443bb1676ddd31ff421a0c60e36bde0e092e9421e" as const;

export const ATTEMPT_CLEANUP_PROOF_STATE_SQLITE_SCHEMA_CHECKSUM =
  "sha256:c91fd35e83d879890dd13ef8f8bb18fa6f8b116e8b85545e4c3e8c65785681c6" as const;

export const PROCESS_SUPERVISION_STATE_SQLITE_SCHEMA_CHECKSUM =
  "sha256:c208339c0350aae8bd1ee3784da4e4ffc559b41e9c6079530a89da53c08753e3" as const;

export const COMMIT_ATTRIBUTION_STATE_SQLITE_SCHEMA_CHECKSUM =
  "sha256:af782456d3402bd47cff0ca9fd4e358c52028c14fee3470efcc295cac926542d" as const;

export const LATEST_STATE_SQLITE_SCHEMA_CHECKSUM =
  "sha256:ce0b23b40baec3cf11b66ef9d0e9f998adfb048cbbba8f3eb82abfb3d924b7d8" as const;

export const STATE_MIGRATIONS: readonly StateMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    number: "001",
    name: "001_initial_durable_state",
    sql: INITIAL_SQL,
    checksum: INITIAL_STATE_MIGRATION_CHECKSUM,
  }),
  Object.freeze({
    version: 2,
    number: "002",
    name: "002_attempt_ownership_primitive",
    sql: ATTEMPT_OWNERSHIP_SQL,
    checksum: ATTEMPT_OWNERSHIP_MIGRATION_CHECKSUM,
  }),
  Object.freeze({
    version: 3,
    number: "003",
    name: "003_durable_process_supervision",
    sql: PROCESS_SUPERVISION_SQL,
    checksum: PROCESS_SUPERVISION_MIGRATION_CHECKSUM,
  }),
  Object.freeze({
    version: 4,
    number: "004",
    name: "004_durable_commit_attribution",
    sql: COMMIT_ATTRIBUTION_SQL,
    checksum: COMMIT_ATTRIBUTION_MIGRATION_CHECKSUM,
  }),
  Object.freeze({
    version: 5,
    number: "005",
    name: "005_attempt_cleanup_proof_model",
    sql: ATTEMPT_CLEANUP_PROOF_SQL,
    checksum: ATTEMPT_CLEANUP_PROOF_MIGRATION_CHECKSUM,
  }),
  Object.freeze({
    version: 6,
    number: "006",
    name: "006_attempt_legal_edge_failure_edges",
    sql: ATTEMPT_LEGAL_EDGE_FAILURE_MIGRATION_SQL,
    checksum: ATTEMPT_LEGAL_EDGE_FAILURE_MIGRATION_CHECKSUM,
  }),
]);

export const LATEST_STATE_SCHEMA_VERSION = STATE_MIGRATIONS.length;

export function assertValidMigrationCatalog(catalog: readonly StateMigration[] = STATE_MIGRATIONS): void {
  const names = new Set<string>();
  for (let index = 0; index < catalog.length; index += 1) {
    const migration = catalog[index];
    if (migration === undefined || migration.version !== index + 1 || migration.number !== String(index + 1).padStart(3, "0")) {
      throw new Error(`state migration catalog is not contiguous at version ${index + 1}`);
    }
    if (names.has(migration.name)) throw new Error(`duplicate state migration name: ${migration.name}`);
    names.add(migration.name);
    const calculatedChecksum = checksum(migration.sql);
    if (migration.checksum !== calculatedChecksum) {
      throw new Error(`state migration checksum mismatch: ${migration.name}; expected ${migration.checksum}, calculated ${calculatedChecksum}`);
    }
  }
}

assertValidMigrationCatalog();
