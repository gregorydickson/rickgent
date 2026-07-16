/**
 * Compatibility surface for callers that historically imported worker
 * materialization from dispatch/. Production dispatch has exactly one
 * materializer: the authenticated per-attempt policy bundle.
 */
export {
  closePolicyBundleLease,
  finalizePolicyBundle,
  materializePolicyBundle,
  policyBundleSha256,
  validateWorkerTemplate,
  verifyPolicyBundleForSpawn,
  type PolicyBundleFinalizationProof,
  type PolicyBundleFinalizationResult,
  type PolicyBundleHandle,
  type PolicyBundleMaterializationOptions,
  type PolicyReferenceConfig,
} from "../policy/policy-bundle.js";

export type { PolicyBundleHandle as MaterializedWorkerBundle } from "../policy/policy-bundle.js";
