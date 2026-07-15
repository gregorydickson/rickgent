import { capabilityRegistry, formatCapabilityReport } from "../capabilities/registry.js";
import { runDoctorCheck, type DoctorResult } from "../lifecycle/doctor.js";

export interface DoctorJson {
  schema_version: "1.0.0";
  release_channel: "reliability_preview";
  capabilities: ReturnType<typeof capabilityRegistry>;
  terminal_semantics: {
    ready_for_delivery: "local_oracle_complete";
    delivered: "remote_delivery_verified";
  };
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
    schema_version: "1.0.0",
    release_channel: "reliability_preview",
    capabilities: capabilityRegistry(),
    terminal_semantics: {
      ready_for_delivery: "local_oracle_complete",
      delivered: "remote_delivery_verified",
    },
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
    console.log(`${health.report}\n${formatCapabilityReport("capabilities")}`);
  }
  return health;
}
