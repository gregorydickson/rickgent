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

export interface DoctorJson {
  schema_version: typeof CLAIMS_SCHEMA_VERSION;
  release_channel: typeof RELEASE_CHANNEL;
  capabilities: ReturnType<typeof capabilityRegistry>;
  terminal_semantics: typeof TERMINAL_SEMANTICS;
  public_surfaces: ReturnType<typeof publicSurfaceRegistry>;
  attachment_semantics: "configured_attachment_audit_only";
  toolchain: {
    node: { status: "pass" | "fail"; version: string };
    platform: { status: "pass" | "fail"; value: NodeJS.Platform };
  };
  health: { ok: boolean };
}

function supportedNode(): boolean {
  const major = Number(process.versions.node.split(".")[0]);
  return major === 24;
}

function supportedPlatform(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

export function doctorJson(health: DoctorResult): DoctorJson {
  return {
    schema_version: CLAIMS_SCHEMA_VERSION,
    release_channel: RELEASE_CHANNEL,
    capabilities: capabilityRegistry(),
    terminal_semantics: TERMINAL_SEMANTICS,
    public_surfaces: publicSurfaceRegistry(),
    attachment_semantics: "configured_attachment_audit_only",
    toolchain: {
      node: { status: supportedNode() ? "pass" : "fail", version: process.versions.node },
      platform: { status: supportedPlatform() ? "pass" : "fail", value: process.platform },
    },
    health: { ok: health.ok },
  };
}

export async function runDoctorCommand(asJson: boolean): Promise<DoctorResult> {
  const health = await runDoctorCheck();
  if (asJson) {
    console.log(JSON.stringify(doctorJson(health)));
  } else {
    console.log(
      `${health.report}\n` +
      "Policy attachment is a configured attachment audit only; it is not proof of native production enforcement.\n" +
      `${formatCapabilityReport()}\n${formatPublicSurfaceMatrixText()}`,
    );
  }
  return health;
}
