// Doctor — behavioral smoke test.
// AC-1: rickgent doctor proves the stack, not just the imports.

import { BUILD_COMMIT } from "../build-commit.js";
import { execSync } from "child_process";
import { existsSync } from "fs";

export interface DoctorResult {
  ok: boolean;
  report: string;
}

export async function runDoctorCheck(): Promise<DoctorResult> {
  const checks: { name: string; pass: boolean; detail: string }[] = [];

  // 1. build_commit is available
  const commitValue: string = BUILD_COMMIT;
  checks.push({
    name: "build_commit",
    pass: commitValue.length > 0,
    detail: `build_commit=${commitValue.slice(0, 12)}`,
  });

  // 2. omnigent is importable
  let omnigentOk = false;
  let omnigentDetail = "";
  try {
    const version = execSync("python3 -c \"import importlib.metadata; print(importlib.metadata.version('omnigent'))\"", {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    omnigentOk = true;
    omnigentDetail = `omnigent ${version}`;
  } catch {
    omnigentDetail = "omnigent not importable (pip install -e ../omnigent or pin required)";
  }
  checks.push({ name: "omnigent_import", pass: omnigentOk, detail: omnigentDetail });

  // 3. rickgent_policies is importable
  let policiesOk = false;
  let policiesDetail = "";
  try {
    const result = execSync("python3 -c \"import rickgent_policies; print('ok')\"", {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    policiesOk = result === "ok";
    policiesDetail = "rickgent_policies importable";
  } catch {
    policiesDetail = "rickgent_policies not importable (pip install -e ../rickgent-policies required)";
  }
  checks.push({ name: "policies_import", pass: policiesOk, detail: policiesDetail });

  // 4. policy registry loads with rickgent_policies
  let registryOk = false;
  let registryDetail = "";
  try {
    const result = execSync(
      "python3 -c \"from omnigent.policies.registry import load_registry; load_registry(extra_modules=['rickgent_policies']); from omnigent.policies.registry import is_registered_handler; print('ok')\"",
      { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    registryOk = result === "ok";
    registryDetail = "policy registry loaded with rickgent_policies";
  } catch (e) {
    registryDetail = `policy registry load failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push({ name: "policy_registry", pass: registryOk, detail: registryDetail });

  // 5. agent bundle exists — resolve relative to repo root
  // dist/lifecycle/doctor.js → ../../.. = rickgent/ (repo root)
  const repoRoot = new URL("../../../", import.meta.url);
  const agentPath = new URL("agents/rickgent/config.yaml", repoRoot);
  const agentExists = existsSync(agentPath);
  checks.push({
    name: "agent_bundle",
    pass: agentExists,
    detail: agentExists ? "agents/rickgent/config.yaml found" : "agents/rickgent/config.yaml missing",
  });

  // 6. verdict CLI works (self-test with a simple completion check)
  let verdictOk = false;
  let verdictDetail = "";
  try {
    const verdictResult = execSync(
      `echo '{"claimedSha":null,"baselineSha":"abc123","shaExists":false,"treeChanged":false,"gateGreen":null}' | node ${process.argv[1]?.replace("doctor", "cli.js") ?? "dist/cli.js"} verdict completion --json`,
      { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const parsed = JSON.parse(verdictResult);
    verdictOk = parsed.verdict === "UNVERIFIED";
    verdictDetail = `verdict CLI returned: ${parsed.verdict}`;
  } catch (e) {
    verdictDetail = `verdict CLI failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push({ name: "verdict_cli", pass: verdictOk, detail: verdictDetail });

  // 7. Python shim subprocess path (build_commit match)
  let shimOk = false;
  let shimDetail = "";
  try {
    const pyCommit = execSync("python3 -c \"import rickgent_policies; print(rickgent_policies.BUILD_COMMIT)\"", {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    shimOk = pyCommit === BUILD_COMMIT;
    shimDetail = shimOk
      ? "build_commit matches across TS/Python"
      : `build_commit mismatch: TS=${BUILD_COMMIT.slice(0, 12)} Python=${pyCommit.slice(0, 12)}`;
  } catch (e) {
    shimDetail = `Python shim check failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push({ name: "build_commit_match", pass: shimOk, detail: shimDetail });

  // 8. policy ATTACHMENT audit (B4/C4). Registration is not attachment: the
  // effective set is read from `spec.guardrails.policies` via the omnigent
  // parser. Fails CLOSED (this check fails → non-zero doctor exit) when either
  // bundle's effective attached set is a strict subset of REQUIRED_POLICIES.
  const managerDir = process.env.RICKGENT_MANAGER_DIR ?? new URL("agents/rickgent", repoRoot).pathname;
  const workerDir =
    process.env.RICKGENT_WORKER_DIR ?? new URL("agents/rickgent/agents/worker", repoRoot).pathname;
  let attachOk = false;
  let attachDetail = "";
  try {
    const py = [
      "import json, os",
      "from rickgent_policies import REQUIRED_POLICIES, effective_attached_policies",
      "bundles = {'manager': os.environ['RG_MGR'], 'worker': os.environ['RG_WKR']}",
      "missing = {}",
      "for label, d in bundles.items():",
      "    try:",
      "        eff = effective_attached_policies(d)",
      "    except Exception as e:",
      "        missing[label] = ['<parse-error: %s>' % e] + sorted(REQUIRED_POLICIES)",
      "        continue",
      "    gap = sorted(REQUIRED_POLICIES - eff)",
      "    if gap:",
      "        missing[label] = gap",
      "print(json.dumps(missing))",
    ].join("\n");
    const raw = execSync("python3 -", {
      encoding: "utf-8",
      timeout: 15000,
      input: py,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RG_MGR: managerDir, RG_WKR: workerDir },
    }).trim();
    const missing = JSON.parse(raw) as Record<string, string[]>;
    const labels = Object.keys(missing);
    attachOk = labels.length === 0;
    attachDetail = attachOk
      ? "manager + worker bundles attach the full required policy set"
      : labels.map((l) => `${l} missing [${(missing[l] ?? []).join(", ")}]`).join("; ");
  } catch (e) {
    attachDetail = `policy attachment audit failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push({ name: "policy_attachment", pass: attachOk, detail: attachDetail });

  const allPass = checks.every((c) => c.pass);
  const report = [
    "rickgent doctor — behavioral smoke test",
    "=".repeat(50),
    ...checks.map((c) => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name}: ${c.detail}`),
    "=".repeat(50),
    allPass ? "All checks passed." : "Some checks failed.",
  ].join("\n");

  return { ok: allPass, report };
}
