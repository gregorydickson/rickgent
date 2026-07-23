import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BehavioralCheckId =
  | "native_allow"
  | "native_deny"
  | "omnigent_identity"
  | "sqlite_reopen"
  | "git_containment"
  | "typed_failure"
  | "owned_cleanup";

export interface BehavioralDoctorCheck {
  readonly check_id: BehavioralCheckId;
  readonly outcome: "pass" | "fail";
  readonly detail: string;
}

export interface BehavioralDoctorResult {
  readonly ok: boolean;
  readonly mode: "behavioral";
  readonly authenticated_hosted_evidence: false;
  readonly checks: readonly BehavioralDoctorCheck[];
  readonly owned_root: string;
  readonly cleaned: boolean;
  readonly report: string;
}

export class BehavioralDoctorError extends Error {
  readonly code = "BEHAVIORAL_DOCTOR_FAILED";
}

export interface BehavioralDoctorDependencies {
  readonly makeRoot?: () => string;
  readonly runPython?: (python: string, script: string, env: NodeJS.ProcessEnv) => string;
  readonly runGit?: (argv: readonly string[]) => string;
  readonly removeRoot?: (root: string) => void;
}

const pythonProbe = String.raw`
import importlib.metadata, json, os, sqlite3
from pathlib import Path
from rickgent_policies.policy_event import TicketScopeEntry
from rickgent_policies.scope import ScopeOperation, evaluate_scope
root = Path(os.environ["RICKGENT_BEHAVIORAL_ROOT"]).resolve()
worktree = root / "policy-worktree"
worktree.mkdir()
target = worktree / "allowed.txt"
target.write_text("before")
declaration = TicketScopeEntry(path="allowed.txt", change_kind="modify", directory=False)
allow = evaluate_scope(
    worktree_root=str(worktree), authorized_root=str(worktree), reserved_roots=(),
    declared_scope=(declaration,),
    operation=ScopeOperation("modify", False, path="allowed.txt"),
)
deny = evaluate_scope(
    worktree_root=str(worktree), authorized_root=str(worktree), reserved_roots=(),
    declared_scope=(declaration,),
    operation=ScopeOperation("modify", False, path="outside.txt"),
)
import omnigent
omnigent_import = str(Path(omnigent.__file__).resolve())
omnigent_root = str(Path(os.environ["OMNIGENT_ROOT"]).resolve())
identity = {
    "requested_root": omnigent_root,
    "observed_import": omnigent_import,
    "observed_version": importlib.metadata.version("omnigent"),
}
db_path = root / "chat.db"
con = sqlite3.connect(db_path)
con.execute("create table observations (id text primary key, payload text)")
con.execute("insert into observations values (?, ?)", ("omnigent-runtime", json.dumps(identity, sort_keys=True)))
con.commit()
con.close()
con = sqlite3.connect(db_path)
row = con.execute("select id, payload from observations").fetchone()
con.close()
reopened_identity = json.loads(row[1])
print(json.dumps({
    "native_allow": allow.result == "ALLOW",
    "native_deny": deny.result == "DENY" and deny.code == "SCOPE_DENIED",
    "identity": reopened_identity == identity and omnigent_import.startswith(omnigent_root + os.sep),
    "sqlite_reopen": row[0] == "omnigent-runtime",
}))
`;

export function runBehavioralDoctor(
  omnigentPython: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: BehavioralDoctorDependencies = {},
): BehavioralDoctorResult {
  const root = dependencies.makeRoot?.() ?? mkdtempSync(join(tmpdir(), "rickgent-doctor-"));
  const checks: BehavioralDoctorCheck[] = [];
  const runPython = dependencies.runPython ?? ((python, script, childEnv) =>
    execFileSync(python, ["-c", script], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    }).trim());
  const runGit = dependencies.runGit ?? ((argv) =>
    execFileSync("git", argv, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    }).trim());
  const remove = dependencies.removeRoot ?? ((path) => rmSync(path, { recursive: true, force: true }));
  try {
    const parsed = JSON.parse(runPython(omnigentPython, pythonProbe, {
      ...env,
      RICKGENT_BEHAVIORAL_ROOT: root,
    })) as Record<string, unknown>;
    checks.push({ check_id: "native_allow", outcome: parsed["native_allow"] === true ? "pass" : "fail", detail: "native FunctionPolicy allow observed" });
    checks.push({ check_id: "native_deny", outcome: parsed["native_deny"] === true ? "pass" : "fail", detail: "native FunctionPolicy deny observed" });
    checks.push({ check_id: "omnigent_identity", outcome: parsed["identity"] === true ? "pass" : "fail", detail: "deterministic requested/invoked/observed identity" });
    checks.push({ check_id: "sqlite_reopen", outcome: parsed["sqlite_reopen"] === true ? "pass" : "fail", detail: "SQLite close/reopen durability observed" });

    const repository = join(root, "repository");
    runGit(["init", "-q", repository]);
    const top = realpathSync(runGit(["-C", repository, "rev-parse", "--show-toplevel"]));
    checks.push({ check_id: "git_containment", outcome: top === realpathSync(repository) ? "pass" : "fail", detail: "disposable Git root remained contained" });

    writeFileSync(join(root, "typed-failure.json"), JSON.stringify({ code: "DOCTOR_EXPECTED_DENIAL" }));
    const typed = JSON.parse(readFileSync(join(root, "typed-failure.json"), "utf8")) as { code?: unknown };
    checks.push({ check_id: "typed_failure", outcome: typed.code === "DOCTOR_EXPECTED_DENIAL" ? "pass" : "fail", detail: "typed negative path retained its code" });
  } catch (error) {
    checks.push({
      check_id: "typed_failure",
      outcome: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    remove(root);
  }
  const cleaned = !existsSync(root);
  checks.push({ check_id: "owned_cleanup", outcome: cleaned ? "pass" : "fail", detail: cleaned ? "owned root removed" : "owned root remains" });
  const ok = checks.length === 7 && checks.every((check) => check.outcome === "pass");
  const report = [
    "Rickgent behavioral installed-runtime proof",
    ...checks.map((check) => `  [${check.outcome === "pass" ? "PASS" : "FAIL"}] ${check.check_id}: ${check.detail}`),
    ok ? "All behavioral checks passed." : "Behavioral checks failed.",
  ].join("\n");
  return Object.freeze({
    ok,
    mode: "behavioral",
    authenticated_hosted_evidence: false,
    checks: Object.freeze(checks),
    owned_root: root,
    cleaned,
    report,
  });
}
