#!/usr/bin/env node
// Trust-spine manifest validator.
//
// Validates docs/remediation/trust-spine-manifest.json for:
//   1. Schema well-formedness (tickets array, required per-ticket fields).
//   2. No missing dependencies: every `depends_on` entry references a ticket
//      id that exists in the manifest.
//   3. No dependency cycles: the dependency graph is acyclic.
//   4. No status/dependency contradictions: a ticket whose `status` is `Done`
//      must not have a `depends_on` entry whose `status` is not `Done`
//      (VAL-CROSS-001 — strict manifest dependency order preserved).
//   5. `completed_at` evidence references: every `Done` ticket carries a
//      `completed_at` object with a non-empty `commit` and `phase_report`.
//
// Exits 0 when the manifest is valid, 1 on any violation. Diagnostics go to
// stderr; a one-line success summary goes to stdout.
//
// Usage:
//   node orchestrator/scripts/validate-trust-spine-manifest.mjs \
//       [docs/remediation/trust-spine-manifest.json]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve(
  process.argv[2] ?? "docs/remediation/trust-spine-manifest.json",
);

const VALID_STATUSES = new Set(["Todo", "InProgress", "Done", "Blocked"]);

let violations = 0;
function fail(message) {
  console.error(`manifest-validator: ${message}`);
  violations += 1;
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(
    `manifest-validator: could not parse ${manifestPath}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
}

if (!Array.isArray(manifest.tickets) || manifest.tickets.length === 0) {
  console.error(`manifest-validator: manifest has no tickets array`);
  process.exit(1);
}

const byId = new Map();
const order = [];
for (const ticket of manifest.tickets) {
  if (typeof ticket.id !== "string" || !ticket.id) {
    fail(`ticket with missing id: ${JSON.stringify(ticket).slice(0, 120)}`);
    continue;
  }
  if (byId.has(ticket.id)) {
    fail(`duplicate ticket id: ${ticket.id}`);
    continue;
  }
  byId.set(ticket.id, ticket);
  order.push(ticket.id);

  if (typeof ticket.status !== "string" || !VALID_STATUSES.has(ticket.status)) {
    fail(`ticket ${ticket.id} has invalid status: ${JSON.stringify(ticket.status)}`);
  }
  if (!Array.isArray(ticket.depends_on)) {
    fail(`ticket ${ticket.id} depends_on is not an array`);
  }
}

// 1. No missing dependencies.
for (const ticket of manifest.tickets) {
  if (!Array.isArray(ticket.depends_on)) continue;
  for (const dep of ticket.depends_on) {
    if (typeof dep !== "string" || !dep) {
      fail(`ticket ${ticket.id} has non-string dependency: ${JSON.stringify(dep)}`);
      continue;
    }
    if (!byId.has(dep)) {
      fail(`ticket ${ticket.id} depends on missing ticket: ${dep}`);
    }
  }
}

// 2. No dependency cycles (DFS).
const WHITE = 0, GRAY = 1, BLACK = 2;
const color = new Map(order.map((id) => [id, WHITE]));
const stackPath = [];
function dfsVisit(id) {
  color.set(id, GRAY);
  stackPath.push(id);
  const deps = byId.get(id)?.depends_on ?? [];
  for (const dep of deps) {
    if (!byId.has(dep)) continue; // reported as missing dep above
    const c = color.get(dep);
    if (c === GRAY) {
      const cycleStart = stackPath.indexOf(dep);
      fail(
        `dependency cycle: ${stackPath.slice(cycleStart).concat(dep).join(" -> ")}`,
      );
    } else if (c === WHITE) {
      dfsVisit(dep);
    }
  }
  stackPath.pop();
  color.set(id, BLACK);
}
for (const id of order) {
  if (color.get(id) === WHITE) dfsVisit(id);
}

// 3. No status/dependency contradictions (VAL-CROSS-001).
for (const ticket of manifest.tickets) {
  if (ticket.status !== "Done") continue;
  for (const dep of ticket.depends_on ?? []) {
    const depTicket = byId.get(dep);
    if (depTicket && depTicket.status !== "Done") {
      fail(
        `ticket ${ticket.id} is Done but dependency ${dep} is ${depTicket.status}`,
      );
    }
  }
}

// 4. completed_at evidence references for Done tickets.
for (const ticket of manifest.tickets) {
  if (ticket.status !== "Done") continue;
  const completed = ticket.completed_at;
  if (completed == null || typeof completed !== "object") {
    fail(`ticket ${ticket.id} is Done but has no completed_at object`);
    continue;
  }
  if (typeof completed.commit !== "string" || !/^[0-9a-f]{7,40}$/.test(completed.commit)) {
    fail(
      `ticket ${ticket.id} completed_at.commit is not a valid git SHA: ${JSON.stringify(completed.commit)}`,
    );
  }
  if (typeof completed.phase_report !== "string" || !completed.phase_report) {
    fail(
      `ticket ${ticket.id} completed_at.phase_report is missing or empty`,
    );
  }
}

if (violations > 0) {
  console.error(`manifest-validator: ${violations} violation(s) in ${manifestPath}`);
  process.exit(1);
}

const done = order.filter((id) => byId.get(id).status === "Done").length;
console.log(
  `manifest-validator: OK — ${order.length} tickets, ${done} Done, no missing deps, no cycles, no status contradictions`,
);
