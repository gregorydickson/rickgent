import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  captureInvokedIdentity,
  captureObservedIdentity,
  type IdentityReceipt,
} from "../dispatch/model-identity.js";

export interface ProductionReviewRequest {
  readonly omnigentExecutable: string;
  readonly dataDir: string;
  readonly reviewerBundle: string;
  readonly prompt: string;
  readonly harness: string;
  readonly model: string;
  readonly vendor: string;
  readonly dispatchId: string;
  readonly contextDigest: string;
  readonly timeoutMs: number;
}

export interface ProductionReviewObservation {
  readonly invoked: IdentityReceipt;
  readonly observed: IdentityReceipt;
  readonly stdoutSha256: string;
}

function baselineIds(dataDir: string): Set<string> {
  const result = new Set<string>();
  try {
    const db = new DatabaseSync(`${dataDir}/chat.db`, { readOnly: true });
    try {
      for (const row of db.prepare("SELECT id FROM conversations").all() as Array<{ id: unknown }>) {
        result.add(String(row.id));
      }
    } finally {
      db.close();
    }
  } catch {
    // A new isolated data root has no baseline database.
  }
  return result;
}

export function dispatchProductionReview(
  request: ProductionReviewRequest,
): ProductionReviewObservation {
  if (
    request.vendor.toLowerCase() !== "anthropic" ||
    !request.harness.toLowerCase().includes("claude") ||
    !request.model.toLowerCase().includes("claude")
  ) {
    throw new Error("RICKGENT_PRODUCTION_REVIEW_REQUIRES_CLAUDE");
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > 60 * 60 * 1_000) {
    throw new Error("RICKGENT_PRODUCTION_REVIEW_TIMEOUT_INVALID");
  }
  const executable = realpathSync(request.omnigentExecutable);
  const bundle = realpathSync(request.reviewerBundle);
  const bundleDigest = createHash("sha256").update(readFileSync(`${bundle}/config.yaml`)).digest("hex");
  mkdirSync(request.dataDir, { recursive: true, mode: 0o700 });
  const dataDir = realpathSync(request.dataDir);
  const before = baselineIds(dataDir);
  if (before.size !== 0) throw new Error("RICKGENT_PRODUCTION_REVIEW_DATA_ROOT_NOT_ISOLATED");
  const argv = [
    "run", bundle, "--no-session", "-p", request.prompt,
    "--harness", request.harness, "--model", request.model,
  ];
  const stdout = execFileSync(executable, argv, {
    encoding: "utf8",
    timeout: request.timeoutMs,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      OMNIGENT_DATA_DIR: dataDir,
      CI: "1",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    },
  });
  const invoked = captureInvokedIdentity(
    request.dispatchId,
    "reviewer",
    executable,
    argv,
    bundleDigest,
    bundleDigest,
    request.contextDigest,
    request.harness,
    request.model,
    request.vendor,
  );
  const observed = captureObservedIdentity(dataDir, before, request.dispatchId, "reviewer");
  if (
    observed.canonical_harness !== invoked.canonical_harness ||
    observed.canonical_model !== invoked.canonical_model ||
    observed.canonical_vendor !== "anthropic" ||
    observed.conversation_id === null
  ) {
    throw new Error("RICKGENT_PRODUCTION_REVIEW_IDENTITY_MISMATCH");
  }
  return Object.freeze({
    invoked,
    observed,
    stdoutSha256: createHash("sha256").update(stdout, "utf8").digest("hex"),
  });
}
