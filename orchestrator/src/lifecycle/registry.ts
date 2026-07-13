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

const TICKET_STATUSES: readonly TicketState["status"][] = [
  "Todo",
  "In Progress",
  "Done",
  "Skipped",
  "Failed",
];

function normalizeTicket(id: string, raw: unknown): TicketState | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const t = raw as Record<string, unknown>;
  return {
    id: typeof t.id === "string" ? t.id : id,
    title: typeof t.title === "string" ? t.title : "",
    status:
      typeof t.status === "string" && (TICKET_STATUSES as readonly string[]).includes(t.status)
        ? (t.status as TicketState["status"])
        : "Todo",
    phase: typeof t.phase === "string" ? t.phase : "",
    declaredPaths: Array.isArray(t.declaredPaths)
      ? t.declaredPaths.filter((p): p is string => typeof p === "string")
      : [],
    attempt: typeof t.attempt === "number" ? t.attempt : 0,
    completionCommitSha: typeof t.completionCommitSha === "string" ? t.completionCommitSha : null,
    updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : "",
  };
}

function normalizeStatus(parsed: unknown): PipelineStatus {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyStatus();
  }
  const obj = parsed as Record<string, unknown>;
  const rawTickets = obj.tickets;
  const tickets: Record<string, TicketState> = {};
  if (rawTickets !== null && typeof rawTickets === "object" && !Array.isArray(rawTickets)) {
    for (const [id, raw] of Object.entries(rawTickets as Record<string, unknown>)) {
      const normalized = normalizeTicket(id, raw);
      if (normalized !== null) {
        tickets[id] = normalized;
      }
    }
  }
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
