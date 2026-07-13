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

function emptyStatus(): PipelineStatus {
  return { runId: "", tickets: {}, startedAt: "", updatedAt: "" };
}

function normalizeStatus(parsed: unknown): PipelineStatus {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyStatus();
  }
  const obj = parsed as Record<string, unknown>;
  const rawTickets = obj.tickets;
  const tickets =
    rawTickets !== null && typeof rawTickets === "object" && !Array.isArray(rawTickets)
      ? (rawTickets as Record<string, TicketState>)
      : {};
  return {
    runId: typeof obj.runId === "string" ? obj.runId : "",
    tickets,
    startedAt: typeof obj.startedAt === "string" ? obj.startedAt : "",
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : "",
  };
}

export class Registry {
  constructor(private registryPath: string) {}

  load(): PipelineStatus {
    if (!existsSync(this.registryPath)) {
      return emptyStatus();
    }
    try {
      return normalizeStatus(JSON.parse(readFileSync(this.registryPath, "utf-8")));
    } catch {
      return emptyStatus();
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
