import {
  CLAIMS_SCHEMA_VERSION,
  RELEASE_CHANNEL,
  TERMINAL_SEMANTICS,
  capabilityRegistry,
  formatCapabilityReport,
  formatPublicSurfaceMatrixText,
  publicSurfaceRegistry,
} from "../capabilities/registry.js";
import { runDoctorCheck, type DoctorResult } from "../lifecycle/doctor.js";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { runBehavioralDoctor, type BehavioralDoctorResult } from "../lifecycle/behavioral-doctor.js";
import { resolveInstalledRuntimeFromEnvironment } from "../install/installed-runtime.js";
import {
  CAPABILITY_CONTRACTED_CODE,
  RUNTIME_PROOF_STATUS,
} from "../capabilities/runtime-gate.js";

type CheckStatus = "pass" | "fail";

export interface DoctorJson {
  schema_version: typeof CLAIMS_SCHEMA_VERSION;
  release_channel: typeof RELEASE_CHANNEL;
  capabilities: ReturnType<typeof capabilityRegistry>;
  terminal_semantics: typeof TERMINAL_SEMANTICS;
  public_surfaces: ReturnType<typeof publicSurfaceRegistry>;
  attachment_semantics: "configured_attachment_audit_only";
  capability_contraction: {
    code: typeof CAPABILITY_CONTRACTED_CODE;
    diagnostic: string;
  } | null;
  toolchain: {
    node: { status: CheckStatus; version: string };
    python: { status: CheckStatus; version: string };
    package_manager: { status: CheckStatus; value: string };
    lockfile: { status: CheckStatus; version: string };
    platform: { status: CheckStatus; value: NodeJS.Platform };
  };
  health: { ok: boolean };
}

export interface DoctorRuntime {
  readonly nodeVersion: string;
  readonly pythonVersion: string;
  readonly packageManager: string;
  readonly lockfileVersion: string;
  readonly platform: NodeJS.Platform;
}

const EXPECTED_PACKAGE_MANAGER = "pnpm@10.22.0";
const EXPECTED_LOCKFILE_VERSION = "9.0";

function readPackageManager(): string {
  try {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed = JSON.parse(readFileSync(packagePath, "utf-8")) as { packageManager?: unknown };
    return typeof parsed.packageManager === "string" ? parsed.packageManager : "unavailable";
  } catch {
    return "unavailable";
  }
}

function readLockfileVersion(): string {
  for (const relativePath of ["../../pnpm-lock.yaml", "../pnpm-lock.yaml"]) {
    try {
      const lockfilePath = fileURLToPath(new URL(relativePath, import.meta.url));
      const firstLine = readFileSync(lockfilePath, "utf-8").split(/\r?\n/, 1)[0] ?? "";
      return firstLine.match(/^lockfileVersion:\s*['\"]?([^'\"\s]+)['\"]?\s*$/)?.[1] ?? "unavailable";
    } catch {
      // Source checkouts use the package-root lockfile; packed installs carry
      // the same observed lockfile under dist because npm excludes root locks.
    }
  }
  return "unavailable";
}

function readPythonVersion(): string {
  try {
    const python = process.env["OMNIGENT_PYTHON"];
    if (python === undefined || python === "") return "unavailable";
    const output = execFileSync(python, ["--version"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return output.match(/^Python\s+(\S+)$/)?.[1] ?? "unavailable";
  } catch {
    return "unavailable";
  }
}

export function observeDoctorRuntime(): DoctorRuntime {
  return Object.freeze({
    nodeVersion: process.versions.node,
    pythonVersion: readPythonVersion(),
    packageManager: readPackageManager(),
    lockfileVersion: readLockfileVersion(),
    platform: process.platform,
  });
}

function supportedNode(version: string): boolean {
  const major = Number(version.split(".")[0]);
  return major === 24;
}

function supportedPython(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)(?:\.|$)/);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 3 && minor >= 12 && minor < 15;
}

function supportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

export function doctorJson(
  health: DoctorResult,
  runtime: DoctorRuntime = observeDoctorRuntime(),
): DoctorJson {
  const nodePass = supportedNode(runtime.nodeVersion);
  const pythonPass = supportedPython(runtime.pythonVersion);
  const packageManagerPass = runtime.packageManager === EXPECTED_PACKAGE_MANAGER;
  const lockfilePass = runtime.lockfileVersion === EXPECTED_LOCKFILE_VERSION;
  const platformPass = supportedPlatform(runtime.platform);
  return {
    schema_version: CLAIMS_SCHEMA_VERSION,
    release_channel: RELEASE_CHANNEL,
    capabilities: capabilityRegistry(),
    terminal_semantics: TERMINAL_SEMANTICS,
    public_surfaces: publicSurfaceRegistry(),
    attachment_semantics: "configured_attachment_audit_only",
    capability_contraction: RUNTIME_PROOF_STATUS.diagnostic === null
      ? null
      : {
          code: CAPABILITY_CONTRACTED_CODE,
          diagnostic: RUNTIME_PROOF_STATUS.diagnostic,
        },
    toolchain: {
      node: { status: nodePass ? "pass" : "fail", version: runtime.nodeVersion },
      python: { status: pythonPass ? "pass" : "fail", version: runtime.pythonVersion },
      package_manager: {
        status: packageManagerPass ? "pass" : "fail",
        value: runtime.packageManager,
      },
      lockfile: { status: lockfilePass ? "pass" : "fail", version: runtime.lockfileVersion },
      platform: { status: platformPass ? "pass" : "fail", value: runtime.platform },
    },
    health: {
      ok: health.ok && nodePass && pythonPass && packageManagerPass && lockfilePass && platformPass,
    },
  };
}

export interface DoctorEvaluation {
  readonly result: DoctorResult;
  readonly payload: DoctorJson;
}

export async function evaluateDoctor(
  runtime: DoctorRuntime = observeDoctorRuntime(),
): Promise<DoctorEvaluation> {
  const health = await runDoctorCheck();
  const payload = doctorJson(health, runtime);
  return { result: { ...health, ok: payload.health.ok }, payload };
}

function formatToolchain(payload: DoctorJson): string {
  return [
    `  [${payload.toolchain.node.status === "pass" ? "PASS" : "FAIL"}] node_runtime: ${payload.toolchain.node.version}`,
    `  [${payload.toolchain.python.status === "pass" ? "PASS" : "FAIL"}] python_runtime: ${payload.toolchain.python.version}`,
    `  [${payload.toolchain.package_manager.status === "pass" ? "PASS" : "FAIL"}] package_manager_metadata: ${payload.toolchain.package_manager.value}`,
    `  [${payload.toolchain.lockfile.status === "pass" ? "PASS" : "FAIL"}] lockfile_version: ${payload.toolchain.lockfile.version}`,
    `  [${payload.toolchain.platform.status === "pass" ? "PASS" : "FAIL"}] platform: ${payload.toolchain.platform.value}`,
  ].join("\n");
}

export async function runDoctorCommand(asJson: boolean, behavioral = false): Promise<DoctorResult> {
  if (behavioral) {
    let result: BehavioralDoctorResult;
    try {
      const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
      const runtime = resolveInstalledRuntimeFromEnvironment(packageRoot);
      result = runBehavioralDoctor(runtime.omnigent_python.realpath, {
        ...process.env,
        OMNIGENT_ROOT: runtime.omnigent_root.realpath,
        OMNIGENT_PYTHON: runtime.omnigent_python.realpath,
      });
    } catch (error) {
      result = {
          ok: false,
          mode: "behavioral",
          authenticated_hosted_evidence: false,
          checks: [],
          owned_root: "",
          cleaned: true,
          report: error instanceof Error ? error.message : String(error),
        };
    }
    console.log(asJson ? JSON.stringify(result) : result.report);
    return { ok: result.ok, report: result.report };
  }
  const { result, payload } = await evaluateDoctor();
  if (asJson) {
    console.log(JSON.stringify(payload));
  } else {
    console.log(
      `${result.report}\n${formatToolchain(payload)}\n` +
      "Policy attachment is a configured attachment audit only; it is not proof of native production enforcement.\n" +
      (RUNTIME_PROOF_STATUS.diagnostic === null ? "" : `${RUNTIME_PROOF_STATUS.diagnostic}\n`) +
      `${formatCapabilityReport()}\n${formatPublicSurfaceMatrixText()}`,
    );
  }
  return result;
}
