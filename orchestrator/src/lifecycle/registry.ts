// Registry — session state tracking via .rickgent/registry.json.
// AC-3: durable pipeline state across crashes and resumes.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface TicketState {
  id: string;
  title: string;
  status: "Todo" | "In Progress" | "Done" | "Skipped" | "Failed";
  phase: string;
  declaredPaths: string[];
  attempt: number;
  completionCommitSha: string | null;
  updatedAt: string;
}

export interface PipelineStatus {
  runId: string;
  tickets: Record<string, TicketState>;
  startedAt: string;
  updatedAt: string;
}

export class Registry {
  constructor(private registryPath: string) {}

  load(): PipelineStatus {
    if (!existsSync(this.registryPath)) {
      return { runId: "", tickets: {}, startedAt: "", updatedAt: "" };
    }
    try {
      return JSON.parse(readFileSync(this.registryPath, "utf-8")) as PipelineStatus;
    } catch {
      return { runId: "", tickets: {}, startedAt: "", updatedAt: "" };
    }
  }

  save(state: PipelineStatus): void {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    state.updatedAt = new Date().toISOString();
    writeFileSync(this.registryPath, JSON.stringify(state, null, 2));
  }

  getTicketState(ticketId: string): TicketState | null {
    return this.load().tickets[ticketId] ?? null;
  }

  updateTicketState(ticketId: string, updates: Partial<TicketState>): void {
    const state = this.load();
    if (!state.tickets[ticketId]) {
      throw new Error(`ticket ${ticketId} not found in registry`);
    }
    state.tickets[ticketId] = { ...state.tickets[ticketId], ...updates, updatedAt: new Date().toISOString() };
    this.save(state);
  }

  getPipelineStatus(): PipelineStatus {
    return this.load();
  }
}
