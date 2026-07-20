/**
 * t22B: TargetStartGateAuthority — the production authority that owns the
 * durable target start gate's `held -> released` and `held -> closed_never_released`
 * edges.  It is the integration point between the containment backend
 * (`orchestrator/src/process/containment.ts`) and the durable state store
 * (`orchestrator/src/state/store.ts`).
 *
 * Production invariants (VAL-T22B-002, VAL-T22B-004, VAL-T22B-005):
 *   - Target code cannot begin before containment membership is authoritative.
 *     `releaseTarget` asserts a brand-authorized `ContainmentMembership` bound
 *     to the exact attempt lineage before transitioning `held -> released`.
 *   - Unavailable containment fails closed: `closeNeverReleased` transitions
 *     `held -> closed_never_released` and no terminal receipt is manufactured.
 *   - A structurally-correct `authoritative_containment` field from an injected
 *     controller is not trusted; only the authority-owned backend can mint a
 *     membership that `releaseTarget` accepts.
 */
import {
  RICKGENT_CONTAINMENT_UNAVAILABLE,
  type ContainmentBackend,
  type ContainmentLineage,
  type ContainmentMembership,
  type ContainmentNeverReleasedReceipt,
} from "../process/containment.js";
import { LeaseAuthority } from "../state/leases.js";
import type {
  MintTargetReleasedRequest,
  MintedContainmentReleaseReceipt,
  StateStore,
} from "../state/store.js";
import type { TargetNeverReleasedObservation } from "./disposition.js";

export interface TargetStartGateReleaseInput {
  readonly gateId: string;
  readonly lineage: ContainmentLineage;
  /** Authority-owned containment membership (brand-checked by the Store). */
  readonly membership: ContainmentMembership;
  readonly observedAt: string;
}

export interface TargetStartGateNeverReleasedInput {
  readonly gateId: string;
  readonly lineage: ContainmentLineage;
  readonly reason:
    | "containment_unavailable"
    | "policy_unavailable"
    | "executable_unavailable"
    | "output_unavailable"
    | "spawn_failed";
  readonly observedAt: string;
}

/**
 * Production authority that owns the target start gate transitions.  The
 * `AttemptRunner` (t22C) constructs this with the probed `ContainmentBackend`
 * and the `LeaseAuthority`-branded mint capability; it is the sole production
 * route for releasing or closing a held target start gate.
 */
export class TargetStartGateAuthority {
  readonly #store: StateStore;
  readonly #leases: LeaseAuthority;
  readonly #backend: ContainmentBackend;

  constructor(store: StateStore, leases: LeaseAuthority, backend: ContainmentBackend) {
    this.#store = store;
    this.#leases = leases;
    this.#backend = backend;
  }

  /** The bound containment backend (for probe inspection by callers). */
  get backend(): ContainmentBackend { return this.#backend; }

  /**
   * Transition `held -> released` after observing an authority-owned
   * containment membership.  A forged or foreign-lineage membership is
   * rejected by the Store command (fail closed to
   * `RICKGENT_CONTAINMENT_UNAVAILABLE`); the gate remains held.
   */
  releaseTarget(input: TargetStartGateReleaseInput): MintedContainmentReleaseReceipt {
    const m = input.membership;
    const request: MintTargetReleasedRequest = {
      gateId: input.gateId,
      attemptId: input.lineage.attemptId,
      ownershipId: input.lineage.ownershipId,
      ownerGeneration: input.lineage.ownerGeneration,
      phaseExecutionId: input.lineage.phaseExecutionId,
      contextId: input.lineage.contextId,
      membership: m,
      launchId: m.boundary.launchId,
      backendId: m.boundary.backendId,
      boundaryName: m.boundary.boundaryName,
      membershipDigest: m.membershipDigest,
      observedAt: input.observedAt,
    };
    return this.#store.mintTargetReleased(request);
  }

  /**
   * Transition `held -> closed_never_released` when containment is
   * unavailable or a pre-release failure occurs.  No terminal receipt is
   * manufactured; the never-released receipt is the proof that target code
   * never began.
   */
  closeNeverReleased(input: TargetStartGateNeverReleasedInput): { readonly receipt: import("../lifecycle/disposition.js").TargetNeverReleasedReceipt; readonly record: unknown; readonly evidence: unknown; readonly replayed: boolean } {
    const capability = this.#leases.issueDispositionMintCapability();
    const observation: TargetNeverReleasedObservation = {
      kind: "target_never_released_observation",
      receiptId: `tnr-${input.lineage.attemptId}`,
      attemptId: input.lineage.attemptId,
      ownershipId: input.lineage.ownershipId,
      ownerGeneration: input.lineage.ownerGeneration,
      ownershipContextDigest: input.lineage.ownershipContextDigest,
      contextId: input.lineage.contextId,
      phaseExecutionId: input.lineage.phaseExecutionId,
      launchId: null,
      gateId: input.gateId,
      gateVersion: 1,
      containmentId: null,
      containmentDisposition: "not_created",
      containmentEvidenceDigest: null,
      reason: input.reason,
      observedAt: input.observedAt,
    };
    return this.#store.mintTargetNeverReleased({ observation }, capability);
  }

  /**
   * Mint a containment never-released receipt from the backend (the
   * fail-closed proof that the backend was unavailable).  This is the
   * pre-release infrastructure error proof; the caller then calls
   * `closeNeverReleased` to transition the gate.
   */
  mintBackendNeverReleasedReceipt(lineage: ContainmentLineage, reason: string): ContainmentNeverReleasedReceipt {
    return this.#backend.mintNeverReleasedReceipt(lineage, reason);
  }

  /** The fail-closed exit code for unavailable containment. */
  static readonly UNAVAILABLE_EXIT_CODE = RICKGENT_CONTAINMENT_UNAVAILABLE;
}
