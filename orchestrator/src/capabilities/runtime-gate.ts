import {
  PRODUCTION_CAPABILITY_GATE,
  type CapabilityGate,
} from "./registry.js";

/**
 * The capability authority used by every shipped mutation boundary.
 *
 * This module is deliberately boring: production has exactly one immutable
 * gate and exposes no setter, factory, environment adapter, or caller-supplied
 * override. Tests compile a separate runtime tree and replace this module in
 * that tree only; the replacement is never part of the npm artifact.
 */
export const RUNTIME_CAPABILITY_GATE: CapabilityGate = PRODUCTION_CAPABILITY_GATE;
