import { describe, it, expect } from "vitest";
import { FOM_DISCIPLINES, getDiscipline, getPromptCalibrationText } from "../../src/fom.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

describe("AC-12 — FOM disciplines in agent prompt", () => {
  const agentPromptPath = join(import.meta.dirname, "../../../agents/rickgent/AGENTS.md");
  const agentPrompt = existsSync(agentPromptPath) ? readFileSync(agentPromptPath, "utf-8") : "";

  it("ships 'hierarchy of evidence' discipline", () => {
    expect(agentPrompt.toLowerCase()).toContain("hierarchy of evidence");
  });

  it("ships 'silence is not success' discipline", () => {
    expect(agentPrompt.toLowerCase()).toContain("silence is not success");
  });

  it("ships 'subtract before you add' discipline", () => {
    expect(agentPrompt.toLowerCase()).toContain("subtract before you add");
  });

  it("ships 'convergence vs attrition' discipline", () => {
    expect(agentPrompt.toLowerCase()).toContain("convergence vs attrition");
  });

  it("does NOT contain legacy 'tmux' terminology", () => {
    expect(agentPrompt.toLowerCase()).not.toContain("tmux");
  });

  it("does NOT contain legacy 'state.json' terminology", () => {
    expect(agentPrompt.toLowerCase()).not.toContain("state.json");
  });

  it("does NOT contain legacy 'install.sh' terminology", () => {
    expect(agentPrompt.toLowerCase()).not.toContain("install.sh");
  });

  it("FOM_DISCIPLINES has at least 10 disciplines", () => {
    expect(FOM_DISCIPLINES.length).toBeGreaterThanOrEqual(10);
  });

  it("getDiscipline returns the discipline by key", () => {
    const d = getDiscipline("silence-is-not-success");
    expect(d).toBeDefined();
    expect(d?.phrase).toBe("silence is not success");
  });

  it("getPromptCalibrationText produces non-empty text", () => {
    expect(getPromptCalibrationText().length).toBeGreaterThan(100);
  });
});
