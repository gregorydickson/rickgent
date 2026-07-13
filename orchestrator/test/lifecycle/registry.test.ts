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
});
