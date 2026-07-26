export const REQUIRED_QUALITY_GATES = Object.freeze([
  "ts_lint",
  "typecheck",
  "build",
  "ts_test_coverage",
  "concurrency_corpus_50",
  "mutation_manifest",
  "ruff_lint",
  "mypy_typecheck",
  "py_test_coverage",
  "coverage_manifest_verify",
  "release_manifest",
  "package_inventory",
]);

const REQUIRED_GATE_SET = new Set(REQUIRED_QUALITY_GATES);

export function validateRequiredQualityGates(gates) {
  const errors = [];
  if (!Array.isArray(gates)) {
    return ["gates is not an array"];
  }

  const counts = new Map();
  for (const [index, gate] of gates.entries()) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      errors.push(`gate at index ${index} is malformed`);
      continue;
    }
    if (typeof gate.name !== "string" || gate.name.length === 0) {
      errors.push(`gate at index ${index} has no valid name`);
      continue;
    }
    counts.set(gate.name, (counts.get(gate.name) ?? 0) + 1);
    if (!REQUIRED_GATE_SET.has(gate.name)) {
      errors.push(`unknown quality gate: ${gate.name}`);
    }
    if (gate.status !== "pass") {
      errors.push(`required quality gate did not pass: ${gate.name}`);
    }
    if (typeof gate.detail !== "string" || gate.detail.length === 0) {
      errors.push(`required quality gate has malformed detail: ${gate.name}`);
    }
  }

  for (const name of REQUIRED_QUALITY_GATES) {
    const count = counts.get(name) ?? 0;
    if (count === 0) errors.push(`required quality gate is missing: ${name}`);
    if (count > 1) errors.push(`required quality gate is duplicated: ${name}`);
  }
  if (gates.length !== REQUIRED_QUALITY_GATES.length) {
    errors.push(
      `quality gate cardinality is ${gates.length}, expected ${REQUIRED_QUALITY_GATES.length}`,
    );
  }

  const concurrency = gates.find((gate) => gate?.name === "concurrency_corpus_50");
  if (concurrency) {
    const required = concurrency.required_iterations;
    const total = concurrency.total_tests;
    const passed = concurrency.passed_tests;
    const failed = concurrency.failed_tests;
    const skipped = concurrency.skipped_tests;
    if (!Number.isInteger(required) || required < 50) {
      errors.push("concurrency_corpus_50 requires at least 50 iterations");
    }
    if (!Number.isInteger(total) || total < required) {
      errors.push("concurrency_corpus_50 has an incomplete test total");
    }
    if (!Number.isInteger(passed) || passed !== total) {
      errors.push("concurrency_corpus_50 did not pass every retained test");
    }
    if (failed !== 0) {
      errors.push("concurrency_corpus_50 retained failed tests");
    }
    if (skipped !== 0) {
      errors.push("concurrency_corpus_50 retained skipped tests");
    }
  }

  return errors;
}
