/**
 * t25: Full ticket-contract propagation through every phase.
 *
 * Replaces lossy `ticketPrompt` construction with role-specific renderers
 * that carry acceptance criteria, interfaces, scope, dependencies, contract
 * digest, and budgets through every prompt and receipt without lossy
 * reconstruction.  A lossy reconstruction (missing field, mutated digest) is
 * rejected fail-closed.
 *
 * Red-then-green: this file is authored BEFORE `orchestrator/src/lifecycle/prompts.ts`
 * exists, so the imports fail (red).  After implementation every assertion
 * passes (green).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  sealTicketContracts,
  type TicketContract,
  type TicketContractDraft,
} from "../../src/contracts/ticket-contract.js";
import {
  PROMPT_RECEIPT_SCHEMA_VERSION,
  REQUIRED_CONTRACT_FIELDS,
  renderImplementationPrompt,
  renderReviewPrompt,
  renderRemediationPrompt,
  renderVerificationPrompt,
  renderConvergencePrompt,
  verifyPromptReceipt,
  type PromptReceipt,
  type StructuredFinding,
  PromptReceiptMismatchError,
} from "../../src/lifecycle/prompts.js";
import { runContractConformanceGate } from "../../src/lifecycle/citadel.js";
import { ticketPrompt } from "../../src/lifecycle/build.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scratchRoots = new Set<string>();

afterEach(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-contract-prop-")));
  scratchRoots.add(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Contract Propagation Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "contract-prop@example.test"]);
  writeFileSync(join(repo, "README.md"), "contract propagation\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  return realpathSync(repo);
}

function repoHead(repo: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function ticketDraft(): TicketContractDraft {
  return {
    schema_version: "1.0.0",
    id: "t25",
    title: "Full ticket-contract propagation",
    description: "Carry every contract field through every prompt and receipt.",
    depends_on: ["t24"],
    scope: [
      { path: "orchestrator/src/lifecycle/prompts.ts", change_kind: "create", directory: false },
      { path: "orchestrator/test/reliability/contract-propagation.test.ts", change_kind: "create", directory: false },
    ],
    interfaces: [
      {
        id: "INTERFACE-PROMPT-RECEIPT",
        direction: "provides",
        path: "orchestrator/src/lifecycle/prompts.ts",
        owner: "lifecycle prompt authority",
        description: "Role-specific prompt renderers that carry the full normalized contract.",
      },
    ],
    acceptance_criteria: [
      {
        id: "AC-PROP-01",
        description: "Every renderer carries every contract field without loss.",
        interface_ids: ["INTERFACE-PROMPT-RECEIPT"],
        verification_ids: ["VERIFY-PROP-FIXTURES"],
      },
      {
        id: "AC-PROP-02",
        description: "A lossy reconstruction (missing field, mutated digest) is rejected.",
        interface_ids: ["INTERFACE-PROMPT-RECEIPT"],
        verification_ids: ["VERIFY-PROP-FIXTURES"],
      },
    ],
    verifications: [
      {
        id: "VERIFY-PROP-FIXTURES",
        executable: "node",
        args: ["--version"],
        cwd_class: "repository_root",
        env_allowlist: ["PATH"],
        timeout_ms: 30_000,
        network: "deny",
        writable_outputs: [],
        expected_exit_codes: [0],
      },
    ],
    budgets: {
      max_attempts: 2,
      max_review_cycles: 2,
      wall_clock_ms: 120_000,
      remediation_limit: 1,
    },
  };
}

function ticketContract(repo: string): TicketContract {
  return sealTicketContracts([ticketDraft()], { repositoryRoot: repo, knownExternalDependencyIds: ["t24"] })[0]!;
}

function digest(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

const CONTEXT_DIGEST = digest("rickgent.context.test.v1");
const ALT_CONTEXT_DIGEST = digest("rickgent.context.alt.v1");

const FINDINGS: readonly StructuredFinding[] = [
  { id: "F-01", severity: "high", message: "missing negative proof", path: "src/lifecycle/prompts.ts" },
  { id: "F-02", severity: "medium", message: "deterministic ordering drift", path: "src/lifecycle/prompts.ts" },
];

// ---------------------------------------------------------------------------
// 1. Renderer receipts carry the full normalized contract (AC-PROP-01)
// ---------------------------------------------------------------------------

describe("role-specific renderers carry the full normalized contract", () => {
  it("exports the prompt-receipt schema version and required-field catalog", () => {
    expect(PROMPT_RECEIPT_SCHEMA_VERSION).toMatch(/^rickgent\.prompt-receipt\.v\d+$/);
    // Every renderer must include ALL of these contract fields.
    expect(REQUIRED_CONTRACT_FIELDS).toContain("id");
    expect(REQUIRED_CONTRACT_FIELDS).toContain("title");
    expect(REQUIRED_CONTRACT_FIELDS).toContain("description");
    expect(REQUIRED_CONTRACT_FIELDS).toContain("depends_on");
    expect(REQUIRED_CONTRACT_FIELDS).toContain("scope");
    expect(REQUIRED_CONTRACT_FIELDS).toContain("interfaces");
    expect(REQUIRED_CONTRACT_FIELDS).toContain("acceptance_criteria");
    expect(REQUIRED_CONTRACT_FIELDS).toContain("verifications");
    expect(REQUIRED_CONTRACT_FIELDS).toContain("budgets");
    expect(REQUIRED_CONTRACT_FIELDS).toContain("digest");
  });

  it("renderImplementationPrompt carries every contract field and the contract digest", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const receipt = renderImplementationPrompt(contract, {
      phase: "implement",
      role: "worker",
      contextDigest: CONTEXT_DIGEST,
      contractDigest: contract.digest,
    });
    expect(receipt.schema_version).toBe(PROMPT_RECEIPT_SCHEMA_VERSION);
    expect(receipt.phase).toBe("implement");
    expect(receipt.role).toBe("worker");
    expect(receipt.contract_digest).toBe(contract.digest);
    expect(receipt.context_digest).toBe(CONTEXT_DIGEST);
    // The prompt text must contain every required contract field.
    for (const field of REQUIRED_CONTRACT_FIELDS) {
      expect(receipt.prompt_text).toContain(`"${field}"`);
    }
    // ACs and structured verification definitions appear by their typed ids.
    expect(receipt.prompt_text).toContain("AC-PROP-01");
    expect(receipt.prompt_text).toContain("AC-PROP-02");
    expect(receipt.prompt_text).toContain("VERIFY-PROP-FIXTURES");
    // Normalized scope/change kinds appear.
    expect(receipt.prompt_text).toContain("create");
    expect(receipt.prompt_text).toContain("orchestrator/src/lifecycle/prompts.ts");
    // Interface/ownership assertions appear.
    expect(receipt.prompt_text).toContain("INTERFACE-PROMPT-RECEIPT");
    // Dependencies appear.
    expect(receipt.prompt_text).toContain("t24");
    // Budgets appear.
    expect(receipt.prompt_text).toContain("max_attempts");
    // The contract digest is carried.
    expect(receipt.prompt_text).toContain(contract.digest);
    // The receipt is content-hashed.
    expect(receipt.prompt_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The rendered_fields audit trail lists every required contract field.
    for (const field of REQUIRED_CONTRACT_FIELDS) {
      expect(receipt.rendered_fields).toContain(field);
    }
  });

  it("renderReviewPrompt carries the full contract plus immutable baseline/candidate/diff identity (no transcript)", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const baseline = repoHead(repo);
    const candidate = digest("candidate-tree-v1").slice("sha256:".length);
    const diffDigest = digest("diff-v1");
    const receipt = renderReviewPrompt(contract, {
      phase: "review",
      role: "reviewer",
      contextDigest: CONTEXT_DIGEST,
      contractDigest: contract.digest,
    }, { baselineOid: baseline, candidateOid: candidate, diffDigest });
    expect(receipt.phase).toBe("review");
    expect(receipt.role).toBe("reviewer");
    expect(receipt.contract_digest).toBe(contract.digest);
    expect(receipt.context_digest).toBe(CONTEXT_DIGEST);
    expect(receipt.baseline_oid).toBe(baseline);
    expect(receipt.candidate_oid).toBe(candidate);
    expect(receipt.diff_digest).toBe(diffDigest);
    for (const field of REQUIRED_CONTRACT_FIELDS) {
      expect(receipt.prompt_text).toContain(`"${field}"`);
    }
    // Review receives immutable baseline/final-tree/diff identity.
    expect(receipt.prompt_text).toContain(baseline);
    expect(receipt.prompt_text).toContain(candidate);
    expect(receipt.prompt_text).toContain(diffDigest);
    // Review cannot trust implementation transcript claims: the prompt text
    // does not contain a "transcript" or "worker_said" field.
    expect(receipt.prompt_text).not.toContain('"transcript"');
    expect(receipt.prompt_text).not.toContain("worker_said");
  });

  it("renderRemediationPrompt carries the full contract plus structured findings only (no transcript)", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const receipt = renderRemediationPrompt(contract, {
      phase: "remediate",
      role: "remediator",
      contextDigest: CONTEXT_DIGEST,
      contractDigest: contract.digest,
    }, FINDINGS);
    expect(receipt.phase).toBe("remediate");
    expect(receipt.role).toBe("remediator");
    expect(receipt.contract_digest).toBe(contract.digest);
    for (const field of REQUIRED_CONTRACT_FIELDS) {
      expect(receipt.prompt_text).toContain(`"${field}"`);
    }
    // Remediation receives structured findings only.
    expect(receipt.prompt_text).toContain("F-01");
    expect(receipt.prompt_text).toContain("F-02");
    expect(receipt.prompt_text).toContain("missing negative proof");
    // Remediation does NOT receive the implementation transcript.
    expect(receipt.prompt_text).not.toContain('"transcript"');
    expect(receipt.findings).toEqual(FINDINGS);
  });

  it("renderVerificationPrompt carries the full contract and the structured verification specs to run", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const receipt = renderVerificationPrompt(contract, {
      phase: "verify",
      role: "verifier",
      contextDigest: CONTEXT_DIGEST,
      contractDigest: contract.digest,
    });
    expect(receipt.phase).toBe("verify");
    expect(receipt.role).toBe("verifier");
    expect(receipt.contract_digest).toBe(contract.digest);
    for (const field of REQUIRED_CONTRACT_FIELDS) {
      expect(receipt.prompt_text).toContain(`"${field}"`);
    }
    // The structured verification argv spec is carried.
    expect(receipt.prompt_text).toContain("VERIFY-PROP-FIXTURES");
    expect(receipt.prompt_text).toContain('"executable"');
    expect(receipt.prompt_text).toContain('"expected_exit_codes"');
    expect(receipt.prompt_text).toContain('"writable_outputs"');
  });

  it("renderConvergencePrompt carries the full contract and convergence target", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const receipt = renderConvergencePrompt(contract, {
      phase: "converge",
      role: "converger",
      contextDigest: CONTEXT_DIGEST,
      contractDigest: contract.digest,
    });
    expect(receipt.phase).toBe("converge");
    expect(receipt.role).toBe("converger");
    expect(receipt.contract_digest).toBe(contract.digest);
    for (const field of REQUIRED_CONTRACT_FIELDS) {
      expect(receipt.prompt_text).toContain(`"${field}"`);
    }
  });

  it("no renderer drops ACs, interfaces, dependencies, verification specs, change kinds, or budgets", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const ctx = {
      phase: "implement" as const,
      role: "worker" as const,
      contextDigest: CONTEXT_DIGEST,
      contractDigest: contract.digest,
    };
    const receipts: PromptReceipt[] = [
      renderImplementationPrompt(contract, ctx),
      renderReviewPrompt(contract, { ...ctx, phase: "review", role: "reviewer" }, { baselineOid: repoHead(repo), candidateOid: "c".repeat(40), diffDigest: digest("d") }),
      renderRemediationPrompt(contract, { ...ctx, phase: "remediate", role: "remediator" }, FINDINGS),
      renderVerificationPrompt(contract, { ...ctx, phase: "verify", role: "verifier" }),
      renderConvergencePrompt(contract, { ...ctx, phase: "converge", role: "converger" }),
    ];
    for (const receipt of receipts) {
      // ACs
      expect(receipt.prompt_text).toContain("AC-PROP-01");
      expect(receipt.prompt_text).toContain("AC-PROP-02");
      // Interfaces
      expect(receipt.prompt_text).toContain("INTERFACE-PROMPT-RECEIPT");
      // Dependencies
      expect(receipt.prompt_text).toContain("t24");
      // Structured verification specs
      expect(receipt.prompt_text).toContain("VERIFY-PROP-FIXTURES");
      // Change kinds
      expect(receipt.prompt_text).toContain('"change_kind"');
      // Budgets
      expect(receipt.prompt_text).toContain('"max_attempts"');
      expect(receipt.prompt_text).toContain('"remediation_limit"');
      // Contract digest
      expect(receipt.prompt_text).toContain(contract.digest);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Deterministic, redacted, content-hashed receipts (AC: prompt receipts)
// ---------------------------------------------------------------------------

describe("prompt receipts are deterministic, redacted, and content-hashed", () => {
  it("identical input produces identical prompt_digest (replay)", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const ctx = {
      phase: "implement" as const,
      role: "worker" as const,
      contextDigest: CONTEXT_DIGEST,
      contractDigest: contract.digest,
    };
    const a = renderImplementationPrompt(contract, ctx);
    const b = renderImplementationPrompt(contract, ctx);
    expect(a.prompt_digest).toBe(b.prompt_digest);
    expect(a.prompt_text).toBe(b.prompt_text);
  });

  it("divergent context digest produces divergent prompt_digest", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const a = renderImplementationPrompt(contract, {
      phase: "implement", role: "worker",
      contextDigest: CONTEXT_DIGEST, contractDigest: contract.digest,
    });
    const b = renderImplementationPrompt(contract, {
      phase: "implement", role: "worker",
      contextDigest: ALT_CONTEXT_DIGEST, contractDigest: contract.digest,
    });
    expect(a.prompt_digest).not.toBe(b.prompt_digest);
  });

  it("prompt_digest is the canonical SHA-256 of the receipt payload (content-hashed)", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const receipt = renderImplementationPrompt(contract, {
      phase: "implement", role: "worker",
      contextDigest: CONTEXT_DIGEST, contractDigest: contract.digest,
    });
    const { prompt_digest, ...payload } = receipt;
    expect(prompt_digest).toBe(digest(canonicalJson(payload)));
  });

  it("prompt_text is canonical JSON (redacted; no secrets, deterministic key order)", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const receipt = renderImplementationPrompt(contract, {
      phase: "implement", role: "worker",
      contextDigest: CONTEXT_DIGEST, contractDigest: contract.digest,
    });
    // Canonical JSON is parseable and round-trips.
    const parsed = JSON.parse(receipt.prompt_text) as Record<string, unknown>;
    expect(parsed["contract_digest"]).toBe(contract.digest);
    // The prompt body's top-level schema_version is the prompt schema; the
    // embedded contract carries the contract schema_version.
    expect(parsed["schema_version"]).toBe("rickgent.prompt.v1");
    const embedded = parsed["contract"] as Record<string, unknown>;
    expect(embedded["schema_version"]).toBe(contract.schema_version);
  });
});

// ---------------------------------------------------------------------------
// 3. verifyPromptReceipt rejects lossy reconstruction (AC-PROP-02, negative proofs)
// ---------------------------------------------------------------------------

describe("verifyPromptReceipt rejects lossy reconstruction fail-closed", () => {
  it("accepts a genuine receipt for the matching contract and context", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const receipt = renderImplementationPrompt(contract, {
      phase: "implement", role: "worker",
      contextDigest: CONTEXT_DIGEST, contractDigest: contract.digest,
    });
    expect(() => verifyPromptReceipt(receipt, contract, CONTEXT_DIGEST)).not.toThrow();
  });

  it("rejects a mutated contract digest (lossy reconstruction)", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const receipt = renderImplementationPrompt(contract, {
      phase: "implement", role: "worker",
      contextDigest: CONTEXT_DIGEST, contractDigest: contract.digest,
    });
    // A receipt whose contract_digest field is mutated to a wrong digest.
    const mutated: PromptReceipt = { ...receipt, contract_digest: digest("forged") };
    expect(() => verifyPromptReceipt(mutated, contract, CONTEXT_DIGEST)).toThrow(PromptReceiptMismatchError);
  });

  it("rejects a context-digest mismatch on resume", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const receipt = renderImplementationPrompt(contract, {
      phase: "implement", role: "worker",
      contextDigest: CONTEXT_DIGEST, contractDigest: contract.digest,
    });
    expect(() => verifyPromptReceipt(receipt, contract, ALT_CONTEXT_DIGEST)).toThrow(PromptReceiptMismatchError);
  });

  it("rejects a prompt_digest tamper (replay integrity)", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const receipt = renderImplementationPrompt(contract, {
      phase: "implement", role: "worker",
      contextDigest: CONTEXT_DIGEST, contractDigest: contract.digest,
    });
    const tampered: PromptReceipt = { ...receipt, prompt_digest: digest("tampered") };
    expect(() => verifyPromptReceipt(tampered, contract, CONTEXT_DIGEST)).toThrow(PromptReceiptMismatchError);
  });

  it("rejects a missing contract field in prompt_text (dropped ACs)", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const receipt = renderImplementationPrompt(contract, {
      phase: "implement", role: "worker",
      contextDigest: CONTEXT_DIGEST, contractDigest: contract.digest,
    });
    // Strip the acceptance_criteria block from the prompt_text (lossy
    // reconstruction).  The receipt's rendered_fields still lists the field,
    // but the prompt_text no longer contains it — verify must catch this.
    const lossyText = receipt.prompt_text.replace(/"acceptance_criteria":\s*\[[^\]]*\]/, '"acceptance_criteria":[]');
    const lossy: PromptReceipt = { ...receipt, prompt_text: lossyText };
    expect(() => verifyPromptReceipt(lossy, contract, CONTEXT_DIGEST)).toThrow(PromptReceiptMismatchError);
  });

  it("rejects a phase mismatch (review receipt presented for implement)", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const reviewReceipt = renderReviewPrompt(contract, {
      phase: "review", role: "reviewer",
      contextDigest: CONTEXT_DIGEST, contractDigest: contract.digest,
    }, { baselineOid: repoHead(repo), candidateOid: "c".repeat(40), diffDigest: digest("d") });
    // Present the review receipt as if it were an implement receipt.
    const forged: PromptReceipt = { ...reviewReceipt, phase: "implement", role: "worker" };
    expect(() => verifyPromptReceipt(forged, contract, CONTEXT_DIGEST)).toThrow(PromptReceiptMismatchError);
  });

  it("rejects a contract whose digest differs from the receipt's contract_digest", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    // Build a second contract with a different id (different digest).
    const otherDraft: TicketContractDraft = { ...ticketDraft(), id: "t99", depends_on: [] };
    const otherRepo = makeRepo();
    const other = sealTicketContracts([otherDraft], { repositoryRoot: otherRepo })[0]!;
    const receipt = renderImplementationPrompt(contract, {
      phase: "implement", role: "worker",
      contextDigest: CONTEXT_DIGEST, contractDigest: contract.digest,
    });
    expect(() => verifyPromptReceipt(receipt, other, CONTEXT_DIGEST)).toThrow(PromptReceiptMismatchError);
  });

  it("rejects a receipt whose contract_digest disagrees with the prompt_text contract digest", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const receipt = renderImplementationPrompt(contract, {
      phase: "implement", role: "worker",
      contextDigest: CONTEXT_DIGEST, contractDigest: contract.digest,
    });
    // Mutate the contract_digest field on the receipt but NOT in the prompt_text.
    const forged: PromptReceipt = { ...receipt, contract_digest: digest("forged-outer") };
    expect(() => verifyPromptReceipt(forged, contract, CONTEXT_DIGEST)).toThrow(PromptReceiptMismatchError);
  });
});

// ---------------------------------------------------------------------------
// 4. Ticket-specific gates replace the global PRD-AC execution (AC: gates)
// ---------------------------------------------------------------------------

describe("ticket-specific gates replace the global execution of every PRD AC", () => {
  it("runContractConformanceGate extracts gates per-contract from contract.verifications, not global PRD ACs", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    // The ticket-specific gate runs the contract's own verifications.
    const result = runContractConformanceGate([contract], repo, process.env);
    // One AC => one result row, identified by the contract's AC id.
    expect(result.total).toBe(2);
    expect(result.results.map((r) => r.acId)).toEqual(["AC-PROP-01", "AC-PROP-02"]);
    // The gate runs the contract's verification argv (node --version), which exits 0.
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("different contracts produce disjoint gate sets (no global PRD-AC mixing)", () => {
    const repo = makeRepo();
    const contractA = ticketContract(repo);
    const draftB: TicketContractDraft = {
      ...ticketDraft(),
      id: "t26",
      title: "sandboxed gate runner",
      description: "argv-only gate runner.",
      depends_on: ["t25"],
      acceptance_criteria: [{
        id: "AC-GATE-01",
        description: "argv-only gates",
        interface_ids: ["INTERFACE-PROMPT-RECEIPT"],
        verification_ids: ["VERIFY-PROP-FIXTURES"],
      }],
    };
    const contractB = sealTicketContracts([draftB], {
      repositoryRoot: repo,
      knownExternalDependencyIds: ["t24", "t25"],
    })[0]!;
    const result = runContractConformanceGate([contractA, contractB], repo, process.env);
    // Contract A contributes 2 ACs, contract B contributes 1 AC.
    expect(result.total).toBe(3);
    expect(result.results.map((r) => r.acId).sort()).toEqual(["AC-GATE-01", "AC-PROP-01", "AC-PROP-02"]);
  });

  it("a contract with no acceptance criteria produces no gate results (no global fallback)", () => {
    const repo = makeRepo();
    const draft: TicketContractDraft = {
      ...ticketDraft(),
      id: "t27",
      acceptance_criteria: [],
    };
    // sealTicketContracts rejects empty AC arrays, so we expect admission to
    // fail closed — proving the contract itself enforces non-empty gates.
    expect(() => sealTicketContracts([draft], { repositoryRoot: repo, knownExternalDependencyIds: ["t24"] }))
      .toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Production build path uses the renderer (no lossy reconstruction)
// ---------------------------------------------------------------------------

describe("production build path uses the renderer (no lossy ticketPrompt reconstruction)", () => {
  it("ticketPrompt delegates to the implementation renderer and carries the full contract", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const prompt = ticketPrompt(contract);
    // The legacy lossy header `Implement ticket t25: <title>` is gone — the
    // renderer emits the full normalized contract.  The full canonical
    // contract body is carried (not just id/title/description).
    expect(prompt).toContain(canonicalJson(contract));
    expect(prompt).toContain(contract.digest);
    expect(prompt).toContain('"acceptance_criteria"');
    expect(prompt).toContain('"verifications"');
    expect(prompt).toContain('"budgets"');
    expect(prompt).toContain('"interfaces"');
    expect(prompt).toContain('"depends_on"');
    expect(prompt).toContain('"scope"');
  });

  it("the lossy `Implement ticket <id>: <title>` header is absent from the rendered prompt", () => {
    const repo = makeRepo();
    const contract = ticketContract(repo);
    const prompt = ticketPrompt(contract);
    // The lossy two-line header must not appear.
    expect(prompt).not.toMatch(/^Implement ticket t25: /);
    expect(prompt).not.toContain(`Implement ticket ${contract.id}: ${contract.title}`);
  });
});
