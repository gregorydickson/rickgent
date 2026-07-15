// Szechuan Sauce Principles Catalog
//
// Ported from pickle-rick-claude's `szechuan-sauce-principles.md`. 30+ coding
// principles organized by priority bucket (P0 security/data-loss through P4
// style). Each principle carries a name, priority, and a concise description
// used by both the violation scanner and the LLM judge.
//
// The catalog is a pure data module — no I/O, no side effects — so it can be
// imported by the CLI, the test suite, and the MicroverseLoop worker prompt
// builder alike.

export type PriorityBucket = "P0" | "P1" | "P2" | "P3" | "P4";

export interface Principle {
  /** Canonical name (e.g. "KISS", "Fail-Fast"). */
  name: string;
  /** Priority bucket: P0 (critical) through P4 (optional). */
  priority: PriorityBucket;
  /** Short description of what the principle enforces. */
  description: string;
  /** Optional domain tag (e.g. "api", "ui") for supplemental principles. */
  domain?: string;
  /** Optional focus tag that, when matched by --focus, elevates this principle. */
  focusKeywords?: string[];
}

// ── Base Catalog (ported from szechuan-sauce-principles.md) ──────────────────

const BASE_PRINCIPLES: Principle[] = [
  // P0 — Critical: Security, data loss
  {
    name: "Input Validation",
    priority: "P0",
    description:
      "Validate all external input at trust boundaries. Unvalidated input enables injection, data corruption, and privilege escalation.",
    focusKeywords: ["validation", "input", "sanitization", "injection"],
  },
  {
    name: "Secure Defaults",
    priority: "P0",
    description:
      "Default to the most secure configuration. Deny-by-default, least-privilege access, encrypted-by-default.",
    focusKeywords: ["security", "defaults", "deny", "encryption"],
  },
  {
    name: "Least Privilege",
    priority: "P0",
    description:
      "Grant the minimum permissions necessary. Applies at every level: file access, API scopes, database permissions, function capabilities.",
    focusKeywords: ["privilege", "permissions", "access", "security"],
  },
  {
    name: "Migration Safety",
    priority: "P0",
    description:
      "Database migrations must be idempotent, forward-only by default, and registered. Never use destructive DDL without a data-preservation step. Every migration needs a rollback script.",
    focusKeywords: ["migration", "database", "ddl", "rollback", "schema"],
  },
  {
    name: "Honest Reporting",
    priority: "P0",
    description:
      "Silence is not success. Never report an outcome you did not observe. Verify before declaring a verdict. A fast clean pass may mean the gate never fired.",
    focusKeywords: ["reporting", "honesty", "verification", "evidence"],
  },
  {
    name: "SQL Injection Prevention",
    priority: "P0",
    description:
      "Use parameterized queries or prepared statements. Never concatenate user input into SQL strings. This is a P0 data-loss vector.",
    focusKeywords: ["sql", "injection", "query", "security"],
  },

  // P1 — High: Bugs waiting to happen
  {
    name: "Fail-Fast",
    priority: "P1",
    description:
      "Detect and report errors immediately. Don't pass bad data deeper into the system. Validate at entry points, assert invariants.",
    focusKeywords: ["error", "fail", "validation", "fast", "assert"],
  },
  {
    name: "Parse, Don't Validate",
    priority: "P1",
    description:
      "Transform data into types that prove validity. Don't check a string is valid — parse it into a typed value. Invalid states become unrepresentable.",
    focusKeywords: ["parse", "validate", "types", "validation"],
  },
  {
    name: "Observability",
    priority: "P1",
    description:
      "Understand what systems do in production. Structured logging, metrics, distributed tracing. If you can't observe it, you can't debug it.",
    focusKeywords: ["observability", "logging", "metrics", "tracing"],
  },
  {
    name: "Dependency Health",
    priority: "P1",
    description:
      "Audit dependencies for known CVEs, phantom/unused deps, and lockfile integrity. Pin versions in production. Don't import a library for one function you could write in 5 lines.",
    focusKeywords: ["dependencies", "cve", "security", "audit"],
  },
  {
    name: "Test Quality",
    priority: "P1",
    description:
      "Tests must assert on observable behavior, not implementation details. Tests that always pass are worse than no tests. Cover error paths and boundary conditions.",
    focusKeywords: ["test", "testing", "assertion", "coverage"],
  },
  {
    name: "Error Handling",
    priority: "P1",
    description:
      "Never swallow exceptions silently. Catch specific types, not bare Exception. Log or rethrow — never both. Silent failures are bugs waiting to happen.",
    focusKeywords: ["error", "handling", "exception", "catch", "swallow"],
  },

  // P2 — Medium: Maintainability
  {
    name: "KISS",
    priority: "P2",
    description:
      "Keep It Simple, Stupid. Prefer the simplest solution that works. Avoid premature abstraction, speculative generality, and over-engineered patterns.",
    focusKeywords: ["simplicity", "kiss", "complexity", "simple"],
  },
  {
    name: "YAGNI",
    priority: "P2",
    description:
      "You Aren't Gonna Need It. Don't build features, abstractions, or infrastructure until you have a concrete, immediate need. Every unused feature has four costs: build, maintain, understand, remove.",
    focusKeywords: ["yagni", "unused", "speculative", "premature"],
  },
  {
    name: "DRY",
    priority: "P2",
    description:
      "Don't Repeat Yourself. Every piece of knowledge must have a single, authoritative representation. Rule of Three: don't abstract until 3+ occurrences. Incidental similarity is NOT duplication.",
    focusKeywords: ["dry", "duplication", "repeat", "reuse"],
  },
  {
    name: "Small Functions",
    priority: "P2",
    description:
      "Functions should do one thing, do it well, and do it only. Target 5-15 lines (hard limit: 50). Name reveals intent. One level of abstraction per function.",
    focusKeywords: ["function", "size", "small", "length", "lines"],
  },
  {
    name: "Guard Clauses",
    priority: "P2",
    description:
      "Handle edge cases and invalid states at the top of a function via early returns, then proceed with the happy path unindented. Reduces nesting depth.",
    focusKeywords: ["guard", "clause", "early", "return", "nesting"],
  },
  {
    name: "Cognitive Load",
    priority: "P2",
    description:
      "Minimize the mental effort required to understand code. Reduce nesting, use consistent naming, avoid clever tricks, limit working memory demands.",
    focusKeywords: ["cognitive", "load", "complexity", "readability", "nesting"],
  },
  {
    name: "Single Source of Truth",
    priority: "P2",
    description:
      "One location for each piece of data or business rule. If you update something, you should only need to update it in one place.",
    focusKeywords: ["source", "truth", "single", "duplication"],
  },
  {
    name: "Separation of Concerns",
    priority: "P2",
    description:
      "Each component should address one well-defined concern. UI shouldn't contain business logic. Data access shouldn't format output.",
    focusKeywords: ["separation", "concerns", "responsibility", "coupling"],
  },
  {
    name: "Modularity",
    priority: "P2",
    description:
      "Independent components with hidden internals. Deep modules: simple interface, complex implementation. Shallow modules (thin wrappers) are usually slop.",
    focusKeywords: ["module", "modularity", "interface", "encapsulation"],
  },
  {
    name: "Encapsulation",
    priority: "P2",
    description:
      "Bundle data with behavior, hide internals. Tell, Don't Ask: don't get data to make decisions — tell the object to do the thing.",
    focusKeywords: ["encapsulation", "encapsulate", "hide", "internal", "tell"],
  },
  {
    name: "Law of Demeter",
    priority: "P2",
    description:
      "Only talk to immediate friends. a.getB().getC().doThing() is a violation. Delegate through intermediate objects. Exception: fluent APIs and data transfer objects.",
    focusKeywords: ["demeter", "chain", "coupling", "delegation"],
  },
  {
    name: "SRP (Single Responsibility)",
    priority: "P2",
    description:
      "SOLID: A class should have one reason to change. Split only when responsibilities have different change rates. Scattering related logic is worse than a slightly large class.",
    focusKeywords: ["srp", "responsibility", "solid", "class"],
  },
  {
    name: "Open/Closed",
    priority: "P2",
    description:
      "SOLID: Open for extension, closed for modification. Add behavior through new code, not by changing existing code.",
    focusKeywords: ["open", "closed", "extension", "solid"],
  },
  {
    name: "Liskov Substitution",
    priority: "P2",
    description:
      "SOLID: Subtypes must be substitutable for their base types without breaking program correctness. Overrides must honor the base contract.",
    focusKeywords: ["liskov", "substitution", "subtype", "solid", "inheritance"],
  },
  {
    name: "Interface Segregation",
    priority: "P2",
    description:
      "SOLID: Prefer small, specific interfaces over large, general ones. Clients should not depend on methods they don't use.",
    focusKeywords: ["interface", "segregation", "solid", "small"],
  },
  {
    name: "Dependency Inversion",
    priority: "P2",
    description:
      "SOLID: Depend on abstractions, not concretions. High-level modules should not depend on low-level modules; both depend on interfaces.",
    focusKeywords: ["dependency", "inversion", "solid", "abstraction"],
  },
  {
    name: "Composition Over Inheritance",
    priority: "P2",
    description:
      "Compose objects via has-a relationships instead of extending via is-a. Inheritance creates tight coupling and fragile base class problems.",
    focusKeywords: ["composition", "inheritance", "coupling", "compose"],
  },
  {
    name: "Immutability",
    priority: "P2",
    description:
      "Prefer immutable data structures. Mutation is a source of bugs, especially with shared state. Copy-on-write when modification is needed.",
    focusKeywords: ["immutability", "mutable", "mutation", "copy", "const"],
  },
  {
    name: "Idempotency",
    priority: "P2",
    description:
      "Multiple executions produce the same result as one. Critical for retry logic, event handlers, and API endpoints.",
    focusKeywords: ["idempotent", "idempotency", "retry", "repeat"],
  },
  {
    name: "Resilience",
    priority: "P2",
    description:
      "Continue operating despite partial failures. Patterns: exponential backoff with jitter, circuit breakers, graceful degradation, bulkheads.",
    focusKeywords: ["resilience", "retry", "backoff", "circuit", "breaker"],
  },

  // P3 — Low: Polish
  {
    name: "Self-Documenting Code",
    priority: "P3",
    description:
      "Names reveal purpose. Code tells how, comments tell why. Three pillars: intention-revealing names, explanatory variables, meaningful constants.",
    focusKeywords: ["naming", "self-documenting", "readability", "comments"],
  },
  {
    name: "Command-Query Separation",
    priority: "P3",
    description:
      "Functions either return a value (query) OR change state (command), not both. Exception: stack.pop(), iterator.next() where combining is the natural interface.",
    focusKeywords: ["command", "query", "separation", "side-effect"],
  },
  {
    name: "Boy Scout Rule",
    priority: "P3",
    description:
      "Leave code better than you found it. Small, incremental improvements compound over time. NOT: rewrite everything you touch. Just: fix one thing nearby.",
    focusKeywords: ["boy-scout", "cleanup", "improve", "incremental"],
  },

  // P4 — Optional: Style
  {
    name: "Elegance",
    priority: "P4",
    description:
      "Beauty through insight and minimality. Elegant code feels inevitable, not clever. Four criteria: minimal, clear, general, natural. If you need to explain it, it's clever, not elegant.",
    focusKeywords: ["elegance", "elegant", "style", "beauty"],
  },
  {
    name: "Comment Discipline",
    priority: "P4",
    description:
      "Delete comments that restate code. Keep comments that explain WHY, warn of consequences, or mark TODOs with context. Comment balance is key.",
    focusKeywords: ["comment", "discipline", "documentation", "style"],
  },
  {
    name: "Formatting Consistency",
    priority: "P4",
    description:
      "Consistent formatting reduces cognitive load. Follow project conventions. Don't introduce formatting drift. Style nits not codified in CLAUDE.md are out of scope.",
    focusKeywords: ["formatting", "style", "consistency", "spacing"],
  },
];

// ── Domain Supplemental Principles ───────────────────────────────────────────

const DOMAIN_PRINCIPLES: Record<string, Principle[]> = {
  api: [
    {
      name: "API Versioning",
      priority: "P1",
      domain: "api",
      description:
        "API endpoints should be versioned. Breaking changes require a new version. Never silently change the response shape or status codes.",
      focusKeywords: ["versioning", "api", "breaking", "compatibility"],
    },
    {
      name: "Rate Limiting",
      priority: "P1",
      domain: "api",
      description:
        "Public API endpoints must enforce rate limits. Without rate limiting, a single client can exhaust resources for all users.",
      focusKeywords: ["rate", "limit", "throttle", "api"],
    },
    {
      name: "Consistent Error Responses",
      priority: "P2",
      domain: "api",
      description:
        "API error responses should use a consistent shape (error code, message, details). Inconsistent error formats break client error handling.",
      focusKeywords: ["error", "response", "api", "consistent"],
    },
  ],
  ui: [
    {
      name: "Accessibility (a11y)",
      priority: "P1",
      domain: "ui",
      description:
        "UI components must be accessible. Semantic HTML, ARIA labels, keyboard navigation, color contrast. Inaccessible UI excludes users.",
      focusKeywords: ["accessibility", "a11y", "aria", "keyboard"],
    },
    {
      name: "Responsive Layout",
      priority: "P2",
      domain: "ui",
      description:
        "Layouts should adapt to viewport size. Use responsive units (rem, %, fr) not fixed pixels. Test at common breakpoints.",
      focusKeywords: ["responsive", "layout", "viewport", "breakpoint"],
    },
    {
      name: "Visual Hierarchy",
      priority: "P4",
      domain: "ui",
      description:
        "Use size, weight, and spacing to guide the user's attention. Important elements should be visually prominent. This is a design-safe principle.",
      focusKeywords: ["visual", "hierarchy", "design", "layout", "spacing"],
    },
  ],
  testing: [
    {
      name: "Test Isolation",
      priority: "P1",
      domain: "testing",
      description:
        "Each test must be independent. No test should depend on the side effects or execution order of another. Shared mutable state between tests is a defect.",
      focusKeywords: ["isolation", "test", "independent", "order"],
    },
    {
      name: "AAA Pattern",
      priority: "P2",
      domain: "testing",
      description:
        "Tests should follow Arrange-Act-Assert. Clear separation of setup, action, and verification improves readability and maintainability.",
      focusKeywords: ["aaa", "arrange", "act", "assert", "test"],
    },
  ],
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load the base principles catalog (30+ principles across P0-P4).
 */
export function loadBasePrinciples(): Principle[] {
  return [...BASE_PRINCIPLES];
}

/**
 * Load supplemental domain principles. Returns an empty array for unknown
 * domains so the caller can fail-closed explicitly.
 */
export function loadDomainPrinciples(domain: string): Principle[] {
  const principles = DOMAIN_PRINCIPLES[domain];
  return principles ? [...principles] : [];
}

/**
 * List available domain names.
 */
export function availableDomains(): string[] {
  return Object.keys(DOMAIN_PRINCIPLES);
}

/**
 * Check if a domain name is known.
 */
export function isKnownDomain(domain: string): boolean {
  return domain in DOMAIN_PRINCIPLES;
}

/**
 * Merge base + domain principles into a single catalog.
 */
export function loadCatalog(domain?: string): Principle[] {
  const base = loadBasePrinciples();
  if (!domain) return base;
  const supplemental = loadDomainPrinciples(domain);
  return [...base, ...supplemental];
}

/**
 * Apply a --focus directive: principles whose focusKeywords match the focus
 * text are elevated by one priority level (P4 → P3, P3 → P2, etc., capped at
 * P0). Returns a new catalog with updated priorities.
 */
export function applyFocus(catalog: Principle[], focus: string): Principle[] {
  if (!focus || focus.trim() === "") return [...catalog];
  const focusLower = focus.toLowerCase();
  const focusWords = focusLower.split(/\s+/).filter((w) => w.length > 0);

  return catalog.map((p) => {
    const keywords = p.focusKeywords ?? [];
    const matches = focusWords.some(
      (w) => keywords.some((k) => k.includes(w) || w.includes(k)),
    );
    if (!matches) return p;
    // Elevate by one level (P4→P3→P2→P1→P0, cap at P0)
    const elevated = elevatePriority(p.priority);
    return { ...p, priority: elevated };
  });
}

function elevatePriority(p: PriorityBucket): PriorityBucket {
  switch (p) {
    case "P4": return "P3";
    case "P3": return "P2";
    case "P2": return "P1";
    case "P1": return "P0";
    default: return "P0";
  }
}

/**
 * Group principles by priority bucket. Returns a map of P0..P4 → Principle[].
 */
export function groupByPriority(catalog: Principle[]): Record<PriorityBucket, Principle[]> {
  const groups: Record<PriorityBucket, Principle[]> = {
    P0: [],
    P1: [],
    P2: [],
    P3: [],
    P4: [],
  };
  for (const p of catalog) {
    groups[p.priority].push(p);
  }
  return groups;
}

/**
 * Check that the catalog satisfies the 30+ principles invariant:
 * - At least 30 principles
 * - All 5 priority buckets (P0-P4) are non-empty
 * - Named principles are present: KISS, YAGNI, DRY, SOLID (SRP), Guard Clauses,
 *   Fail-Fast, Encapsulation, Cognitive Load
 */
export function validateCatalog(catalog: Principle[]): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  if (catalog.length < 30) {
    issues.push(`catalog has ${catalog.length} principles, need >= 30`);
  }
  const groups = groupByPriority(catalog);
  for (const bucket of ["P0", "P1", "P2", "P3", "P4"] as PriorityBucket[]) {
    if (groups[bucket].length === 0) {
      issues.push(`bucket ${bucket} is empty`);
    }
  }
  const names = new Set(catalog.map((p) => p.name));
  const required = ["KISS", "YAGNI", "DRY", "Guard Clauses", "Fail-Fast", "Encapsulation", "Cognitive Load"];
  for (const req of required) {
    if (!names.has(req) && !hasPrincipleLike(catalog, req)) {
      issues.push(`missing required principle: ${req}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

function hasPrincipleLike(catalog: Principle[], name: string): boolean {
  const lower = name.toLowerCase();
  return catalog.some((p) => p.name.toLowerCase().includes(lower));
}

/**
 * Render the principles catalog as a markdown reference text for inclusion in
 * the worker/judge prompt. Each principle is listed with its priority and
 * description.
 */
export function renderPrinciplesMarkdown(catalog: Principle[]): string {
  const groups = groupByPriority(catalog);
  const lines: string[] = ["# Szechuan Sauce Principles Reference", ""];
  const bucketLabels: Record<PriorityBucket, string> = {
    P0: "Critical (Security, Data Loss)",
    P1: "High (Bugs Waiting to Happen)",
    P2: "Medium (Maintainability)",
    P3: "Low (Polish)",
    P4: "Optional (Style)",
  };
  for (const bucket of ["P0", "P1", "P2", "P3", "P4"] as PriorityBucket[]) {
    lines.push(`## ${bucket}: ${bucketLabels[bucket]}`, "");
    for (const p of groups[bucket]) {
      const domainTag = p.domain ? ` [domain: ${p.domain}]` : "";
      lines.push(`### ${p.name}${domainTag}`);
      lines.push(`**Priority**: ${p.priority}`);
      lines.push(`**Description**: ${p.description}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
