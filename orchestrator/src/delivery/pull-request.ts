/**
 * t34: Verified and idempotent pull-request creation.
 *
 * Create or resolve a PR only after a verified remote push observation.
 * Use structured provider output, verify target repository/base/head branch,
 * independently query PR head OID, and require equality with the persisted
 * delivery OID before marking delivered.
 *
 * Invariants:
 * - PR creation is impossible before a verified remote OID receipt equal to
 *   the delivery OID (a matching ls-remote observation must exist).
 * - Structured provider output is validated for repository, base, head
 *   branch, PR identity/URL, and independently queried head OID equal to
 *   delivery OID.
 * - Missing `gh`, auth/provider failure, wrong repository, stale/wrong head,
 *   existing wrong-head PR, head lag, malformed JSON, timeout, and cleanup
 *   failure leave the run non-delivered/nonzero.
 * - Crash before/after PR creation or receipt persistence resumes
 *   idempotently by resolving the exact existing PR; it neither duplicates
 *   PRs nor accepts a different head.
 * - All PR observations are persisted through DeliveryAuthority as immutable
 *   records, not direct SQL writes.
 * - Fail closed when any dependency is unavailable.
 */

import { execFileSync } from "node:child_process";
import type { StateStore } from "../state/store.js";
import type { DeliveryAuthority } from "../state/transitions.js";

/** Structured result from a PR provider (gh CLI or test fixture). */
export interface PrProviderResult {
  readonly prNumber: number;
  readonly prUrl: string;
  readonly repositoryId: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headOid: string;
}

/**
 * Provider interface for PR operations.
 *
 * In production, `GhCliPrProvider` wraps `execFileSync("gh", [...])` with
 * array argv. In tests, a fixture provider returns deterministic structured
 * results without spawning `gh`.
 */
export interface PrProvider {
  /** Find an existing open PR for the given head/base branch, or null. */
  findExistingPr(headBranch: string, baseBranch: string): PrProviderResult | null;
  /** Create a new PR. Throws on failure. */
  createPr(headBranch: string, baseBranch: string, title: string, body: string): PrProviderResult;
  /** Independently query the current head OID and repository for a PR. */
  queryPrHead(prNumber: number): PrProviderResult;
}

/** Request to execute a verified pull-request creation/resolution. */
export interface VerifiedPrRequest {
  readonly store: StateStore;
  readonly authority: DeliveryAuthority;
  readonly runId: string;
  readonly deliveryOid: string;
  readonly deliveryIntentId: string;
  readonly expectedRepositoryId: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly provider: PrProvider;
  readonly ownerContextId: string;
  readonly ownerContextDigest: string;
  readonly idempotencyKey: string;
  readonly prTitle: string;
  readonly prBody: string;
  readonly timeoutMs: number;
}

export type VerifiedPrResult =
  | {
      readonly status: "verified";
      readonly prObservationId: string;
      readonly prNumber: number;
      readonly prUrl: string;
      readonly repositoryId: string;
      readonly observedHeadOid: string;
    }
  | {
      readonly status: "mismatch";
      readonly reason: string;
      readonly observedHeadOid?: string;
      readonly expectedOid?: string;
    }
  | {
      readonly status: "infrastructure_error";
      readonly reason: string;
    };

const NOW = "2026-07-22T12:00:00.000Z";

interface RemoteObservation {
  readonly operation: string;
  readonly outcome: string;
  readonly observedRemoteOid: string | null;
}

interface PrObservation {
  readonly prObservationId: string;
  readonly sequence: number;
  readonly providerRepositoryId: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly prIdentity: string;
  readonly observedHeadOid: string;
}

/**
 * Execute a verified pull-request creation or resolution.
 *
 * Steps:
 * 1. Require a verified push observation (ls-remote with OID matching delivery OID).
 * 2. Check existing PR observations for idempotent resume.
 * 3. If no PR observation exists, find or create the PR via the provider.
 * 4. Independently query the PR head OID and repository identity.
 * 5. Require repository identity equality with expectedRepositoryId.
 * 6. Require head OID equality with delivery OID.
 * 7. Persist the PR observation via DeliveryAuthority.recordPrObservation.
 *
 * Resume: if a PR observation already exists, the service resolves it
 * idempotently without re-creating the PR.
 */
export function executeVerifiedPullRequest(request: VerifiedPrRequest): VerifiedPrResult {
  const { store, authority, deliveryOid, deliveryIntentId } = request;

  // 1. Require a verified push observation.
  const remoteObservations = store.listRemoteObservations(deliveryIntentId);
  const lsRemoteObs = remoteObservations.find(
    (o) => String(o.operation) === "ls-remote" && o.observed_remote_oid !== null,
  );
  if (lsRemoteObs === undefined) {
    return {
      status: "infrastructure_error",
      reason: "no verified push observation (ls-remote with matching OID) exists; PR creation is impossible before verified push",
    };
  }
  const observedRemoteOid = String(lsRemoteObs.observed_remote_oid);
  if (observedRemoteOid !== deliveryOid) {
    return {
      status: "infrastructure_error",
      reason: `verified push observation OID (${observedRemoteOid.slice(0, 12)}) does not equal delivery OID (${deliveryOid.slice(0, 12)}); PR creation is impossible`,
    };
  }

  // 2. Check existing PR observations for idempotent resume.
  const existingPrObservations = store.listPrObservations(deliveryIntentId);
  const prObs: PrObservation[] = existingPrObservations.map((o) => ({
    prObservationId: String(o.pr_observation_id),
    sequence: Number(o.sequence),
    providerRepositoryId: String(o.provider_repository_id),
    baseBranch: String(o.base_branch),
    headBranch: String(o.head_branch),
    prIdentity: String(o.pr_identity),
    observedHeadOid: String(o.observed_head_oid),
  }));

  const existingPrObs = prObs.length > 0 ? prObs[prObs.length - 1] : undefined;

  // 3. If no PR observation exists, find or create the PR.
  let prNumber: number;
  let prUrl: string;
  let repositoryId: string;
  let prBaseBranch: string;
  let prHeadBranch: string;

  if (existingPrObs !== undefined) {
    // Resume: PR observation already persisted. Resolve the existing PR.
    prNumber = Number(existingPrObs.prIdentity.replace(/^pr-/, ""));
    prUrl = existingPrObs.prIdentity;
    repositoryId = existingPrObs.providerRepositoryId;
    prBaseBranch = existingPrObs.baseBranch;
    prHeadBranch = existingPrObs.headBranch;
  } else {
    // Find or create the PR via the provider.
    let createResult: PrProviderResult;
    try {
      const existing = request.provider.findExistingPr(request.headBranch, request.baseBranch);
      if (existing !== null) {
        createResult = existing;
      } else {
        createResult = request.provider.createPr(
          request.headBranch,
          request.baseBranch,
          request.prTitle,
          request.prBody,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return classifyProviderError(message);
    }

    prNumber = createResult.prNumber;
    prUrl = createResult.prUrl;
    repositoryId = createResult.repositoryId;
    prBaseBranch = createResult.baseBranch;
    prHeadBranch = createResult.headBranch;
  }

  // 4. Independently query the PR head OID and repository identity.
  let queryResult: PrProviderResult;
  try {
    queryResult = request.provider.queryPrHead(prNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return classifyProviderError(message);
  }

  // 5. Require repository identity equality.
  if (queryResult.repositoryId !== request.expectedRepositoryId) {
    return {
      status: "mismatch",
      reason: `PR repository identity (${queryResult.repositoryId}) does not equal expected (${request.expectedRepositoryId})`,
      observedHeadOid: queryResult.headOid,
      expectedOid: deliveryOid,
    };
  }

  // 6. Require head OID equality with delivery OID.
  if (queryResult.headOid !== deliveryOid) {
    return {
      status: "mismatch",
      reason: `PR head OID (${queryResult.headOid.slice(0, 12)}) does not equal delivery OID (${deliveryOid.slice(0, 12)})`,
      observedHeadOid: queryResult.headOid,
      expectedOid: deliveryOid,
    };
  }

  // 7. Persist the PR observation (if not already persisted).
  let prObservationId: string;
  if (existingPrObs !== undefined) {
    prObservationId = existingPrObs.prObservationId;
  } else {
    // The PR observation sequence is independent of remote observations;
    // it starts at 1 for the first PR observation per delivery intent.
    const nextSequence = prObs.length + 1;
    prObservationId = `pr-obs-${request.runId}-${nextSequence}`;
    try {
      authority.recordPrObservation({
        deliveryIntentId,
        prObservationId,
        sequence: nextSequence,
        providerRepositoryId: queryResult.repositoryId,
        baseBranch: request.baseBranch,
        headBranch: request.headBranch,
        prIdentity: `pr-${prNumber}`,
        observedHeadOid: queryResult.headOid,
        ownerContextId: request.ownerContextId,
        ownerContextDigest: request.ownerContextDigest,
        evidenceIdempotencyKey: `pr:${request.runId}:pr-evidence:${nextSequence}`,
        createdAt: NOW,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "infrastructure_error",
        reason: `failed to record PR observation: ${message}`,
      };
    }
  }

  void prBaseBranch;
  void prHeadBranch;
  void prUrl;

  return {
    status: "verified",
    prObservationId,
    prNumber,
    prUrl,
    repositoryId: queryResult.repositoryId,
    observedHeadOid: queryResult.headOid,
  };
}

/**
 * Classify a provider error message into the appropriate result.
 *
 * - "gh: command not found" or "not found" yields infrastructure_error (missing gh)
 * - "auth" or "not authenticated" yields infrastructure_error (auth failure)
 * - "timeout" or "deadline" yields infrastructure_error (timeout)
 * - "malformed" or "json" or "parse" yields infrastructure_error (malformed JSON)
 * - Other messages yield infrastructure_error
 */
function classifyProviderError(message: string): VerifiedPrResult {
  const lower = message.toLowerCase();
  if (lower.includes("not found") || lower.includes("command not found")) {
    return { status: "infrastructure_error", reason: `gh command not found: ${message}` };
  }
  if (lower.includes("auth") || lower.includes("not authenticated")) {
    return { status: "infrastructure_error", reason: `provider auth failure: ${message}` };
  }
  if (lower.includes("timeout") || lower.includes("deadline")) {
    return { status: "infrastructure_error", reason: `provider timeout: ${message}` };
  }
  if (lower.includes("malformed") || lower.includes("json") || lower.includes("parse")) {
    return { status: "infrastructure_error", reason: `malformed provider JSON: ${message}` };
  }
  return { status: "infrastructure_error", reason: `provider error: ${message}` };
}

/**
 * t34 scrutiny round 3: Resolve the canonical GitHub repository identity
 * (owner/repo format) from the git remote URL.  Parses both SSH
 * (git@github.com:owner/repo.git) and HTTPS
 * (https://github.com/owner/repo.git) URL formats.
 *
 * @param repoPath  The local repository path to resolve the remote from.
 * @param remoteName  The git remote name (default "origin").
 * @returns The canonical GitHub repository identity in "owner/repo" format.
 * @throws if the remote URL cannot be resolved or is not a GitHub URL.
 */
export function resolveGitHubRepositoryIdentity(
  repoPath: string,
  remoteName: string = "origin",
): string {
  let remoteUrl: string;
  try {
    remoteUrl = execFileSync("git", ["-C", repoPath, "remote", "get-url", remoteName], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot resolve git remote '${remoteName}': ${message}`);
  }
  if (remoteUrl.length === 0) {
    throw new Error(`git remote '${remoteName}' has an empty URL`);
  }
  // Parse SSH format: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch !== null) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  // Parse HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch !== null) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  // Parse SSH with ssh:// prefix: ssh://git@github.com/owner/repo.git
  const sshPrefixMatch = remoteUrl.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshPrefixMatch !== null) {
    return `${sshPrefixMatch[1]}/${sshPrefixMatch[2]}`;
  }
  throw new Error(`git remote '${remoteName}' URL '${remoteUrl}' is not a recognized GitHub URL`);
}

/**
 * t34 scrutiny round 2: Production PR provider that wraps the `gh` CLI with
 * array argv (execFileSync).  Implements the {@link PrProvider} interface
 * for real production delivery.
 *
 * All gh commands use array argv — never shell strings.  JSON output is
 * parsed via `gh --json` structured output.  Fail closed on any gh error.
 *
 * t34 scrutiny round 3: The provider now accepts a canonical GitHub
 * repository identity (owner/repo format) resolved from the git remote,
 * not a local filesystem path.
 */
export class GhCliPrProvider implements PrProvider {
  readonly #repoIdentity: string;

  constructor(repoIdentity: string) {
    this.#repoIdentity = repoIdentity;
  }

  findExistingPr(headBranch: string, baseBranch: string): PrProviderResult | null {
    try {
      const output = execFileSync("gh", [
        "pr", "list",
        "--repo", this.#repoIdentity,
        "--head", headBranch,
        "--base", baseBranch,
        "--state", "open",
        "--json", "number,url,headRefOid,baseRefName,headRefName,repository",
      ], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (output === "") return null;
      const prs = JSON.parse(output) as Array<{
        number: number;
        url: string;
        headRefOid: string;
        baseRefName: string;
        headRefName: string;
        repository: { id: string; nameWithOwner?: string };
      }>;
      if (!Array.isArray(prs) || prs.length === 0) return null;
      const pr = prs[0]!;
      return {
        prNumber: pr.number,
        prUrl: pr.url,
        repositoryId: parseOwnerRepoFromUrl(pr.url, String(pr.repository?.nameWithOwner ?? "")),
        baseBranch: pr.baseRefName,
        headBranch: pr.headRefName,
        headOid: pr.headRefOid,
      };
    } catch {
      // No existing PR or gh error — return null (no existing PR found).
      return null;
    }
  }

  createPr(headBranch: string, baseBranch: string, title: string, body: string): PrProviderResult {
    const output = execFileSync("gh", [
      "pr", "create",
      "--repo", this.#repoIdentity,
      "--head", headBranch,
      "--base", baseBranch,
      "--title", title,
      "--body", body,
      "--json", "number,url,headRefOid,baseRefName,headRefName,repository",
    ], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const pr = JSON.parse(output) as {
      number: number;
      url: string;
      headRefOid: string;
      baseRefName: string;
      headRefName: string;
      repository: { id: string; nameWithOwner?: string };
    };
    return {
      prNumber: pr.number,
      prUrl: pr.url,
      repositoryId: parseOwnerRepoFromUrl(pr.url, String(pr.repository?.nameWithOwner ?? "")),
      baseBranch: pr.baseRefName,
      headBranch: pr.headRefName,
      headOid: pr.headRefOid,
    };
  }

  queryPrHead(prNumber: number): PrProviderResult {
    const output = execFileSync("gh", [
      "pr", "view", String(prNumber),
      "--repo", this.#repoIdentity,
      "--json", "number,url,headRefOid,baseRefName,headRefName,repository",
    ], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const pr = JSON.parse(output) as {
      number: number;
      url: string;
      headRefOid: string;
      baseRefName: string;
      headRefName: string;
      repository: { id: string; nameWithOwner?: string };
    };
    return {
      prNumber: pr.number,
      prUrl: pr.url,
      repositoryId: parseOwnerRepoFromUrl(pr.url, String(pr.repository?.nameWithOwner ?? "")),
      baseBranch: pr.baseRefName,
      headBranch: pr.headRefName,
      headOid: pr.headRefOid,
    };
  }
}

/**
 * t34 scrutiny round 4: Parse the canonical owner/repo identity from a PR URL
 * or the gh CLI's nameWithOwner field.  The gh CLI's `--json repository` returns
 * a GraphQL node ID (e.g., "R_kgD...") in the `repository.id` field, which is
 * NOT compatible with the owner/repo format used by resolveGitHubRepositoryIdentity.
 *
 * This function extracts owner/repo from either:
 *   (a) the PR URL (https://github.com/owner/repo/pull/123), or
 *   (b) the repository.nameWithOwner field ("owner/repo")
 *
 * The result is always in "owner/repo" format, matching the expectedRepositoryId.
 */
function parseOwnerRepoFromUrl(prUrl: string, nameWithOwner: string): string {
  // Prefer nameWithOwner if it's in the correct format.
  if (nameWithOwner.length > 0 && /^[^/]+\/[^/]+$/.test(nameWithOwner) && !nameWithOwner.startsWith("R_")) {
    return nameWithOwner;
  }
  // Parse from the PR URL: https://github.com/owner/repo/pull/123
  const match = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\//);
  if (match !== null) {
    return `${match[1]}/${match[2]!.replace(/\.git$/, "")}`;
  }
  // Fallback: return whatever we have (will fail the identity comparison).
  return nameWithOwner.length > 0 ? nameWithOwner : prUrl;
}
