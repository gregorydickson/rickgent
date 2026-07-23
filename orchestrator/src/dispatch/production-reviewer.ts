import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  captureInvokedIdentity,
  captureObservedIdentity,
  captureRequestedIdentity,
  verifyIdentityReceipts,
  type IdentityReceiptSet,
} from "./model-identity.js";
import type { ExecutionContext } from "../context/execution-context.js";

export class ProductionReviewDispatchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProductionReviewDispatchError";
  }
}

export interface ProductionReviewerDispatch {
  readonly executableRealpath: string;
  readonly argv: readonly string[];
  readonly bundleRealpath: string;
  readonly bundleSha256: string;
  readonly configSha256: string;
  readonly dataDir: string;
  readonly baselineConversationIds: ReadonlySet<string>;
  readonly context: ExecutionContext;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProductionReviewerResult {
  readonly response: string;
  readonly receipts: IdentityReceiptSet;
  readonly process: {
    readonly pid: number | null;
    readonly status: number;
    readonly signal: NodeJS.Signals | null;
    readonly separately_observed: true;
  };
}

export function dispatchProductionReviewer(input: ProductionReviewerDispatch): ProductionReviewerResult {
  if (input.timeoutMs < 1_000 || input.timeoutMs > 15 * 60_000) {
    throw new ProductionReviewDispatchError("REVIEW_TIMEOUT_INVALID", "review timeout must be finite and bounded");
  }
  if (input.context.requested_identity.canonical_vendor !== "anthropic") {
    throw new ProductionReviewDispatchError("REVIEW_PROVIDER_INVALID", "production reviewer must request Anthropic Claude");
  }
  if (!input.argv.includes("--print") || !input.argv.includes("--output-format")) {
    throw new ProductionReviewDispatchError("REVIEW_ARGV_INVALID", "review dispatch must be non-interactive print mode");
  }
  const requested = captureRequestedIdentity(input.context);
  const invoked = captureInvokedIdentity(
    input.context.dispatch_id,
    input.context.role,
    input.executableRealpath,
    input.argv,
    input.bundleSha256,
    input.configSha256,
    input.context.attempt_digest,
    input.context.requested_identity.canonical_harness,
    input.context.requested_identity.canonical_model_id,
    input.context.requested_identity.canonical_vendor,
  );
  const result = spawnSync(input.executableRealpath, [...input.argv], {
    input: input.prompt,
    encoding: "utf8",
    timeout: input.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      CI: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ...input.env,
    },
  });
  if (result.error !== undefined) {
    throw new ProductionReviewDispatchError(
      (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "REVIEW_TIMEOUT" : "REVIEW_SPAWN_FAILED",
      result.error.message,
    );
  }
  if (result.signal !== null) throw new ProductionReviewDispatchError("REVIEW_INTERRUPTED", `review interrupted by ${result.signal}`);
  if (result.status !== 0) throw new ProductionReviewDispatchError("REVIEW_EXIT_NONZERO", String(result.stderr).slice(0, 1000));
  if (String(result.stdout).trim() === "") throw new ProductionReviewDispatchError("REVIEW_RESPONSE_LOST", "review process produced no response");
  // Observation happens only after process completion and reads Omnigent's
  // independently persisted root conversation. No requested label is copied.
  const observed = captureObservedIdentity(
    input.dataDir,
    new Set(input.baselineConversationIds),
    input.context.dispatch_id,
    input.context.role,
  );
  verifyIdentityReceipts(requested, invoked, observed);
  // Force an independent bundle read at evidence time.
  readFileSync(input.bundleRealpath);
  return Object.freeze({
    response: String(result.stdout),
    receipts: Object.freeze({ requested, invoked, observed }),
    process: Object.freeze({
      pid: result.pid ?? null,
      status: result.status,
      signal: result.signal,
      separately_observed: true,
    }),
  });
}
