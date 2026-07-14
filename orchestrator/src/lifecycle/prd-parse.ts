// PRD decomposition — parse a markdown PRD into the PRD model the verdict core
// validates plus the ≥1 tickets the build loop dispatches (B1).
//
// The parser is deliberately tolerant: it extracts the acceptance criteria and
// tickets the build needs (each ticket's declared paths drive the dispatch
// scope) without imposing a rigid schema, so a hand-authored PRD still
// decomposes. It performs NO validation — `evaluatePrd` is the single PRD
// oracle; this module only shapes the input for it.

import { readFileSync } from "fs";
import type { AcceptanceCriterion, PrdInput } from "../core/prd.js";

export interface TicketPlan {
  id: string;
  title: string;
  description: string;
  declaredPaths: string[];
  acceptanceCriteria: string[];
}

export interface ParsedPrd {
  prd: PrdInput;
  tickets: TicketPlan[];
}

interface Section {
  heading: string;
  lines: string[];
}

/** Split a markdown doc into `###`-level sections keyed by heading text. */
function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const h3 = rawLine.match(/^###\s+(.*)$/);
    if (h3) {
      current = { heading: h3[1]!.trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(rawLine);
  }
  return sections;
}

/** Pull the backticked items out of a bullet value like `` `a`, `b` `` → [a,b].
 *  Falls back to a comma-split of the plain value when nothing is backticked. */
function extractItems(value: string): string[] {
  const backticked = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
  if (backticked.length > 0) return backticked.filter((s) => s.length > 0);
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read `- **key:** value` bullets from a section body into a map. */
function readBullets(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s*\*\*([^:*]+):\*\*\s*(.*)$/);
    if (m) {
      out[m[1]!.trim().toLowerCase()] = m[2]!.trim();
    }
  }
  return out;
}

function findLine(text: string, re: RegExp): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) return (m[1] ?? "").trim();
  }
  return null;
}

function ticketIdFrom(heading: string, index: number): string {
  const num = heading.match(/ticket\s+(\d+)/i);
  if (num) return `T${num[1]}`;
  const slug = heading
    .replace(/^ticket[:\s-]*/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `T-${slug}` : `T${index + 1}`;
}

export function parsePrdMarkdown(text: string): ParsedPrd {
  const sections = splitSections(text);

  const title =
    findLine(text, /^##\s*Title:\s*(.*)$/i) ??
    findLine(text, /^#\s+(.*)$/) ??
    "Untitled PRD";

  const descriptionLines = sections.find((s) => /^description/i.test(s.heading))?.lines ?? [];
  const description = descriptionLines.join("\n").trim();

  const acceptanceCriteria: AcceptanceCriterion[] = [];
  for (const s of sections) {
    if (!/^ac[-\s]/i.test(s.heading) && !/^ac\d/i.test(s.heading)) continue;
    const bullets = readBullets(s.lines);
    const type = (bullets["type"] ?? "test").toLowerCase();
    acceptanceCriteria.push({
      description: s.heading,
      type: type === "lint" || type === "grep" ? (type as AcceptanceCriterion["type"]) : "test",
      verifyCommand: bullets["verifycommand"] ?? "",
      scope: extractItems(bullets["scope"] ?? ""),
    });
  }

  const reviewedLine = findLine(text, /reviewed:\s*(\w+)/i);
  const reviewed = reviewedLine !== null && /^(yes|true|done)$/i.test(reviewedLine);
  const notes = findLine(text, /^\s*[-*]?\s*(?:\*\*)?notes:?(?:\*\*)?\s*(.*)$/i) ?? "";

  const tickets: TicketPlan[] = [];
  let ticketIndex = 0;
  for (const s of sections) {
    if (!/^ticket/i.test(s.heading)) continue;
    const bullets = readBullets(s.lines);
    const heading = s.heading.replace(/^ticket\s*\d*\s*[:.-]?\s*/i, "").trim();
    tickets.push({
      id: ticketIdFrom(s.heading, ticketIndex),
      title: heading || s.heading,
      description: bullets["description"] ?? (heading || s.heading),
      declaredPaths: extractItems(bullets["declaredpaths"] ?? ""),
      acceptanceCriteria: extractItems(bullets["acceptancecriteria"] ?? ""),
    });
    ticketIndex++;
  }

  const prd: PrdInput = {
    title,
    description,
    acceptanceCriteria,
    simplificationReview: { reviewed, notes },
  };

  return { prd, tickets };
}

export function parsePrdFile(path: string): ParsedPrd {
  return parsePrdMarkdown(readFileSync(path, "utf-8"));
}
