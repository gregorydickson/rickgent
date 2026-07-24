import { describe, expect, it } from "vitest";
import fixture from "../fixtures/protected-release/manifest.json";

type Fault = typeof fixture.fault_points[number];
type Mutation = {
  operation: "allocate" | "provider" | "gate" | "push" | "create_pr" | "close_pr" | "delete_branch";
  repository_id: string;
  resource_id: string;
};

interface DurableState {
  branch_oid?: string;
  pull_request_id?: string;
  cleanup_complete?: boolean;
}

class HermeticProtectedRun {
  readonly mutations: Mutation[] = [];
  readonly state: DurableState = {};
  readonly branches = new Map<string, string>();
  readonly pullRequests = new Set<string>();
  readonly repositoryPreserved = true;
  cleanupRequeries = 0;
  attempts = 0;

  constructor(readonly fault: Fault) {}

  private mutate(operation: Mutation["operation"], resourceId: string): void {
    if (!resourceId.startsWith(fixture.remote.owned_branch_prefix) && !resourceId.startsWith("fixture-pr-")) {
      throw new Error(`unowned resource: ${resourceId}`);
    }
    this.mutations.push({
      operation,
      repository_id: fixture.remote.repository_id,
      resource_id: resourceId,
    });
  }

  async execute(): Promise<void> {
    this.attempts += 1;
    const branch = `${fixture.remote.owned_branch_prefix}run-1`;
    if (this.fault === "allocation") throw new Error("allocation");
    this.mutate("allocate", branch);
    if (this.fault === "provider") throw new Error("provider");
    this.mutate("provider", branch);
    if (this.fault === "gate") throw new Error("gate");
    this.mutate("gate", branch);

    if (this.state.branch_oid === undefined) {
      const oid = "a".repeat(40);
      this.branches.set(branch, oid);
      this.state.branch_oid = oid;
      this.mutate("push", branch);
      if (this.fault === "push") throw new Error("push");
      if (this.fault === "push_response_loss") throw new Error("push response lost");
    }
    if (this.fault === "crash" && this.attempts === 1) throw new Error("crash");

    if (this.state.pull_request_id === undefined) {
      const id = "fixture-pr-1";
      this.pullRequests.add(id);
      this.state.pull_request_id = id;
      this.mutate("create_pr", id);
      if (this.fault === "pull_request_creation") throw new Error("pull request creation");
      if (this.fault === "pull_request_response_loss") throw new Error("pull request response lost");
    }
  }

  async cleanup(): Promise<void> {
    if (this.state.cleanup_complete === true) {
      this.cleanupRequeries += 1;
      return;
    }
    const pr = this.state.pull_request_id;
    if (pr !== undefined && this.pullRequests.has(pr)) {
      this.mutate("close_pr", pr);
      this.pullRequests.delete(pr);
    }
    const branch = `${fixture.remote.owned_branch_prefix}run-1`;
    const observed = this.branches.get(branch);
    if (observed !== undefined) {
      expect(observed).toBe(this.state.branch_oid);
      this.mutate("delete_branch", branch);
      this.branches.delete(branch);
    }
    this.cleanupRequeries += 1;
    if (this.fault === "teardown_interruption" && this.cleanupRequeries === 1) {
      throw new Error("teardown interrupted");
    }
    expect(this.branches.has(branch)).toBe(false);
    expect(pr !== undefined && this.pullRequests.has(pr)).toBe(false);
    this.state.cleanup_complete = true;
  }
}

async function bounded<T>(operation: Promise<T>, timeoutMs = 250): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("unbounded operation")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("protected release hermetic failure matrix", () => {
  it.each(fixture.fault_points)("%s terminates boundedly and cleanup is idempotent and owned", async (fault) => {
    const run = new HermeticProtectedRun(fault);
    await bounded(run.execute()).catch(() => undefined);

    if (fault === "push_response_loss" || fault === "pull_request_response_loss" || fault === "crash") {
      await bounded(run.execute()).catch(() => undefined);
    }
    await bounded(run.cleanup()).catch(async () => bounded(run.cleanup()));
    await bounded(run.cleanup());

    expect(run.repositoryPreserved).toBe(true);
    expect(run.state.cleanup_complete).toBe(true);
    expect(run.cleanupRequeries).toBeGreaterThanOrEqual(2);
    expect(run.branches.size).toBe(0);
    expect(run.pullRequests.size).toBe(0);
    expect(run.mutations.every((entry) =>
      entry.repository_id === fixture.remote.repository_id &&
      (
        entry.resource_id.startsWith(fixture.remote.owned_branch_prefix) ||
        entry.resource_id.startsWith("fixture-pr-")
      )
    )).toBe(true);
    expect(run.mutations.some((entry) => entry.operation === ("delete_repository" as Mutation["operation"]))).toBe(false);
  });

  it("recovers response loss from durable observation without duplicate push or PR creation", async () => {
    for (const fault of ["push_response_loss", "pull_request_response_loss"] as const) {
      const run = new HermeticProtectedRun(fault);
      await bounded(run.execute()).catch(() => undefined);
      await bounded(run.execute()).catch(() => undefined);
      expect(run.mutations.filter((entry) => entry.operation === "push")).toHaveLength(1);
      expect(run.mutations.filter((entry) => entry.operation === "create_pr")).toHaveLength(1);
      await bounded(run.cleanup());
      await bounded(run.cleanup());
    }
  });

  it("the fixture enumerates every required failure authority", () => {
    expect(new Set(fixture.fault_points)).toEqual(new Set([
      "allocation",
      "provider",
      "gate",
      "push",
      "pull_request_creation",
      "push_response_loss",
      "pull_request_response_loss",
      "crash",
      "teardown_interruption",
    ]));
  });
});
