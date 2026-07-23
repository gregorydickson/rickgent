// Doctor — behavioral smoke test.
// AC-1: rickgent doctor proves the stack, not just the imports.

import { BUILD_COMMIT } from "../build-commit.js";
import { RELEASE_CHANNEL, RELEASE_LABEL } from "../capabilities/registry.js";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, realpathSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { resolveInstalledRuntimeFromEnvironment, type InstalledRuntime } from "../install/installed-runtime.js";

export interface DoctorResult {
  ok: boolean;
  report: string;
}

export async function runDoctorCheck(installed?: InstalledRuntime): Promise<DoctorResult> {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const runtime = installed ?? resolveInstalledRuntimeFromEnvironment(packageRoot);
  const cliEntrypoint = runtime.cli.realpath;
  const cliSha256 = createHash("sha256").update(readFileSync(cliEntrypoint)).digest("hex");
  const nodeEntrypoint = realpathSync(process.execPath);
  const nodeSha256 = createHash("sha256").update(readFileSync(nodeEntrypoint)).digest("hex");
  const pythonEnv = {
    ...process.env,
    RICKGENT_NODE_REALPATH: nodeEntrypoint,
    RICKGENT_NODE_SHA256: nodeSha256,
    RICKGENT_CLI_REALPATH: cliEntrypoint,
    RICKGENT_CLI_SHA256: cliSha256,
    RICKGENT_BUILD_COMMIT: BUILD_COMMIT,
  };
  // Source checkouts default to their bundled agents. Packed installations
  // discover external bundles through the same explicit variables consumed by
  // the configured-attachment audit below.
  const repoRoot = new URL("../../../", import.meta.url);
  void repoRoot;
  const managerDir = join(runtime.manager.realpath, "..");
  const workerDir = join(runtime.worker.realpath, "..");
  const selectedPython = runtime.omnigent_python.realpath;

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
    const version = execFileSync(selectedPython, ["-c", "import importlib.metadata; print(importlib.metadata.version('omnigent'))"], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: pythonEnv,
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
    const result = execFileSync(selectedPython, ["-c", "import rickgent_policies; print('ok')"], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: pythonEnv,
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
    const result = execFileSync(
      selectedPython,
      ["-c", "from omnigent.policies.registry import load_registry; load_registry(extra_modules=['rickgent_policies']); from omnigent.policies.registry import is_registered_handler; print('ok')"],
      { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"], env: pythonEnv },
    ).trim();
    registryOk = result === "ok";
    registryDetail = "policy registry loaded with rickgent_policies";
  } catch (e) {
    registryDetail = `policy registry load failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push({ name: "policy_registry", pass: registryOk, detail: registryDetail });

  // 5. Both configured agent bundles exist. Registration is not attachment,
  // but the audit cannot be meaningful unless both effective configs exist.
  const managerConfig = join(managerDir, "config.yaml");
  const workerConfig = join(workerDir, "config.yaml");
  const managerExists = existsSync(managerConfig);
  const workerExists = existsSync(workerConfig);
  const agentExists = managerExists && workerExists;
  checks.push({
    name: "agent_bundle",
    pass: agentExists,
    detail: agentExists
      ? "configured manager + worker config.yaml files found"
      : [
        managerExists ? null : `manager config missing: ${managerConfig}`,
        workerExists ? null : `worker config missing: ${workerConfig}`,
      ].filter((entry): entry is string => entry !== null).join("; "),
  });

  // 6. verdict CLI works (self-test with a simple completion check)
  let verdictOk = false;
  let verdictDetail = "";
  try {
    const verdictResult = execFileSync(
      process.execPath,
      [cliEntrypoint, "verdict", "completion", "--json"],
      {
        encoding: "utf-8",
        timeout: 10000,
        input: '{"claimedSha":null,"baselineSha":"abc123","shaExists":false,"treeChanged":false,"gateGreen":null}',
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      },
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
    const pyCommit = execFileSync(selectedPython, ["-c", "import rickgent_policies; print(rickgent_policies.BUILD_COMMIT)"], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: pythonEnv,
    }).trim();
    shimOk = pyCommit === BUILD_COMMIT;
    shimDetail = shimOk
      ? "build_commit matches across TS/Python"
      : `build_commit mismatch: TS=${BUILD_COMMIT.slice(0, 12)} Python=${pyCommit.slice(0, 12)}`;
  } catch (e) {
    shimDetail = `Python shim check failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push({ name: "build_commit_match", pass: shimOk, detail: shimDetail });

  // 8. Exact source-template attachment and FunctionPolicy compatibility.
  let attachOk = false;
  let attachDetail = "";
  try {
    const py = [
      "import json, os",
      "from rickgent_policies import validate_attached_policy_bundle",
      "bundles = {'manager': os.environ['RG_MGR'], 'worker': os.environ['RG_WKR']}",
      "errors = {}",
      "for label, d in bundles.items():",
      "    try:",
      "        validate_attached_policy_bundle(d)",
      "    except Exception as e:",
      "        errors[label] = str(e)",
      "print(json.dumps(errors))",
    ].join("\n");
    const raw = execFileSync(selectedPython, ["-"], {
      encoding: "utf-8",
      timeout: 15000,
      input: py,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...pythonEnv, RG_MGR: managerDir, RG_WKR: workerDir },
    }).trim();
    const errors = JSON.parse(raw) as Record<string, string>;
    const labels = Object.keys(errors);
    attachOk = labels.length === 0;
    attachDetail = attachOk
      ? "configured manager + worker bundles have exact attachment and FunctionPolicy compatibility"
      : labels.map((l) => `${l}: ${errors[l] ?? "attachment validation failed"}`).join("; ");
  } catch (e) {
    attachDetail = `policy attachment audit failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push({ name: "policy_attachment", pass: attachOk, detail: attachDetail });

  const allPass = checks.every((c) => c.pass);
  const report = [
    `${RELEASE_LABEL} (${RELEASE_CHANNEL}) — read-only health and configured-attachment audit`,
    "=".repeat(50),
    ...checks.map((c) => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name}: ${c.detail}`),
    "=".repeat(50),
    allPass ? "All checks passed." : "Some checks failed.",
  ].join("\n");

  return { ok: allPass, report };
}
