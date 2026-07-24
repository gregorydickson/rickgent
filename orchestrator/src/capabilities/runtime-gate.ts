import {
  CapabilityUnavailableError,
  PRODUCTION_CAPABILITY_GATE,
  getCapability,
  type CapabilityGate,
  type CapabilityName,
} from "./registry.js";
import { validateProofRoot } from "../release-proof/proof-root.js";
import type { ReceiptExpectations } from "../release-proof/receipt-validator.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The capability authority used by every shipped mutation boundary.
 *
 * This module is deliberately boring: production has exactly one immutable
 * gate and exposes no setter, factory, environment adapter, or caller-supplied
 * override. Tests compile a separate runtime tree and replace this module in
 * that tree only; the replacement is never part of the npm artifact.
 */
export const PROOF_GATED_CAPABILITIES = Object.freeze([
  "resume_retry",
  "cross_vendor_review",
  "automatic_delivery",
] as const satisfies readonly CapabilityName[]);

export const CAPABILITY_PROOF_REQUIRED_CODE = "RICKGENT_INSTALLED_PROOF_REQUIRED" as const;

function unavailable(name: CapabilityName, diagnostics: readonly string[]) {
  const compiled = getCapability(name);
  return Object.freeze({
    ...compiled,
    state: "unavailable" as const,
    error_code: CAPABILITY_PROOF_REQUIRED_CODE,
    reason: `installed proof root did not validate: ${diagnostics.join(" | ") || "proof root not selected"}`,
    proof_version: "mission-3-installed-proof-v1",
    minimum_profile: "installed_t38_vertical_slice",
  });
}

export function createProofGatedCapabilityGate(
  proofRootPath: string | null,
  expected?: ReceiptExpectations,
): CapabilityGate {
  const validation = typeof proofRootPath === "string" && proofRootPath !== ""
    ? validateProofRoot(proofRootPath, expected)
    : null;
  const diagnostics = validation?.diagnostics ?? Object.freeze(["proof root not selected"]);
  const valid = validation?.ok === true;
  return Object.freeze({
    require(name: CapabilityName): void {
      if (PROOF_GATED_CAPABILITIES.includes(name as typeof PROOF_GATED_CAPABILITIES[number]) && !valid) {
        throw new CapabilityUnavailableError(unavailable(name, diagnostics));
      }
      const entry = getCapability(name);
      if (entry.state !== "enabled") throw new CapabilityUnavailableError(entry);
    },
  });
}

/**
 * Source execution keeps the compiled development gate. A packed installation
 * may select an absolute retained proof root, but the selector is never enough:
 * the index, exact receipt/schema bytes, archive/build/release bindings, two
 * complete protected runs, provider pair, evidence closure, and cleanup must
 * all validate before any protected capability widens.
 */
const sourceFixtureRuntime = existsSync(fileURLToPath(new URL("../../src", import.meta.url)));
export const RUNTIME_CAPABILITY_GATE: CapabilityGate = sourceFixtureRuntime
  ? PRODUCTION_CAPABILITY_GATE
  : createProofGatedCapabilityGate(process.env["RICKGENT_PROOF_ROOT"] ?? null);
