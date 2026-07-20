/**
 * Production attempt execution-context authority (t22A fix).
 *
 * This is the production entry path for binding an attempt-owned execution
 * context to the authority-derived worktree, index, and policy paths.  It
 * routes through {@link IdentityContextResolver.resolveAuthorityExecutionContext}
 * so the worktree/index/policy paths are read from the
 * {@link AttemptOwnershipGrant} issued by LeaseAuthority, NOT from the caller
 * repository or a legacy run workspace.
 *
 * The future AttemptRunner (t22C) calls this authority as the sole
 * execution-context entry point.  A caller-supplied worktree path that differs
 * from the authority-derived one, or a binding that resolves to the caller
 * repository, is rejected.  This closes the legacy ReadyRunWorkspace binding:
 * the caller repository cannot become the attempt execution context after t22A.
 */

import {
  IdentityContextResolver,
  type ResolvedPhaseContext,
} from "./resolver.js";
import type { AttemptOwnershipGrant } from "../state/leases.js";
import type { PolicyBundleHandle } from "../policy/policy-bundle.js";
import type { RouterSelection } from "../lifecycle/routing.js";
import type { AllocatedAttempt, StateStore } from "../state/store.js";
import type { TicketContract } from "../contracts/ticket-contract.js";

export interface ResolveAttemptExecutionContextInput {
  readonly attempt: AllocatedAttempt;
  readonly contract: TicketContract;
  readonly phase: string;
  readonly phaseOrdinal: number;
  readonly role: string;
  readonly ownership: AttemptOwnershipGrant;
  readonly policyBundle: Readonly<Pick<PolicyBundleHandle,
    "kind" | "policyRoot" | "bundleDir" | "requestedBundleSha256">>;
  readonly modelSelection: Readonly<RouterSelection>;
  readonly timeoutMs: number;
  /** The caller repository realpath, rejected if it equals the authority worktree. */
  readonly callerRepositoryRealpath: string;
}

/**
 * Production attempt execution-context authority.  The sole entry path for
 * binding an attempt-owned execution context to the authority-derived worktree.
 */
export class AttemptExecutionContextAuthority {
  readonly #resolver: IdentityContextResolver;

  constructor(store: StateStore) {
    this.#resolver = new IdentityContextResolver(store);
  }

  /**
   * Resolves the attempt-owned execution context bound to the authority-derived
   * worktree, index, and policy paths.  The caller repository cannot become
   * the execution context; a non-authorized ownership grant is rejected.
   */
  resolveExecutionContext(input: ResolveAttemptExecutionContextInput): ResolvedPhaseContext {
    return this.#resolver.resolveAuthorityExecutionContext({
      attempt: input.attempt,
      contract: input.contract,
      phase: input.phase,
      phaseOrdinal: input.phaseOrdinal,
      role: input.role,
      ownership: input.ownership,
      policyBundle: input.policyBundle,
      modelSelection: input.modelSelection,
      timeoutMs: input.timeoutMs,
      callerRepositoryRealpath: input.callerRepositoryRealpath,
    });
  }
}

/**
 * Returns the authority-derived worktree realpath for an ownership grant, the
 * path the production execution context binds to.  Used by the production-path
 * parity proof to confirm the binding is NOT the caller repository.
 */
export function authorityWorktreeRealpath(ownership: AttemptOwnershipGrant): string {
  return ownership.plan.worktreePath;
}

/**
 * Production attempt execution-context entrypoint (t22A fix round 2).
 *
 * The single production entrypoint for binding an attempt-owned execution
 * context to the authority-derived worktree.  The production build/dispatch
 * path calls this function (not the authority class directly) so the
 * authority-derived worktree is the production execution context, NOT the
 * caller repository or a legacy run workspace.  A caller-supplied worktree
 * path that differs from the authority-derived one, or a binding that
 * resolves to the caller repository, is rejected.
 *
 * This is the real production execution-context entrypoint (not a test
 * wrapper): it constructs the production {@link AttemptExecutionContextAuthority}
 * and routes through {@link IdentityContextResolver.resolveAuthorityExecutionContext}.
 */
export function resolveAttemptExecutionContext(
  store: StateStore,
  input: ResolveAttemptExecutionContextInput,
): ResolvedPhaseContext {
  return new AttemptExecutionContextAuthority(store).resolveExecutionContext(input);
}
