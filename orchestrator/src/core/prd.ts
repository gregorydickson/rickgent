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
    if (!ac.verifyCommand || ac.verifyCommand.trim().length === 0) {
      errors.push(`AC "${ac.description}" has empty verify command`);
    }
    // AC must have non-empty scope
    if (ac.scope.length === 0) {
      errors.push(`AC "${ac.description}" has empty scope`);
    }
    // Reject interactive commands
    if (/\bread\s+-p\b/.test(ac.verifyCommand)) {
      errors.push(`AC "${ac.description}" has interactive command (read -p)`);
    }
    // Reject network commands
    if (/\bcurl\b|\bwget\b|\bhttp\b/.test(ac.verifyCommand)) {
      errors.push(`AC "${ac.description}" has network command`);
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
