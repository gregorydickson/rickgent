// Merge-gate PR flow (B1 / A-SEC-1).
//
// The build loop opens its PR through the SAME `autonomous_pr_flow` policy that
// gates a worker's pushes — there is one authority for "may this push/PR
// proceed autonomously", not a second TS copy of the whitelist. The policy is
// the Python shim (`rickgent_policies.autonomous_pr_flow`); this module invokes
// it in-process via a short python3 evaluation and fails CLOSED (DENY) on any
// evaluation error, so a merge gate that cannot prove the narrow own-branch
// shape becomes a human gate rather than an ungated push.

import { execFileSync } from "child_process";
import { RUNTIME_CAPABILITY_GATE } from "../capabilities/runtime-gate.js";

export type PrFlowResult = "ALLOW" | "DENY" | "ABSTAIN";

export interface PrFlowVerdict {
  result: PrFlowResult;
  reason: string;
}

const EVAL_PY = [
  "import json, sys",
  "import rickgent_policies as r",
  "data = json.loads(sys.stdin.read())",
  "v = r.autonomous_pr_flow(data['event'], data['config'])",
  "print(json.dumps({'verdict': v}))",
].join("\n");

/**
 * Evaluate `autonomous_pr_flow` for a git/gh command as the run's own feature
 * branch. Returns the policy verdict; a `None` abstain maps to ABSTAIN and any
 * evaluation failure fails closed to DENY.
 */
export function evaluateAutonomousPrFlow(
  command: string,
  featureBranch: string,
  env: NodeJS.ProcessEnv = process.env,
): PrFlowVerdict {
  RUNTIME_CAPABILITY_GATE.require("automatic_delivery");
  const input = JSON.stringify({
    event: { tool_name: "Bash", arguments: { command } },
    config: { feature_branch: featureBranch },
  });
  try {
    const out = execFileSync("python3", ["-c", EVAL_PY], {
      input,
      encoding: "utf-8",
      timeout: 20000,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const parsed = JSON.parse(out) as { verdict: { result?: string; reason?: string } | null };
    const v = parsed.verdict;
    if (v == null) return { result: "ABSTAIN", reason: "autonomous_pr_flow abstained" };
    const res = String(v.result ?? "").toUpperCase();
    if (res === "ALLOW") return { result: "ALLOW", reason: v.reason ?? "allowed" };
    return { result: "DENY", reason: v.reason ?? "denied" };
  } catch (err) {
    return {
      result: "DENY",
      reason: `autonomous_pr_flow evaluation failed (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface PrCreationResult {
  branch: string;
  pushVerdict: PrFlowVerdict;
  prVerdict: PrFlowVerdict;
  /** True iff both the push and gh pr create commands were policy-ALLOWed. */
  gated: boolean;
  /** True iff `gh pr create` actually ran and exited 0. */
  prCreated: boolean;
  ghOutput: string;
  error: string | null;
}

/**
 * Create the PR branch and issue `gh pr create`, gated by autonomous_pr_flow.
 * The narrow own-feature-branch push and the `gh pr create` command are BOTH
 * evaluated through the policy; only when both ALLOW does the gh invocation run.
 * Anything else leaves `gated:false` and `prCreated:false` so the caller can
 * treat it as a human gate.
 */
export function createPullRequest(
  repoDir: string,
  featureBranch: string,
  prTitle: string,
  env: NodeJS.ProcessEnv = process.env,
): PrCreationResult {
  RUNTIME_CAPABILITY_GATE.require("automatic_delivery");
  const pushCommand = `git push origin ${featureBranch}`;
  const prCommand = `gh pr create --fill --head ${featureBranch}`;

  const pushVerdict = evaluateAutonomousPrFlow(pushCommand, featureBranch, env);
  const prVerdict = evaluateAutonomousPrFlow(prCommand, featureBranch, env);
  const gated = pushVerdict.result === "ALLOW" && prVerdict.result === "ALLOW";

  if (!gated) {
    return {
      branch: featureBranch,
      pushVerdict,
      prVerdict,
      gated: false,
      prCreated: false,
      ghOutput: "",
      error: "autonomous_pr_flow did not ALLOW the PR flow",
    };
  }

  try {
    ensureBranch(repoDir, featureBranch, env);
  } catch (err) {
    return {
      branch: featureBranch,
      pushVerdict,
      prVerdict,
      gated,
      prCreated: false,
      ghOutput: "",
      error: `branch creation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const ghOutput = execFileSync(
      "gh",
      ["pr", "create", "--fill", "--head", featureBranch, "--title", prTitle],
      { cwd: repoDir, encoding: "utf-8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"], env },
    );
    return { branch: featureBranch, pushVerdict, prVerdict, gated, prCreated: true, ghOutput: ghOutput.trim(), error: null };
  } catch (err) {
    return {
      branch: featureBranch,
      pushVerdict,
      prVerdict,
      gated,
      prCreated: false,
      ghOutput: "",
      error: `gh pr create failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Create (or switch to) the feature branch at the current HEAD. */
export function ensureBranch(
  repoDir: string,
  branch: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  RUNTIME_CAPABILITY_GATE.require("automatic_delivery");
  const exists = (() => {
    try {
      execFileSync("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        stdio: ["ignore", "ignore", "ignore"],
        env,
      });
      return true;
    } catch {
      return false;
    }
  })();
  execFileSync("git", ["-C", repoDir, "checkout", ...(exists ? [] : ["-b"]), branch], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 10000,
    env,
  });
}
