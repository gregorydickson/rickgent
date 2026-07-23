// Model routing bridge (B8/M4 fix) — TypeScript interface to the Python
// `rickgent_policies.select_model` router.
//
// The build loop calls `routeDispatch` before every dispatch. The router
// selects a harness/model/vendor from the live roster, enforcing:
//   - fail-closed on empty/unavailable roster (DENY, no dispatch)
//   - cross-vendor review (code_review role excludes implementer's vendor)
//   - cost gate (unpriced/over-hard-budget → DENY; over-soft-threshold → ASK)
//
// The call is a Python subprocess (`execFileSync("python3", ["-c", ...])`)
// that imports `select_model` and passes the roster + constraints as JSON.
// This is the SINGLE seam where the TS build path consults the Python router;
// the selected `vendor` flows into `Dispatcher.dispatch` as `opts.vendor` and
// from there into every ledger entry (B8 per-dispatch vendor label).

import { execFileSync } from "child_process";
import { RUNTIME_CAPABILITY_GATE } from "../capabilities/runtime-gate.js";

/** A model entry in the live roster (mirrors the Python `select_model` dict). */
export interface ModelEntry {
  harness: string;
  model: string;
  vendor: string;
  tier: "cheap" | "mid" | "capable";
  pricing: { cost_per_dispatch: number } | null;
}

/** A router selection (harness/model identity for one dispatch). */
export interface RouterSelection {
  harness: string;
  model: string;
  vendor: string;
}

/** The verdict returned by the router. */
export type RouterVerdict =
  | { result: "ALLOW"; selection: RouterSelection }
  | { result: "DENY"; reason: string; code: string }
  | { result: "ASK"; reason: string; code: string; selection: RouterSelection };

/** A non-ALLOW verdict (DENY or ASK) — the caller must NOT dispatch. */
export type RouterDenial =
  | { result: "DENY"; reason: string; code: string }
  | { result: "ASK"; reason: string; code: string; selection: RouterSelection };

/**
 * Call the Python `select_model` router via subprocess.
 *
 * Returns the parsed verdict dict. On subprocess failure, malformed output, or
 * timeout → fail-closed DENY (no dispatch, no silent fallback).
 */
export function callSelectModel(
  roster: ModelEntry[],
  role: string,
  implementerVendor?: string | null,
  costBudgetUsd?: number | null,
  softThresholdUsd?: number | null,
): RouterVerdict {
  const selectedPython = process.env["OMNIGENT_PYTHON"];
  if (selectedPython === undefined || selectedPython === "") {
    return {
      result: "DENY",
      reason: "routing: OMNIGENT_PYTHON is required; ambient python3 is forbidden",
      code: "ROUTING_PYTHON_NOT_SELECTED",
    };
  }
  const payload = JSON.stringify({
    roster,
    role,
    implementer_vendor: implementerVendor ?? null,
    cost_budget_usd: costBudgetUsd ?? null,
    soft_threshold_usd: softThresholdUsd ?? null,
  });

  const script =
    "import sys, json; " +
    "from rickgent_policies import select_model; " +
    "args = json.loads(sys.stdin.read()); " +
    "print(json.dumps(select_model(" +
    "args['roster'], args['role'], " +
    "implementer_vendor=args['implementer_vendor'], " +
    "cost_budget_usd=args['cost_budget_usd'], " +
    "soft_threshold_usd=args['soft_threshold_usd'])))";

  try {
    const stdout = execFileSync(selectedPython, ["-c", script], {
      encoding: "utf-8",
      input: payload,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    const parsed = JSON.parse(stdout.trim());
    if (parsed.result === "ALLOW" && parsed.selection) {
      return { result: "ALLOW", selection: parsed.selection };
    }
    if (parsed.result === "DENY") {
      return { result: "DENY", reason: parsed.reason ?? "routing denied", code: parsed.code ?? "ROUTING_DENIED" };
    }
    if (parsed.result === "ASK" && parsed.selection) {
      return { result: "ASK", reason: parsed.reason ?? "routing ask", code: parsed.code ?? "OVER_SOFT_THRESHOLD", selection: parsed.selection };
    }
    // Non-conforming return → fail closed.
    return { result: "DENY", reason: `routing: non-conforming router output: ${JSON.stringify(parsed)}`, code: "ROUTING_MALFORMED" };
  } catch (err) {
    return {
      result: "DENY",
      reason: `routing: subprocess error: ${err instanceof Error ? err.message : String(err)}`,
      code: "ROUTING_SUBPROCESS_ERROR",
    };
  }
}

/**
 * Route a dispatch: call the router and return either a go decision with the
 * selected vendor, or a no-go decision that the caller must NOT dispatch on.
 *
 * The caller (build loop) passes the selected `vendor` into
 * `Dispatcher.dispatch({vendor})` so it flows into the ledger. On DENY or ASK,
 * the caller records a fail-closed entry and absorbs via salvage/breaker.
 */
export function routeDispatch(
  roster: ModelEntry[],
  role: string,
  options?: {
    implementerVendor?: string | null;
    costBudgetUsd?: number | null;
    softThresholdUsd?: number | null;
  },
): { ok: true; selection: RouterSelection } | { ok: false; verdict: RouterDenial } {
  if (role === "code_review") RUNTIME_CAPABILITY_GATE.require("cross_vendor_review");
  const verdict = callSelectModel(
    roster,
    role,
    options?.implementerVendor ?? null,
    options?.costBudgetUsd ?? null,
    options?.softThresholdUsd ?? null,
  );
  if (verdict.result === "ALLOW") {
    return { ok: true, selection: verdict.selection };
  }
  return { ok: false, verdict: verdict as RouterDenial };
}
