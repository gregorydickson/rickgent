import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Registry, type PipelineStatus, type TicketState } from "../../src/lifecycle/registry.js";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("registry", () => {
  let tempDir: string;
  let registryPath: string;
  let registry: Registry;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rickgent-registry-"));
    registryPath = join(tempDir, ".rickgent", "registry.json");
    registry = new Registry(registryPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("load returns empty state when file does not exist", () => {
    const state = registry.load();
    expect(state.runId).toBe("");
    expect(state.tickets).toEqual({});
  });

  it("save writes JSON and creates parent directories", () => {
    const state: PipelineStatus = {
      runId: "run-1",
      tickets: {},
      startedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    registry.save(state);
    expect(existsSync(registryPath)).toBe(true);
    const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as PipelineStatus;
    expect(raw.runId).toBe("run-1");
  });

  it("save updates the updatedAt timestamp", () => {
    const state: PipelineStatus = {
      runId: "run-1",
      tickets: {},
      startedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    registry.save(state);
    const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as PipelineStatus;
    expect(raw.updatedAt).not.toBe("2025-01-01T00:00:00.000Z");
  });

  it("getTicketState returns null for unknown ticket", () => {
    expect(registry.getTicketState("T-001")).toBeNull();
  });

  it("getTicketState returns state for known ticket", () => {
    const ticket: TicketState = {
      id: "T-001",
      title: "Test ticket",
      status: "Todo",
      phase: "research",
      declaredPaths: ["src/"],
      attempt: 1,
      completionCommitSha: null,
      updatedAt: new Date().toISOString(),
    };
    registry.save({ runId: "run-1", tickets: { "T-001": ticket }, startedAt: "", updatedAt: "" });
    const result = registry.getTicketState("T-001");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("T-001");
    expect(result?.status).toBe("Todo");
  });

  it("updateTicketState throws for unknown ticket", () => {
    expect(() => registry.updateTicketState("T-999", { status: "Done" })).toThrow();
  });

  it("updateTicketState merges updates into existing ticket", () => {
    const ticket: TicketState = {
      id: "T-001",
      title: "Test ticket",
      status: "Todo",
      phase: "research",
      declaredPaths: ["src/"],
      attempt: 1,
      completionCommitSha: null,
      updatedAt: new Date().toISOString(),
    };
    registry.save({ runId: "run-1", tickets: { "T-001": ticket }, startedAt: "", updatedAt: "" });
    registry.updateTicketState("T-001", { status: "In Progress", phase: "implement" });
    const result = registry.getTicketState("T-001");
    expect(result?.status).toBe("In Progress");
    expect(result?.phase).toBe("implement");
    expect(result?.title).toBe("Test ticket"); // unchanged
  });

  it("getPipelineStatus returns full state", () => {
    registry.save({
      runId: "run-42",
      tickets: {
        "T-1": {
          id: "T-1",
          title: "A",
          status: "Done",
          phase: "simplify",
          declaredPaths: [],
          attempt: 1,
          completionCommitSha: "abc",
          updatedAt: new Date().toISOString(),
        },
      },
      startedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    const status = registry.getPipelineStatus();
    expect(status.runId).toBe("run-42");
    expect(Object.keys(status.tickets)).toHaveLength(1);
  });

  it("load returns empty state on corrupted JSON", () => {
    mkdirSync(join(tempDir, ".rickgent"), { recursive: true });
    writeFileSync(registryPath, "{ not valid json");
    const state = registry.load();
    expect(state.runId).toBe("");
    expect(state.tickets).toEqual({});
  });

  it("load normalizes an empty-object status file to a safe default", () => {
    mkdirSync(join(tempDir, ".rickgent"), { recursive: true });
    writeFileSync(registryPath, "{}");
    const state = registry.load();
    expect(state.tickets).toEqual({});
    expect(state.tickets).not.toBeUndefined();
    expect(() => Object.keys(state.tickets)).not.toThrow();
    expect(Object.keys(state.tickets)).toHaveLength(0);
  });

  it("load normalizes a truncated/wrong-shape status file to a safe default", () => {
    mkdirSync(join(tempDir, ".rickgent"), { recursive: true });
    writeFileSync(registryPath, '{"runId":"run-9"}');
    const state = registry.load();
    expect(state.runId).toBe("run-9");
    expect(state.tickets).toEqual({});
    expect(() => Object.entries(state.tickets)).not.toThrow();
  });

  it("load normalizes a non-object JSON value (array) to a safe default", () => {
    mkdirSync(join(tempDir, ".rickgent"), { recursive: true });
    writeFileSync(registryPath, "[]");
    const state = registry.load();
    expect(state.runId).toBe("");
    expect(state.tickets).toEqual({});
  });

  it("load normalizes a status file whose tickets field is the wrong type", () => {
    mkdirSync(join(tempDir, ".rickgent"), { recursive: true });
    writeFileSync(registryPath, '{"runId":"run-3","tickets":"nope"}');
    const state = registry.load();
    expect(state.runId).toBe("run-3");
    expect(state.tickets).toEqual({});
  });

  // Mirrors the exact rendering loop in cli.ts runStatus so the test observes the
  // real crash the CLI would hit on a malformed per-ticket entry.
  function renderStatusTable(status: PipelineStatus): string[] {
    const lines: string[] = [];
    for (const [id, t] of Object.entries(status.tickets)) {
      lines.push(`  ${id}: [${t.status}] phase=${t.phase} attempt=${t.attempt} commit=${t.completionCommitSha ?? "(none)"}`);
    }
    return lines;
  }

  it("load coerces or skips a null per-ticket entry so status rendering does not throw", () => {
    mkdirSync(join(tempDir, ".rickgent"), { recursive: true });
    writeFileSync(registryPath, '{"tickets":{"T1":null}}');
    const state = registry.load();
    expect(() => renderStatusTable(state)).not.toThrow();
    expect(state.tickets["T1"] === undefined || typeof state.tickets["T1"] === "object").toBe(true);
    expect(state.tickets["T1"]).not.toBeNull();
  });

  it("load skips non-object per-ticket entries (string/number/array)", () => {
    mkdirSync(join(tempDir, ".rickgent"), { recursive: true });
    writeFileSync(registryPath, '{"tickets":{"T1":"nope","T2":42,"T3":[]}}');
    const state = registry.load();
    expect(() => renderStatusTable(state)).not.toThrow();
    expect(Object.keys(state.tickets)).toHaveLength(0);
  });

  it("load coerces an invalid-shape per-ticket entry to a safe default and keeps a valid one", () => {
    mkdirSync(join(tempDir, ".rickgent"), { recursive: true });
    writeFileSync(
      registryPath,
      JSON.stringify({
        tickets: {
          T1: { id: "T1" },
          T2: {
            id: "T2",
            title: "Valid",
            status: "Done",
            phase: "simplify",
            declaredPaths: ["src/"],
            attempt: 2,
            completionCommitSha: "abc",
            updatedAt: "2025-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    const state = registry.load();
    expect(() => renderStatusTable(state)).not.toThrow();
    expect(state.tickets["T1"].status).toBe("Todo");
    expect(state.tickets["T1"].phase).toBe("");
    expect(state.tickets["T1"].attempt).toBe(0);
    expect(state.tickets["T1"].completionCommitSha).toBeNull();
    expect(state.tickets["T2"].status).toBe("Done");
    expect(state.tickets["T2"].completionCommitSha).toBe("abc");
  });
});
