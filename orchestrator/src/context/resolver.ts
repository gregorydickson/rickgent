import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import {
  capabilityRegistry,
  CLAIMS_SCHEMA_VERSION,
  RELEASE_CHANNEL,
  RELEASE_LABEL,
} from "../capabilities/registry.js";
import {
  canonicalJson,
  normalizeTicketContracts,
  type TicketContract,
} from "../contracts/ticket-contract.js";
import type { RouterSelection } from "../lifecycle/routing.js";
import type { PolicyBundleHandle } from "../policy/policy-bundle.js";
import {
  type AllocatedAttempt,
  type AllocatedRun,
  type AttemptAllocationInput,
  type ImmutableJsonInput,
  type PersistedExecutionContextRows,
  type ResumeCompatibilityInput,
  type ResumeSelection,
  type RetryCompatibilityInput,
  type RetrySelection,
  StateStore,
} from "../state/store.js";
import {
  createDurableExecutionContext,
  DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
  type CanonicalDurableExecutionContext,
} from "./execution-context.js";

export const RUN_MANIFEST_SCHEMA_VERSION = "rickgent.run-manifest/v1" as const;
export const RESOURCE_IDENTITY_VERSION = "rickgent.attempt-resource-identity/v1" as const;

export interface ResolveFreshRunInput {
  readonly contracts: readonly TicketContract[];
  readonly initialDeliveryOid: string;
  readonly oracleVersion: string;
}

export interface ResolvePhaseContextInput {
  readonly attempt: AllocatedAttempt;
  readonly contract: TicketContract;
  readonly phase: string;
  readonly phaseOrdinal: number;
  readonly role: string;
  readonly worktreeRealpath: string;
  readonly policyBundle: Readonly<Pick<PolicyBundleHandle,
    "kind" | "policyRoot" | "bundleDir" | "requestedBundleSha256">>;
  readonly modelSelection: Readonly<RouterSelection>;
  readonly timeoutMs: number;
}

export interface ResolvedPhaseContext {
  readonly canonical: CanonicalDurableExecutionContext;
  readonly persisted: PersistedExecutionContextRows;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function canonicalImmutableJson(value: Readonly<Record<string, unknown>>, label: string): ImmutableJsonInput {
  if (typeof value.schema_version !== "string" || value.schema_version === "") {
    throw new TypeError(`${label}.schema_version must be a nonempty string`);
  }
  const text = canonicalJson(value);
  return Object.freeze({ schemaVersion: value.schema_version, canonicalJson: text, digest: sha256(text) });
}

export function compiledCapabilitySnapshot(): ImmutableJsonInput {
  return canonicalImmutableJson({
    schema_version: "rickgent.capability-snapshot/v1",
    claims_schema_version: CLAIMS_SCHEMA_VERSION,
    release_channel: RELEASE_CHANNEL,
    release_label: RELEASE_LABEL,
    capabilities: capabilityRegistry(),
  }, "compiled capability snapshot");
}

function canonicalRealpath(path: string, label: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    throw new TypeError(`${label} must resolve to an existing canonical path`, { cause: error });
  }
}

/**
 * Internal identity boundary. It deliberately has no CLI wiring or capability switch;
 * t16 owns activation after lifecycle and recovery are ready.
 */
export class IdentityContextResolver {
  readonly store: StateStore;

  constructor(store: StateStore) {
    this.store = store;
  }

  allocateFreshRun(input: ResolveFreshRunInput): AllocatedRun {
    const contracts = normalizeTicketContracts(input.contracts, {
      repositoryRoot: this.store.location.repoRealpath,
      stateRoots: [this.store.location.stateDirectory, this.store.location.resourceDirectory],
    });
    const capabilitySnapshot = compiledCapabilitySnapshot();
    const tickets = contracts.map((contract, planIndex) => {
      const { digest: suppliedDigest, ...payload } = contract;
      const canonicalContractJson = canonicalJson(payload);
      const contractDigest = sha256(canonicalContractJson);
      if (contractDigest !== suppliedDigest) throw new TypeError(`ticket ${contract.id} digest changed after normalization`);
      return {
        ticketId: contract.id,
        planIndex,
        contract: {
          schemaVersion: contract.schema_version,
          canonicalJson: canonicalContractJson,
          digest: contractDigest,
        },
        dependsOnTicketIds: contract.depends_on,
      };
    });
    const manifestPayload = {
      schema_version: RUN_MANIFEST_SCHEMA_VERSION,
      repository_id: this.store.location.repositoryId,
      repo_realpath: this.store.location.repoRealpath,
      git_common_dir_realpath: this.store.location.gitCommonDirRealpath,
      object_format: this.store.location.objectFormat,
      context_schema_version: DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
      oracle_version: input.oracleVersion,
      resource_identity_version: RESOURCE_IDENTITY_VERSION,
      capability_snapshot_schema_version: capabilitySnapshot.schemaVersion,
      capability_snapshot_digest: capabilitySnapshot.digest,
      capability_snapshot: JSON.parse(capabilitySnapshot.canonicalJson) as unknown,
      tickets: tickets.map((ticket) => ({
        ticket_id: ticket.ticketId,
        plan_index: ticket.planIndex,
        contract_digest: ticket.contract.digest,
        depends_on_ticket_ids: [...ticket.dependsOnTicketIds],
      })),
    };
    const canonicalManifestJson = canonicalJson(manifestPayload);
    return this.store.allocateFreshRun({
      manifest: {
        schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
        canonicalJson: canonicalManifestJson,
        digest: sha256(canonicalManifestJson),
        capabilitySnapshot,
        contextSchemaVersion: DURABLE_EXECUTION_CONTEXT_SCHEMA_VERSION,
        oracleVersion: input.oracleVersion,
        resourceIdentityVersion: RESOURCE_IDENTITY_VERSION,
      },
      tickets,
      initialDeliveryOid: input.initialDeliveryOid,
    });
  }

  allocateInitialAttempt(input: AttemptAllocationInput): AllocatedAttempt {
    return this.store.allocateInitialAttempt(input);
  }

  allocateRetryAttempt(input: RetryCompatibilityInput): AllocatedAttempt {
    return this.store.allocateRetryAttempt(input);
  }

  selectCompatibleResume(input: ResumeCompatibilityInput): ResumeSelection {
    return this.store.selectCompatibleResume(input);
  }

  selectCompatibleRetry(input: RetryCompatibilityInput): RetrySelection {
    return this.store.selectCompatibleRetry(input);
  }

  resolvePhaseContext(input: ResolvePhaseContextInput): ResolvedPhaseContext {
    const [contract] = normalizeTicketContracts([input.contract], {
      repositoryRoot: this.store.location.repoRealpath,
      stateRoots: [this.store.location.stateDirectory, this.store.location.resourceDirectory],
      knownExternalDependencyIds: input.contract.depends_on,
    });
    if (contract === undefined || contract.id !== input.attempt.ticketId || contract.digest !== input.attempt.contractDigest) {
      throw new TypeError("phase context contract does not match its allocated attempt");
    }
    if (input.policyBundle.kind !== "materialized_authenticated_policy_bundle") {
      throw new TypeError("phase context requires an authenticated materialized policy bundle");
    }
    if (!/^[0-9a-f]{64}$/.test(input.policyBundle.requestedBundleSha256)) {
      throw new TypeError("authenticated policy bundle requested digest must be lowercase SHA-256");
    }
    const policyRootRealpath = canonicalRealpath(input.policyBundle.policyRoot, "policyBundle.policyRoot");
    const bundleRootRealpath = canonicalRealpath(input.policyBundle.bundleDir, "policyBundle.bundleDir");
    const bundleWithinPolicy = relative(policyRootRealpath, bundleRootRealpath);
    if (bundleWithinPolicy === ".." || bundleWithinPolicy.startsWith(`..${sep}`) || isAbsolute(bundleWithinPolicy)) {
      throw new TypeError("authenticated policy bundle directory must be contained by its policy root");
    }
    const selection = {
      harness: input.modelSelection.harness,
      model: input.modelSelection.model,
      vendor: input.modelSelection.vendor,
    };
    if (Object.values(selection).some((value) => typeof value !== "string" || value === "" || value !== value.trim())) {
      throw new TypeError("model selection must contain canonical nonempty harness, model, and vendor values");
    }
    const modelSelectionDigest = sha256(canonicalJson({
      schema_version: "rickgent.router-selection/v1",
      ...selection,
    }));
    const policyBundleDigest = `sha256:${input.policyBundle.requestedBundleSha256}`;
    const canonical = createDurableExecutionContext({
      contextSchemaVersion: input.attempt.contextSchemaVersion,
      repositoryId: this.store.location.repositoryId,
      repoRealpath: this.store.location.repoRealpath,
      gitCommonDirRealpath: this.store.location.gitCommonDirRealpath,
      objectFormat: this.store.location.objectFormat,
      stateRootRealpath: this.store.location.stateDirectory,
      resourceRootRealpath: this.store.location.resourceDirectory,
      worktreeRealpath: canonicalRealpath(input.worktreeRealpath, "worktreeRealpath"),
      policyRootRealpath,
      bundleRootRealpath,
      runId: input.attempt.runId,
      ticketInstanceId: input.attempt.ticketInstanceId,
      ticketId: input.attempt.ticketId,
      attemptId: input.attempt.attemptId,
      attemptNumber: input.attempt.attemptNumber,
      phase: input.phase,
      phaseOrdinal: input.phaseOrdinal,
      role: input.role,
      contractDigest: input.attempt.contractDigest,
      capabilitySnapshotDigest: input.attempt.capabilitySnapshotDigest,
      policyBundleDigest,
      modelSelectionDigest,
      oracleVersion: input.attempt.oracleVersion,
      resourceIdentityVersion: input.attempt.resourceIdentityVersion,
      budgets: contract.budgets,
      timeoutMs: input.timeoutMs,
      scope: contract.scope,
    });
    const persisted = this.store.persistDurableExecutionContext({
      attemptId: input.attempt.attemptId,
      phase: input.phase,
      phaseOrdinal: input.phaseOrdinal,
      role: input.role,
      worktreeRealpath: canonical.context.worktree_realpath,
      policyRootRealpath: canonical.context.policy_root_realpath,
      bundleRootRealpath: canonical.context.bundle_root_realpath,
      timeoutMs: canonical.context.timeout_ms,
      canonicalContextJson: canonical.canonicalContextJson,
      policyBundleDigest,
      modelSelectionDigest,
      budgetDigest: canonical.budgetDigest,
      scopeDigest: canonical.scopeDigest,
    });
    if (persisted.contextDigest !== canonical.contextDigest) {
      throw new Error("persisted execution context digest differs from its canonical document");
    }
    return Object.freeze({ canonical, persisted });
  }
}
