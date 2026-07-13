// PRD validation — machine-checkable ACs and simplification review.

export interface AcceptanceCriterion {
  description: string;
  type: "test" | "lint" | "grep";
  verifyCommand: string;
  scope: string[];
}

export interface SimplificationReview {
  reviewed: boolean;
  notes: string;
}

export interface PrdInput {
  title: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  simplificationReview: SimplificationReview | null;
}

export interface PrdVerdict {
  valid: boolean;
  errors: string[];
}

export function evaluatePrd(input: PrdInput): PrdVerdict {
  // AC-16: Fail closed on malformed input
  if (input == null || typeof input !== "object") {
    return { valid: false, errors: ["invalid input"] };
  }

  const errors: string[] = [];
  const acceptanceCriteria = Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : [];

  // Must have at least one acceptance criterion
  if (acceptanceCriteria.length === 0) {
    errors.push("PRD must have at least one acceptance criterion");
  }

  // Every AC must have a non-empty verify command
  for (const ac of acceptanceCriteria) {
    // C4: guard against malformed acceptance-criterion elements. If an element
    // is not an object (e.g. a string, number, null) or is missing required
    // fields, record an error instead of crashing on property access.
    if (ac == null || typeof ac !== "object") {
      errors.push("acceptance criterion is not an object");
      continue;
    }
    const desc = typeof ac.description === "string" ? ac.description : "(unknown)";
    const verifyCommand = typeof ac.verifyCommand === "string" ? ac.verifyCommand : "";
    const scope = Array.isArray(ac.scope) ? ac.scope : [];

    if (verifyCommand.trim().length === 0) {
      errors.push(`AC "${desc}" has empty verify command`);
    }
    // AC must have non-empty scope
    if (scope.length === 0) {
      errors.push(`AC "${desc}" has empty scope`);
    }
    // Reject interactive commands
    if (/\bread\s+-p\b/.test(verifyCommand)) {
      errors.push(`AC "${desc}" has interactive command (read -p)`);
    }
    // Reject network commands: a real network invocation, meaning curl/wget in
    // command position (start of string or after a shell separator) or an
    // explicit http(s):// URL — not an incidental "http" substring inside a
    // filename such as vitest's http.test.ts or pytest's test_http.py.
    if (/(?:^|[\n;&|])\s*(?:curl|wget)\b|https?:\/\//.test(verifyCommand)) {
      errors.push(`AC "${desc}" has network command`);
    }
  }

  // Must have simplification review
  if (!input.simplificationReview || !input.simplificationReview.reviewed) {
    errors.push("PRD must have a simplification review (subtract before you add)");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
