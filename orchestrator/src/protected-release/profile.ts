import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export const PROTECTED_PROFILE_SCHEMA_VERSION = "rickgent-protected-release-profile/v1" as const;

export interface ProtectedReleaseProfile {
  readonly schema_version: typeof PROTECTED_PROFILE_SCHEMA_VERSION;
  readonly authority_token: string;
  readonly npm_archive_sha256: string;
  readonly wheel_archive_sha256: string;
  readonly manager_entrypoint: string;
  readonly worker_entrypoint: string;
  readonly repository: {
    readonly host: string;
    readonly owner: string;
    readonly name: string;
    readonly repository_id: string;
    readonly visibility: "private" | "internal";
    readonly allowlisted_disposable: true;
    readonly pre_existing: true;
    readonly base_branch: string;
    readonly owned_branch_prefix: string;
  };
  readonly command_timeout_ms: number;
}

export class ProtectedProfileError extends Error {
  readonly code = "PROTECTED_PROFILE_INVALID";
}

const sha = /^[0-9a-f]{64}$/;

export function validateProtectedProfile(value: ProtectedReleaseProfile): ProtectedReleaseProfile {
  if (value.schema_version !== PROTECTED_PROFILE_SCHEMA_VERSION) throw new ProtectedProfileError("wrong protected profile schema");
  if (value.authority_token.length < 16) throw new ProtectedProfileError("authority token is missing");
  if (!sha.test(value.npm_archive_sha256) || !sha.test(value.wheel_archive_sha256)) throw new ProtectedProfileError("archive digest is invalid");
  if (!isAbsolute(value.manager_entrypoint) || !isAbsolute(value.worker_entrypoint)) throw new ProtectedProfileError("installed entrypoints must be absolute");
  const manager = realpathSync(value.manager_entrypoint);
  const worker = realpathSync(value.worker_entrypoint);
  if (manager !== value.manager_entrypoint || worker !== value.worker_entrypoint) throw new ProtectedProfileError("entrypoints must be canonical realpaths");
  const repo = value.repository;
  if (repo.visibility === ("public" as string) || repo.allowlisted_disposable !== true || repo.pre_existing !== true) {
    throw new ProtectedProfileError("repository must be non-public, pre-existing, and explicitly disposable");
  }
  if (repo.repository_id === "" || repo.base_branch === "" || !repo.owned_branch_prefix.startsWith("rickgent/protected/")) {
    throw new ProtectedProfileError("immutable repository identity/base/owned prefix is invalid");
  }
  if (value.command_timeout_ms < 1_000 || value.command_timeout_ms > 15 * 60_000) throw new ProtectedProfileError("command timeout must be finite");
  return Object.freeze({
    ...value,
    manager_entrypoint: manager,
    worker_entrypoint: worker,
    repository: Object.freeze({ ...repo }),
  });
}
