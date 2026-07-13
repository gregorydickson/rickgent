#!/usr/bin/env node
// Legacy reference runner — maps conformance fixtures to their legacy TS source citations.
// AC-16: differential testing against pickle-rick-claude's TS implementation.
// The legacy code requires the pickle-rick extension runtime; this script
// documents the fixture-to-source mapping for manual differential verification.

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixturesDir = join(__dirname, "..", "..", "conformance", "fixtures");
const outputFile = join(__dirname, "..", "..", "legacy-verdicts.json");

const fixtures = {};
for (const file of readdirSync(fixturesDir).filter(f => f.endsWith(".json"))) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf-8"));
  fixtures[fixture.id] = {
    check: fixture.check,
    source: fixture.source,
    expected: fixture.expected,
  };
}

writeFileSync(outputFile, JSON.stringify(fixtures, null, 2));
console.log(`Legacy reference mapping written to ${outputFile}`);
console.log(`${Object.keys(fixtures).length} fixtures mapped to source citations.`);
