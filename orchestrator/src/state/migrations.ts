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

function releasedObjectNames(sql: string, kind: "TABLE" | "INDEX" | "TRIGGER"): readonly string[] {
  const names = [...sql.matchAll(new RegExp(`CREATE (?:UNIQUE )?${kind} ([a-z0-9_]+)`, "g"))]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  return Object.freeze(names);
}

export const INITIAL_STATE_SCHEMA_OBJECTS = Object.freeze({
  tables: releasedObjectNames(INITIAL_SQL, "TABLE"),
  indexes: releasedObjectNames(INITIAL_SQL, "INDEX"),
  triggers: releasedObjectNames(INITIAL_SQL, "TRIGGER"),
});

const ATTEMPT_OWNERSHIP_STATE_SQL = `${INITIAL_SQL}${ATTEMPT_OWNERSHIP_SQL}`;
const LATEST_SQL = `${ATTEMPT_OWNERSHIP_STATE_SQL}${PROCESS_SUPERVISION_SQL}`;

export const ATTEMPT_OWNERSHIP_STATE_SCHEMA_OBJECTS = Object.freeze({
  tables: releasedObjectNames(ATTEMPT_OWNERSHIP_STATE_SQL, "TABLE"),
  indexes: releasedObjectNames(ATTEMPT_OWNERSHIP_STATE_SQL, "INDEX"),
  triggers: releasedObjectNames(ATTEMPT_OWNERSHIP_STATE_SQL, "TRIGGER"),
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

export const LATEST_STATE_SQLITE_SCHEMA_CHECKSUM =
  "sha256:c208339c0350aae8bd1ee3784da4e4ffc559b41e9c6079530a89da53c08753e3" as const;

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
