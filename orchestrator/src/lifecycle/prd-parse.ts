// Human Markdown parsing has two deliberately separate boundaries:
//
// - `parsePrdMarkdown` is the legacy read-only planning/audit projection.
// - `adaptPrdMarkdownToTicketContracts` is the strict executable adapter. It
//   requires compact JSON for nested contract values, seals drafts, and admits
//   the complete set through the production TicketContract normalizer.

import { readFileSync } from "fs";
import type { AcceptanceCriterion, PrdInput } from "../core/prd.js";
import {
  TICKET_CONTRACT_SCHEMA_VERSION,
  TicketContractError,
  canonicalJson,
  sealTicketContracts,
  type TicketAcceptanceCriterion,
  type TicketContract,
  type TicketContractDraft,
  type TicketContractNormalizationContext,
  type TicketVerification,
} from "../contracts/ticket-contract.js";

/** Lossy compatibility projection for refine/interview/audit only. */
export interface LegacyTicketDraft {
  id: string;
  title: string;
  description: string;
  declaredPaths: string[];
  acceptanceCriteria: string[];
}

export interface ParsedPrd {
  prd: PrdInput;
  /** Never pass these drafts to allocation or dispatch. */
  tickets: LegacyTicketDraft[];
}

export interface ExecutablePrd {
  readonly prd: PrdInput;
  readonly contracts: readonly TicketContract[];
}

interface Section {
  heading: string;
  lines: string[];
}

/** Return only executable Markdown lines; fenced examples are inert input. */
function unfencedLines(text: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const fenceMatch = rawLine.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence === null) lines.push(rawLine);
  }
  return lines;
}

/** Split executable Markdown into H3 sections. */
function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of unfencedLines(text)) {
    const heading = line.match(/^###\s+(.*)$/);
    if (heading) {
      current = { heading: heading[1]!.trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

/** Pull backticked values from a human list, falling back to comma splitting. */
function extractItems(value: string): string[] {
  const backticked = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim());
  if (backticked.length > 0) return backticked.filter((item) => item.length > 0);
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function bulletMatch(line: string): RegExpMatchArray | null {
  return line.match(/^\s*[-*]\s*\*\*([^:*]+):\*\*\s*(.*)$/);
}

function normalizeBulletKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Legacy last-key-wins behavior exists only on the read-only projection. */
function readBullets(lines: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const match = bulletMatch(line);
    if (match) out[normalizeBulletKey(match[1]!)] = match[2]!.trim();
  }
  return out;
}

function readStrictBullets(lines: readonly string[], label: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    const match = bulletMatch(line);
    if (!match) continue;
    const key = normalizeBulletKey(match[1]!);
    if (out.has(key)) {
      throw new TicketContractError("TICKET_MARKDOWN_DUPLICATE_KEY", `${label} duplicates ${match[1]!.trim()}`);
    }
    out.set(key, match[2]!.trim());
  }
  return out;
}

function findLine(text: string, expression: RegExp): string | null {
  for (const line of unfencedLines(text)) {
    const match = line.match(expression);
    if (match) return (match[1] ?? "").trim();
  }
  return null;
}

function legacyTicketId(heading: string, index: number): string {
  const number = heading.match(/ticket\s+(\d+)/i);
  if (number) return `T${number[1]}`;
  const slug = heading
    .replace(/^ticket[:\s-]*/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `T-${slug}` : `T${index + 1}`;
}

function unwrapInlineCode(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && !trimmed.startsWith("```")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseJsonBullet(value: string | undefined, label: string): unknown {
  if (value === undefined) throw new TicketContractError("TICKET_MARKDOWN_FIELD_MISSING", `${label} is required`);
  try {
    return JSON.parse(unwrapInlineCode(value));
  } catch (error) {
    throw new TicketContractError(
      "TICKET_MARKDOWN_JSON_INVALID",
      `${label} must be compact JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function strictStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TicketContractError("TICKET_MARKDOWN_JSON_INVALID", `${label} must be a JSON string array`);
  }
  return [...value] as string[];
}

function assertKeys(
  bullets: ReadonlyMap<string, string>,
  keys: readonly string[],
  label: string,
): void {
  for (const key of bullets.keys()) {
    if (!keys.includes(key)) {
      if (key === "verifycommand") {
        throw new TicketContractError(
          "TICKET_VERIFICATION_LEGACY_FORBIDDEN",
          `${label}.verifyCommand is shell text; use verifications JSON`,
        );
      }
      if (key === "declaredpaths") {
        throw new TicketContractError(
          "TICKET_SCOPE_LEGACY_FORBIDDEN",
          `${label}.declaredPaths loses change kind and directory semantics; use scope JSON`,
        );
      }
      throw new TicketContractError("TICKET_SCHEMA_UNKNOWN_FIELD", `${label}.${key} is unknown`);
    }
  }
  for (const key of keys) {
    if (!bullets.has(key)) {
      throw new TicketContractError("TICKET_MARKDOWN_FIELD_MISSING", `${label}.${key} is required`);
    }
  }
}

function acceptanceHeading(heading: string): { id: string; description: string } | null {
  const match = heading.match(/^(AC-[A-Z0-9]+(?:-[A-Z0-9]+)*)(?::\s*|\s+)(.+)$/);
  if (!match) return null;
  return { id: match[1]!, description: match[2]!.trim() };
}

function ticketHeading(heading: string): { id: string; title: string } | null {
  const match = heading.match(/^Ticket\s+(?:t)?(\d{2,})(?::\s*|\s+)(.+)$/i);
  if (!match) return null;
  return { id: `t${match[1]}`, title: match[2]!.trim() };
}

interface StrictAcceptanceDraft {
  readonly criterion: Omit<TicketAcceptanceCriterion, "verification_ids">;
  readonly verifications: readonly TicketVerification[];
}

function strictAcceptanceSections(sections: readonly Section[]): Map<string, StrictAcceptanceDraft> {
  const criteria = new Map<string, StrictAcceptanceDraft>();
  for (const section of sections) {
    if (!/^AC-/i.test(section.heading)) continue;
    const heading = acceptanceHeading(section.heading);
    if (heading === null) {
      throw new TicketContractError(
        "TICKET_AC_INVALID",
        `acceptance criterion heading must contain an explicit local ID and description: ${section.heading}`,
      );
    }
    if (criteria.has(heading.id)) {
      throw new TicketContractError("TICKET_ID_DUPLICATE", `acceptance criteria duplicates ${heading.id}`);
    }
    const bullets = readStrictBullets(section.lines, heading.id);
    assertKeys(
      bullets,
      ["interfaceids", "verifications", "scope", "type"],
      heading.id,
    );
    const interfaceIds = strictStringArray(
      parseJsonBullet(bullets.get("interfaceids"), `${heading.id}.interfaceIds`),
      `${heading.id}.interfaceIds`,
    );
    const verifications = parseJsonBullet(bullets.get("verifications"), `${heading.id}.verifications`);
    if (!Array.isArray(verifications) || verifications.length === 0) {
      throw new TicketContractError("TICKET_VERIFICATION_INVALID", `${heading.id}.verifications must not be empty`);
    }
    const type = bullets.get("type")?.toLowerCase();
    if (type !== "test" && type !== "lint" && type !== "grep") {
      throw new TicketContractError("TICKET_AC_INVALID", `${heading.id}.type is invalid`);
    }
    const scope = extractItems(bullets.get("scope") ?? "");
    if (scope.length === 0) throw new TicketContractError("TICKET_AC_INVALID", `${heading.id}.scope is empty`);
    criteria.set(heading.id, {
      criterion: {
        id: heading.id,
        description: heading.description,
        interface_ids: interfaceIds,
      },
      verifications: verifications as TicketVerification[],
    });
  }
  return criteria;
}

function strictTicketDrafts(
  sections: readonly Section[],
  acceptanceCriteria: ReadonlyMap<string, StrictAcceptanceDraft>,
): TicketContractDraft[] {
  const drafts: TicketContractDraft[] = [];
  const ticketIds = new Set<string>();
  for (const section of sections) {
    if (!/^Ticket\b/i.test(section.heading)) continue;
    const heading = ticketHeading(section.heading);
    if (heading === null) {
      throw new TicketContractError(
        "TICKET_ID_INVALID",
        `ticket heading must use an explicit two-digit ID (for example Ticket 01): ${section.heading}`,
      );
    }
    if (ticketIds.has(heading.id)) throw new TicketContractError("TICKET_ID_DUPLICATE", `tickets duplicates ${heading.id}`);
    ticketIds.add(heading.id);
    const bullets = readStrictBullets(section.lines, heading.id);
    assertKeys(
      bullets,
      ["description", "dependson", "scope", "interfaces", "acceptancecriteria", "budgets"],
      heading.id,
    );
    const description = unwrapInlineCode(bullets.get("description") ?? "");
    if (description.length === 0) throw new TicketContractError("TICKET_SCHEMA_INVALID", `${heading.id}.description is empty`);
    const references = strictStringArray(
      parseJsonBullet(bullets.get("acceptancecriteria"), `${heading.id}.acceptanceCriteria`),
      `${heading.id}.acceptanceCriteria`,
    );
    if (references.length === 0) throw new TicketContractError("TICKET_AC_INVALID", `${heading.id} references no acceptance criteria`);
    if (new Set(references).size !== references.length) {
      throw new TicketContractError("TICKET_ID_DUPLICATE", `${heading.id}.acceptanceCriteria contains duplicates`);
    }

    const selectedCriteria: TicketAcceptanceCriterion[] = [];
    const selectedVerifications = new Map<string, TicketVerification>();
    for (const reference of references) {
      const selected = acceptanceCriteria.get(reference);
      if (selected === undefined) {
        throw new TicketContractError("TICKET_AC_REFERENCE_UNKNOWN", `${heading.id} references unknown ${reference}`);
      }
      const verificationIds: string[] = [];
      for (const verification of selected.verifications) {
        if (typeof verification !== "object" || verification === null || typeof verification.id !== "string") {
          throw new TicketContractError("TICKET_VERIFICATION_INVALID", `${reference} has a malformed verification`);
        }
        const prior = selectedVerifications.get(verification.id);
        if (prior !== undefined && canonicalJson(prior) !== canonicalJson(verification)) {
          throw new TicketContractError("TICKET_ID_DUPLICATE", `${heading.id} has conflicting verification ${verification.id}`);
        }
        selectedVerifications.set(verification.id, verification);
        verificationIds.push(verification.id);
      }
      selectedCriteria.push({ ...selected.criterion, verification_ids: verificationIds });
    }

    drafts.push({
      schema_version: TICKET_CONTRACT_SCHEMA_VERSION,
      id: heading.id,
      title: heading.title,
      description,
      depends_on: strictStringArray(
        parseJsonBullet(bullets.get("dependson"), `${heading.id}.dependsOn`),
        `${heading.id}.dependsOn`,
      ),
      scope: parseJsonBullet(bullets.get("scope"), `${heading.id}.scope`) as TicketContractDraft["scope"],
      interfaces: parseJsonBullet(bullets.get("interfaces"), `${heading.id}.interfaces`) as TicketContractDraft["interfaces"],
      acceptance_criteria: selectedCriteria,
      verifications: [...selectedVerifications.values()],
      budgets: parseJsonBullet(bullets.get("budgets"), `${heading.id}.budgets`) as TicketContractDraft["budgets"],
    });
  }
  return drafts;
}

export function parsePrdMarkdown(text: string): ParsedPrd {
  const sections = splitSections(text);
  const title = findLine(text, /^##\s*Title:\s*(.*)$/i) ?? findLine(text, /^#\s+(.*)$/) ?? "Untitled PRD";
  const descriptionLines = sections.find((section) => /^description/i.test(section.heading))?.lines ?? [];
  const description = descriptionLines.join("\n").trim();

  const acceptanceCriteria: AcceptanceCriterion[] = [];
  for (const section of sections) {
    const heading = acceptanceHeading(section.heading);
    if (heading === null) continue;
    const bullets = readBullets(section.lines);
    const type = (bullets.type ?? "test").toLowerCase();
    let structured: AcceptanceCriterion["verification"];
    if (bullets.verifications !== undefined) {
      try {
        const parsed = parseJsonBullet(bullets.verifications, `${heading.id}.verifications`);
        const first = Array.isArray(parsed) ? parsed[0] : undefined;
        if (
          first !== null &&
          typeof first === "object" &&
          typeof (first as { executable?: unknown }).executable === "string" &&
          Array.isArray((first as { args?: unknown }).args)
        ) {
          structured = {
            executable: (first as { executable: string }).executable,
            args: [...(first as { args: string[] }).args],
          };
        }
      } catch {
        // Legacy parsing is observational; strict parsing reports the actionable error.
      }
    }
    acceptanceCriteria.push({
      id: heading.id,
      description: heading.description,
      type: type === "lint" || type === "grep" ? type : "test",
      verifyCommand: bullets.verifycommand ?? "",
      ...(structured === undefined ? {} : { verification: structured }),
      scope: extractItems(bullets.scope ?? ""),
    });
  }

  const reviewedLine = findLine(text, /reviewed:\s*(\w+)/i);
  const reviewed = reviewedLine !== null && /^(yes|true|done)$/i.test(reviewedLine);
  const notes = findLine(text, /^\s*[-*]?\s*(?:\*\*)?notes:?(?:\*\*)?\s*(.*)$/i) ?? "";

  const tickets: LegacyTicketDraft[] = [];
  let ticketIndex = 0;
  for (const section of sections) {
    if (!/^ticket/i.test(section.heading)) continue;
    const bullets = readBullets(section.lines);
    const heading = section.heading.replace(/^ticket\s*(?:t)?\d*\s*[:.-]?\s*/i, "").trim();
    tickets.push({
      id: legacyTicketId(section.heading, ticketIndex),
      title: heading || section.heading,
      description: bullets.description ?? (heading || section.heading),
      declaredPaths: extractItems(bullets.declaredpaths ?? ""),
      acceptanceCriteria: extractItems(bullets.acceptancecriteria ?? ""),
    });
    ticketIndex++;
  }

  return {
    prd: {
      title,
      description,
      acceptanceCriteria,
      simplificationReview: { reviewed, notes },
    },
    tickets,
  };
}

export function adaptPrdMarkdownToTicketContracts(
  text: string,
  context: TicketContractNormalizationContext = {},
): readonly TicketContract[] {
  const sections = splitSections(text);
  const acceptanceCriteria = strictAcceptanceSections(sections);
  const drafts = strictTicketDrafts(sections, acceptanceCriteria);
  return sealTicketContracts(drafts, context);
}

export function parseExecutablePrdMarkdown(
  text: string,
  context: TicketContractNormalizationContext = {},
): ExecutablePrd {
  return {
    prd: parsePrdMarkdown(text).prd,
    contracts: adaptPrdMarkdownToTicketContracts(text, context),
  };
}

export function parsePrdFile(path: string): ParsedPrd {
  return parsePrdMarkdown(readFileSync(path, "utf8"));
}

export function parseExecutablePrdFile(
  path: string,
  context: TicketContractNormalizationContext = {},
): ExecutablePrd {
  return parseExecutablePrdMarkdown(readFileSync(path, "utf8"), context);
}
