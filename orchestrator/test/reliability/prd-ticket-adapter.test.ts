import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  TicketContractError,
  canonicalJson,
  ticketContractDigest,
} from "../../src/contracts/ticket-contract.js";
import { runBuild } from "../../src/lifecycle/build.js";
import { ticketPrompt } from "../../src/lifecycle/build.js";
import {
  adaptPrdMarkdownToTicketContracts,
  parseExecutablePrdMarkdown,
} from "../../src/lifecycle/prd-parse.js";

const temporaryRoots: string[] = [];

function expectCode(action: () => unknown, code: string): void {
  let observed: unknown;
  try {
    action();
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(TicketContractError);
  expect((observed as TicketContractError).code).toBe(code);
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function createRepository(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "rickgent-prd-adapter-"));
  temporaryRoots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return { root, repo };
}

function verification(id: string, path: string): string {
  return JSON.stringify([{
    id,
    executable: "test",
    args: ["-f", path],
    cwd_class: "repository_root",
    env_allowlist: ["PATH"],
    timeout_ms: 30_000,
    network: "deny",
    writable_outputs: [],
    expected_exit_codes: [0],
  }]);
}

function strictPrd(extraDescription = ""): string {
  return `# Strict fixture

## Title: Strict adapter fixture

## Description
Exercise complete TicketContract admission.
${extraDescription}

## Acceptance Criteria

### AC-FILE-01: first file exists
- **interfaceIds:** \`["INTERFACE-FIRST"]\`
- **verifications:** \`${verification("VERIFY-FIRST-01", "src/first.ts")}\`
- **scope:** \`src/first.ts\`
- **type:** test

### AC-FILE-02: second file exists
- **interfaceIds:** \`["INTERFACE-SECOND"]\`
- **verifications:** \`${verification("VERIFY-SECOND-01", "src/second.ts")}\`
- **scope:** \`src/second.ts\`
- **type:** test

## Simplification Review
- Reviewed: yes
- Notes: two explicit files

## Tickets

### Ticket 01: create first file
- **description:** Create the first file
- **dependsOn:** \`[]\`
- **scope:** \`[{"path":"src/first.ts","change_kind":"create","directory":false}]\`
- **interfaces:** \`[{"id":"INTERFACE-FIRST","direction":"provides","path":"src/first.ts","owner":"t01","description":"First file export"}]\`
- **acceptanceCriteria:** \`["AC-FILE-01"]\`
- **budgets:** \`{"max_attempts":2,"max_review_cycles":1,"wall_clock_ms":900000,"remediation_limit":1}\`

### Ticket 02: create second file
- **description:** Create the second file
- **dependsOn:** \`["t01"]\`
- **scope:** \`[{"path":"src/second.ts","change_kind":"create","directory":false}]\`
- **interfaces:** \`[{"id":"INTERFACE-FIRST","direction":"consumes","path":"src/first.ts","owner":"t01","description":"First file dependency"},{"id":"INTERFACE-SECOND","direction":"provides","path":"src/second.ts","owner":"t02","description":"Second file export"}]\`
- **acceptanceCriteria:** \`["AC-FILE-02"]\`
- **budgets:** \`{"max_attempts":3,"max_review_cycles":2,"wall_clock_ms":1200000,"remediation_limit":2}\`
`;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("strict PRD TicketContract adapter", () => {
  it("retains ticket-local ACs, interfaces, dependencies, scopes, verification specs, budgets, and digests", () => {
    const { root, repo } = createRepository();
    const parsed = parseExecutablePrdMarkdown(strictPrd(), {
      repositoryRoot: repo,
      stateRoots: [join(root, ".rickgent")],
    });

    expect(parsed.contracts.map((contract) => contract.id)).toEqual(["t01", "t02"]);
    const [first, second] = parsed.contracts;
    expect(first?.acceptance_criteria.map((criterion) => criterion.id)).toEqual(["AC-FILE-01"]);
    expect(second?.acceptance_criteria.map((criterion) => criterion.id)).toEqual(["AC-FILE-02"]);
    expect(second?.depends_on).toEqual(["t01"]);
    expect(second?.scope).toEqual([{ path: "src/second.ts", change_kind: "create", directory: false }]);
    expect(second?.interfaces.map((entry) => entry.id)).toEqual(["INTERFACE-FIRST", "INTERFACE-SECOND"]);
    expect(second?.verifications[0]?.args).toEqual(["-f", "src/second.ts"]);
    expect(second?.budgets).toEqual({
      max_attempts: 3,
      max_review_cycles: 2,
      wall_clock_ms: 1_200_000,
      remediation_limit: 2,
    });
    expect(second?.digest).toBe(ticketContractDigest(second!));
    expect(parsed.prd.acceptanceCriteria).toHaveLength(2);
  });

  it("renders the complete normalized contract, including digest, into the worker prompt", () => {
    const [contract] = adaptPrdMarkdownToTicketContracts(strictPrd());
    const prompt = ticketPrompt(contract!);
    expect(prompt).toContain(canonicalJson(contract));
    expect(prompt).toContain(contract!.digest);
    expect(prompt).toContain('"acceptance_criteria"');
    expect(prompt).toContain('"verifications"');
    expect(prompt).toContain('"budgets"');
  });

  it("rejects duplicate and unknown acceptance-criterion references", () => {
    const duplicateHeading = `### AC-FILE-01: duplicate first criterion
- **interfaceIds:** \`["INTERFACE-FIRST"]\`
- **verifications:** \`${verification("VERIFY-DUPLICATE-01", "src/first.ts")}\`
- **scope:** \`src/first.ts\`
- **type:** test

`;
    const duplicate = strictPrd().replace("## Simplification Review", `${duplicateHeading}## Simplification Review`);
    expectCode(() => adaptPrdMarkdownToTicketContracts(duplicate), "TICKET_ID_DUPLICATE");

    const unknown = strictPrd().replace('["AC-FILE-01"]', '["AC-MISSING-01"]');
    expectCode(() => adaptPrdMarkdownToTicketContracts(unknown), "TICKET_AC_REFERENCE_UNKNOWN");

    const repeatedReference = strictPrd().replace('["AC-FILE-01"]', '["AC-FILE-01","AC-FILE-01"]');
    expectCode(() => adaptPrdMarkdownToTicketContracts(repeatedReference), "TICKET_ID_DUPLICATE");
  });

  it("requires explicit ticket IDs and rejects duplicate strict keys", () => {
    const inferred = strictPrd().replace("### Ticket 01:", "### Ticket one:");
    expectCode(() => adaptPrdMarkdownToTicketContracts(inferred), "TICKET_ID_INVALID");

    const duplicateKey = strictPrd().replace(
      "- **budgets:** `",
      "- **budgets:** `{\"max_attempts\":2,\"max_review_cycles\":1,\"wall_clock_ms\":900000,\"remediation_limit\":1}`\n- **budgets:** `",
    );
    expectCode(() => adaptPrdMarkdownToTicketContracts(duplicateKey), "TICKET_MARKDOWN_DUPLICATE_KEY");
  });

  it("ignores ticket and AC headings inside fenced Markdown examples", () => {
    const fenced = `~~~markdown
### AC-FAKE-99: not executable
- **verifyCommand:** \`false\`
### Ticket 99: not executable
- **declaredPaths:** \`/tmp/escape\`
~~~`;
    const contracts = adaptPrdMarkdownToTicketContracts(strictPrd(fenced));
    expect(contracts.map((contract) => contract.id)).toEqual(["t01", "t02"]);

    const fencedTicketBullet = strictPrd().replace(
      "- **budgets:** `",
      "```markdown\n- **budgets:** `not executable`\n```\n- **budgets:** `",
    );
    expect(adaptPrdMarkdownToTicketContracts(fencedTicketBullet)).toHaveLength(2);
  });

  it("rejects raw verifyCommand and bare declaredPaths on the executable path", () => {
    const rawVerification = strictPrd().replace(
      /- \*\*verifications:\*\* `[^\n]+`/,
      "- **verifyCommand:** `test -f src/first.ts`",
    );
    expectCode(
      () => adaptPrdMarkdownToTicketContracts(rawVerification),
      "TICKET_VERIFICATION_LEGACY_FORBIDDEN",
    );

    const barePaths = strictPrd().replace(
      '- **scope:** `[{"path":"src/first.ts","change_kind":"create","directory":false}]`',
      "- **declaredPaths:** `src/first.ts`",
    );
    expectCode(
      () => adaptPrdMarkdownToTicketContracts(barePaths),
      "TICKET_SCOPE_LEGACY_FORBIDDEN",
    );
  });

  it("fails invalid Markdown before state allocation, gate setup, or dispatch", async () => {
    const { root, repo } = createRepository();
    const prdPath = join(root, "invalid.md");
    const rickgentDir = join(root, ".rickgent");
    writeFileSync(
      prdPath,
      strictPrd().replace(/- \*\*verifications:\*\* `[^\n]+`/, "- **verifyCommand:** `false`"),
    );
    let postAdmissionGateCalled = false;
    const result = await runBuild(
      {
        prdPath,
        workingDir: repo,
        rickgentDir,
        agentDir: join(root, "agent"),
        dataDir: join(root, "data"),
        env: { PATH: process.env.PATH },
      },
      {
        capabilityGate: { require(): void {} },
        assertEnvironment(): void {},
        verifyPolicyAttachment() {
          postAdmissionGateCalled = true;
          return { ok: true, detail: "unexpected", managerCount: 1, workerCount: 1 };
        },
      },
    );

    expect(result.outcome.status).toBe("failed");
    expect(result.outcome.primary).toBe("input_contract");
    expect(result.gateHit).toBe("ticket-contract-gate");
    expect(result.ticketsDispatched).toBe(0);
    expect(postAdmissionGateCalled).toBe(false);
    expect(existsSync(rickgentDir)).toBe(false);
    expect(existsSync(join(rickgentDir, "runs.jsonl"))).toBe(false);
    expect(existsSync(join(rickgentDir, "registry.json"))).toBe(false);
    expect(existsSync(join(rickgentDir, "dispatch-ledger.jsonl"))).toBe(false);
  });
});
