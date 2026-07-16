import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  TICKET_CONTRACT_SCHEMA_VERSION,
  TicketContractError,
  canonicalJson,
  normalizeTicketContracts,
  sealTicketContracts,
  ticketContractDigest,
  type TicketContractDraft,
} from "../../src/contracts/ticket-contract.js";

const FIXTURE_ROOT = join(import.meta.dirname, "../fixtures/ticket-contract");
const temporaryRoots: string[] = [];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function baseDraft(id = "t01"): TicketContractDraft {
  return {
    schema_version: TICKET_CONTRACT_SCHEMA_VERSION,
    id,
    title: `Ticket ${id}`,
    description: `Implement ${id}`,
    depends_on: [],
    scope: [{ path: `src/${id}.ts`, change_kind: "create", directory: false }],
    interfaces: [{
      id: "INTERFACE-MAIN",
      direction: "provides",
      path: `src/${id}.ts`,
      owner: id,
      description: "Primary interface",
    }],
    acceptance_criteria: [{
      id: "AC-MAIN-01",
      description: "The ticket is verified",
      interface_ids: ["INTERFACE-MAIN"],
      verification_ids: ["VERIFY-MAIN-01"],
    }],
    verifications: [{
      id: "VERIFY-MAIN-01",
      executable: "node",
      args: ["--version"],
      cwd_class: "repository_root",
      env_allowlist: ["PATH"],
      timeout_ms: 30_000,
      network: "deny",
      writable_outputs: [],
      expected_exit_codes: [0],
    }],
    budgets: {
      max_attempts: 2,
      max_review_cycles: 1,
      wall_clock_ms: 900_000,
      remediation_limit: 1,
    },
  };
}

function sealedValue(draft: unknown): Record<string, unknown> {
  const value = clone(draft) as Record<string, unknown>;
  return { ...value, digest: ticketContractDigest(value) };
}

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

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "rickgent-ticket-contract-"));
  temporaryRoots.push(root);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src", "dir"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "seed\n");
  writeFileSync(join(repo, "src", "existing.ts"), "export const existing = true;\n");
  writeFileSync(join(repo, "src", "destination.ts"), "export const destination = true;\n");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@rickgent.test"]);
  git(repo, ["config", "user.name", "Rickgent Test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("TicketContract canonical identity", () => {
  it("admits the frozen valid fixture with its exact digest and deep-freezes it", () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURE_ROOT, "valid.json"), "utf8"));
    const [contract] = normalizeTicketContracts([fixture], {
      knownExternalDependencyIds: ["t01"],
    });

    expect(contract?.digest).toBe("sha256:560d57df17f16a52879403b2794fd0c1dbf36ef1c72d4b2af2cc2ab315cc5116");
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract?.scope)).toBe(true);
    expect(Object.isFrozen(contract?.scope[0])).toBe(true);
    expect(() => {
      (contract!.budgets as { max_attempts: number }).max_attempts = 99;
    }).toThrow(TypeError);
  });

  it("matches both frozen property-order canonicalization vectors", () => {
    const fixture = JSON.parse(readFileSync(join(FIXTURE_ROOT, "canonicalization-vectors.json"), "utf8"));
    for (const vector of fixture.vectors) {
      expect(canonicalJson(vector.input)).toBe(canonicalJson(vector.permuted_input));
      expect(ticketContractDigest(vector.input)).toBe(vector.expected_digest);
      expect(ticketContractDigest(vector.permuted_input)).toBe(vector.expected_digest);
    }
  });

  it("changes the digest whenever any executable field changes", () => {
    const original = baseDraft();
    const digest = ticketContractDigest(original);
    const mutations: Array<[string, (draft: any) => void]> = [
      ["schema_version", (draft) => { draft.schema_version = "2.0.0"; }],
      ["id", (draft) => { draft.id = "t02"; }],
      ["title", (draft) => { draft.title = "Changed"; }],
      ["description", (draft) => { draft.description = "Changed"; }],
      ["depends_on", (draft) => { draft.depends_on = ["t00"]; }],
      ["scope.path", (draft) => { draft.scope[0].path = "src/changed.ts"; }],
      ["scope.change_kind", (draft) => { draft.scope[0].change_kind = "modify"; }],
      ["scope.directory", (draft) => { draft.scope[0].directory = true; }],
      ["scope.from_path", (draft) => { draft.scope[0].from_path = "src/old.ts"; }],
      ["interfaces.id", (draft) => { draft.interfaces[0].id = "INTERFACE-ALT"; }],
      ["interfaces.direction", (draft) => { draft.interfaces[0].direction = "consumes"; }],
      ["interfaces.path", (draft) => { draft.interfaces[0].path = "src/alt.ts"; }],
      ["interfaces.owner", (draft) => { draft.interfaces[0].owner = "other"; }],
      ["interfaces.description", (draft) => { draft.interfaces[0].description = "Changed"; }],
      ["acceptance_criteria.id", (draft) => { draft.acceptance_criteria[0].id = "AC-ALT-01"; }],
      ["acceptance_criteria.description", (draft) => { draft.acceptance_criteria[0].description = "Changed"; }],
      ["acceptance_criteria.interface_ids", (draft) => { draft.acceptance_criteria[0].interface_ids = []; }],
      ["acceptance_criteria.verification_ids", (draft) => { draft.acceptance_criteria[0].verification_ids = ["VERIFY-ALT-01"]; }],
      ["verifications.id", (draft) => { draft.verifications[0].id = "VERIFY-ALT-01"; }],
      ["verifications.executable", (draft) => { draft.verifications[0].executable = "npm"; }],
      ["verifications.args", (draft) => { draft.verifications[0].args = ["test"]; }],
      ["verifications.cwd_class", (draft) => { draft.verifications[0].cwd_class = "attempt_output"; }],
      ["verifications.env_allowlist", (draft) => { draft.verifications[0].env_allowlist = []; }],
      ["verifications.timeout_ms", (draft) => { draft.verifications[0].timeout_ms = 31_000; }],
      ["verifications.network", (draft) => { draft.verifications[0].network = "allow"; }],
      ["verifications.writable_outputs", (draft) => { draft.verifications[0].writable_outputs = ["artifacts/out"]; }],
      ["verifications.expected_exit_codes", (draft) => { draft.verifications[0].expected_exit_codes = [0, 1]; }],
      ["budgets.max_attempts", (draft) => { draft.budgets.max_attempts = 3; }],
      ["budgets.max_review_cycles", (draft) => { draft.budgets.max_review_cycles = 2; }],
      ["budgets.wall_clock_ms", (draft) => { draft.budgets.wall_clock_ms = 900_001; }],
      ["budgets.remediation_limit", (draft) => { draft.budgets.remediation_limit = 2; }],
    ];

    for (const [label, mutate] of mutations) {
      const changed = clone(original) as any;
      mutate(changed);
      expect(ticketContractDigest(changed), label).not.toBe(digest);
    }
    expect(ticketContractDigest({ ...original, digest: "sha256:" + "0".repeat(64) })).toBe(digest);
  });

  it("requires a supported schema and a present, well-formed, matching digest", () => {
    const draft = baseDraft();
    expectCode(() => normalizeTicketContracts([draft]), "TICKET_SCHEMA_INVALID");
    expectCode(
      () => normalizeTicketContracts([{ ...draft, digest: "bad" }]),
      "TICKET_DIGEST_INVALID",
    );
    expectCode(
      () => normalizeTicketContracts([{ ...draft, digest: "sha256:" + "0".repeat(64) }]),
      "TICKET_DIGEST_MISMATCH",
    );
    const unsupported = { ...draft, schema_version: "2.0.0" };
    expectCode(
      () => normalizeTicketContracts([sealedValue(unsupported)]),
      "TICKET_SCHEMA_VERSION_UNSUPPORTED",
    );
  });
});

describe("TicketContract IDs, references, dependencies, and scopes", () => {
  it("rejects duplicate ticket/interface/AC/verification IDs", () => {
    const duplicateTicket = baseDraft();
    expectCode(() => sealTicketContracts([duplicateTicket, clone(duplicateTicket)]), "TICKET_ID_DUPLICATE");

    for (const field of ["interfaces", "acceptance_criteria", "verifications"] as const) {
      const draft = clone(baseDraft()) as any;
      draft[field].push(clone(draft[field][0]));
      expectCode(() => sealTicketContracts([draft]), "TICKET_ID_DUPLICATE");
    }
  });

  it("rejects unknown interface, verification, and dependency references", () => {
    const unknownInterface = clone(baseDraft()) as any;
    unknownInterface.acceptance_criteria[0].interface_ids = ["INTERFACE-UNKNOWN"];
    expectCode(() => sealTicketContracts([unknownInterface]), "TICKET_INTERFACE_REFERENCE_UNKNOWN");

    const unknownVerification = clone(baseDraft()) as any;
    unknownVerification.acceptance_criteria[0].verification_ids = ["VERIFY-UNKNOWN"];
    expectCode(() => sealTicketContracts([unknownVerification]), "TICKET_VERIFICATION_REFERENCE_UNKNOWN");

    const unknownDependency = clone(baseDraft()) as any;
    unknownDependency.depends_on = ["t99"];
    expectCode(() => sealTicketContracts([unknownDependency]), "TICKET_DEPENDENCY_UNKNOWN");
  });

  it("rejects a deterministic multi-node dependency cycle", () => {
    const first = clone(baseDraft("t01")) as any;
    const second = clone(baseDraft("t02")) as any;
    const third = clone(baseDraft("t03")) as any;
    first.depends_on = ["t02"];
    second.depends_on = ["t03"];
    third.depends_on = ["t01"];
    expectCode(() => sealTicketContracts([third, first, second]), "TICKET_DEPENDENCY_CYCLE");
  });

  it("rejects empty, duplicate, nested, and active-overlapping scopes", () => {
    const empty = clone(baseDraft()) as any;
    empty.scope = [];
    expectCode(() => sealTicketContracts([empty]), "TICKET_NO_OP");

    const duplicate = clone(baseDraft()) as any;
    duplicate.scope.push(clone(duplicate.scope[0]));
    expectCode(() => sealTicketContracts([duplicate]), "TICKET_SCOPE_DUPLICATE");

    const nested = clone(baseDraft()) as any;
    nested.scope = [
      { path: "src", change_kind: "modify", directory: true },
      { path: "src/file.ts", change_kind: "create", directory: false },
    ];
    expectCode(() => sealTicketContracts([nested]), "TICKET_SCOPE_OVERLAP");

    const activeDraft = clone(baseDraft("t01")) as any;
    activeDraft.scope = [{ path: "src", change_kind: "modify", directory: true }];
    const [active] = sealTicketContracts([activeDraft]);
    const candidate = clone(baseDraft("t02")) as any;
    candidate.scope = [{ path: "src/new.ts", change_kind: "create", directory: false }];
    expectCode(
      () => sealTicketContracts([candidate], { activeContracts: [active!] }),
      "TICKET_ACTIVE_SCOPE_OVERLAP",
    );
  });

  it("uses path boundaries, so sibling names do not overlap", () => {
    const first = clone(baseDraft("t01")) as any;
    const second = clone(baseDraft("t02")) as any;
    first.scope = [{ path: "src/a", change_kind: "create", directory: true }];
    second.scope = [{ path: "src/ab", change_kind: "create", directory: true }];
    expect(sealTicketContracts([first, second])).toHaveLength(2);
  });
});

describe("TicketContract repository path admission", () => {
  it("rejects case variants of reserved Git and Rickgent path segments", () => {
    for (const path of [".GIT/config", "src/.GiT/config", ".RICKGENT/state.json", "src/.RickGent/state.json"]) {
      const draft = clone(baseDraft()) as any;
      draft.scope = [{ path, change_kind: "create", directory: false }];
      expectCode(() => sealTicketContracts([draft]), "TICKET_SCOPE_PATH_RESERVED");
    }
  });

  it("rejects non-canonical, absolute, traversing, reserved, and NUL scope paths", () => {
    const cases: Array<[string, string]> = [
      ["/tmp/escape", "TICKET_SCOPE_PATH_ABSOLUTE"],
      ["C:/escape", "TICKET_SCOPE_PATH_ABSOLUTE"],
      ["C:\\escape", "TICKET_SCOPE_PATH_ABSOLUTE"],
      ["../escape", "TICKET_SCOPE_PATH_TRAVERSAL"],
      ["src/./file.ts", "TICKET_SCOPE_PATH_TRAVERSAL"],
      ["src//file.ts", "TICKET_SCOPE_PATH_INVALID"],
      ["src/file.ts/", "TICKET_SCOPE_PATH_INVALID"],
      ["src\\file.ts", "TICKET_SCOPE_PATH_INVALID"],
      ["src/\0file.ts", "TICKET_SCOPE_PATH_INVALID"],
      [".git/config", "TICKET_SCOPE_PATH_RESERVED"],
      ["state/.rickgent/data", "TICKET_SCOPE_PATH_RESERVED"],
    ];
    for (const [path, code] of cases) {
      const draft = clone(baseDraft()) as any;
      draft.scope[0].path = path;
      expectCode(() => sealTicketContracts([draft]), code);
    }
  });

  it("rejects existing and nearest-parent escaping symlinks", () => {
    const repo = createRepository();
    const outside = join(repo, "..", "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(repo, "escape"));

    for (const path of ["escape", "escape/new.ts"]) {
      const draft = clone(baseDraft()) as any;
      draft.scope = [{ path, change_kind: "create", directory: path === "escape" }];
      expectCode(
        () => sealTicketContracts([draft], { repositoryRoot: repo }),
        "TICKET_SCOPE_PATH_ESCAPE",
      );
    }
  });

  it("rejects initialized and uninitialized gitlink crossings", () => {
    const repo = createRepository();
    const head = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["update-index", "--add", "--cacheinfo", `160000,${head},vendor/sub`]);

    const crossing = clone(baseDraft()) as any;
    crossing.scope = [{ path: "vendor/sub/file.ts", change_kind: "create", directory: false }];
    expectCode(
      () => sealTicketContracts([crossing], { repositoryRoot: repo }),
      "TICKET_SCOPE_PATH_SUBMODULE",
    );

    const ancestor = clone(baseDraft()) as any;
    ancestor.scope = [{ path: "vendor", change_kind: "create", directory: true }];
    expectCode(
      () => sealTicketContracts([ancestor], { repositoryRoot: repo }),
      "TICKET_SCOPE_PATH_SUBMODULE",
    );

    const caseAlias = clone(baseDraft()) as any;
    caseAlias.scope = [{ path: "Vendor/Sub/file.ts", change_kind: "create", directory: false }];
    if (existsSync(join(repo, "README.MD"))) {
      expectCode(
        () => sealTicketContracts([caseAlias], { repositoryRoot: repo }),
        "TICKET_SCOPE_PATH_SUBMODULE",
      );
    } else {
      // A proven case-sensitive filesystem may legitimately own this distinct path.
      expect(sealTicketContracts([caseAlias], { repositoryRoot: repo })).toHaveLength(1);
    }

    mkdirSync(join(repo, "vendor", "sub"), { recursive: true });
    expectCode(
      () => sealTicketContracts([crossing], { repositoryRoot: repo }),
      "TICKET_SCOPE_PATH_SUBMODULE",
    );
  });

  it("rejects resolved aliases to normal and linked-worktree Git administrative roots", () => {
    const repo = createRepository();
    symlinkSync(join(repo, ".git"), join(repo, "git-admin"));

    const normalAlias = clone(baseDraft()) as any;
    normalAlias.scope = [{ path: "git-admin/config", change_kind: "modify", directory: false }];
    expectCode(
      () => sealTicketContracts([normalAlias], { repositoryRoot: repo }),
      "TICKET_SCOPE_PATH_RESERVED",
    );

    const linked = join(repo, "..", "linked-worktree");
    git(repo, ["worktree", "add", "-q", "-b", "linked-proof", linked]);
    const linkedGitDir = git(linked, ["rev-parse", "--absolute-git-dir"]);
    const commonGitDir = git(repo, ["rev-parse", "--absolute-git-dir"]);
    symlinkSync(linkedGitDir, join(linked, "worktree-admin"));
    symlinkSync(commonGitDir, join(linked, "common-admin"));

    for (const path of ["worktree-admin/HEAD", "common-admin/config"]) {
      const linkedAlias = clone(baseDraft()) as any;
      linkedAlias.scope = [{ path, change_kind: "modify", directory: false }];
      expectCode(
        () => sealTicketContracts([linkedAlias], { repositoryRoot: linked }),
        "TICKET_SCOPE_PATH_RESERVED",
      );
    }
  });

  it("rejects configured state roots while allowing external state roots", () => {
    const repo = createRepository();
    const draft = clone(baseDraft()) as any;
    draft.scope = [{ path: "state/output.ts", change_kind: "create", directory: false }];
    expectCode(
      () => sealTicketContracts([draft], { repositoryRoot: repo, stateRoots: ["state"] }),
      "TICKET_SCOPE_PATH_RESERVED",
    );

    const ancestorDirectory = clone(baseDraft()) as any;
    ancestorDirectory.scope = [{ path: "state", change_kind: "create", directory: true }];
    expectCode(
      () => sealTicketContracts(
        [ancestorDirectory],
        { repositoryRoot: repo, stateRoots: ["state/internal"] },
      ),
      "TICKET_SCOPE_PATH_RESERVED",
    );

    const caseAliasAncestor = clone(baseDraft()) as any;
    caseAliasAncestor.scope = [{ path: "State", change_kind: "create", directory: true }];
    if (existsSync(join(repo, "README.MD"))) {
      expectCode(
        () => sealTicketContracts(
          [caseAliasAncestor],
          { repositoryRoot: repo, stateRoots: ["state/internal"] },
        ),
        "TICKET_SCOPE_PATH_RESERVED",
      );
    } else {
      // Preserve distinct names when the backing filesystem proves case sensitivity.
      expect(sealTicketContracts(
        [caseAliasAncestor],
        { repositoryRoot: repo, stateRoots: ["state/internal"] },
      )).toHaveLength(1);
    }

    expect(
      sealTicketContracts([draft], { repositoryRoot: repo, stateRoots: [join(repo, "..", ".rickgent")] }),
    ).toHaveLength(1);
  });

  it("applies path safety to interfaces and writable outputs", () => {
    const repo = createRepository();
    const outside = join(repo, "..", "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(repo, "escape"));

    const interfaceEscape = clone(baseDraft()) as any;
    interfaceEscape.interfaces[0].path = "escape/interface.ts";
    expectCode(
      () => sealTicketContracts([interfaceEscape], { repositoryRoot: repo }),
      "TICKET_SCOPE_PATH_ESCAPE",
    );

    const outputEscape = clone(baseDraft()) as any;
    outputEscape.verifications[0].writable_outputs = ["escape/output.txt"];
    expectCode(
      () => sealTicketContracts([outputEscape], { repositoryRoot: repo }),
      "TICKET_SCOPE_PATH_ESCAPE",
    );
  });

  it("enforces create/modify/delete/rename feasibility and file kinds", () => {
    const repo = createRepository();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["create-existing", { path: "src/existing.ts", change_kind: "create", directory: false }, "TICKET_SCOPE_CHANGE_MISMATCH"],
      ["modify-missing", { path: "src/missing.ts", change_kind: "modify", directory: false }, "TICKET_SCOPE_CHANGE_MISMATCH"],
      ["delete-missing", { path: "src/missing.ts", change_kind: "delete", directory: false }, "TICKET_SCOPE_CHANGE_MISMATCH"],
      ["kind-mismatch", { path: "src/existing.ts", change_kind: "modify", directory: true }, "TICKET_SCOPE_CHANGE_MISMATCH"],
      ["rename-missing", { path: "src/new.ts", from_path: "src/missing.ts", change_kind: "rename", directory: false }, "TICKET_SCOPE_RENAME_INVALID"],
      ["rename-overwrite", { path: "src/destination.ts", from_path: "src/existing.ts", change_kind: "rename", directory: false }, "TICKET_SCOPE_RENAME_INVALID"],
    ];
    for (const [name, scope, code] of cases) {
      const draft = clone(baseDraft()) as any;
      draft.scope = [scope];
      expectCode(() => sealTicketContracts([draft], { repositoryRoot: repo }), code);
      expect(name).not.toBe("");
    }

    for (const scope of [
      { path: "src/dir", change_kind: "delete", directory: true },
      { path: "src/new-dir", from_path: "src/dir", change_kind: "rename", directory: true },
    ]) {
      const draft = clone(baseDraft()) as any;
      draft.scope = [scope];
      expectCode(() => sealTicketContracts([draft]), "TICKET_SCOPE_CHANGE_UNSUPPORTED");
    }

    const validModify = clone(baseDraft()) as any;
    validModify.scope = [{ path: "src/existing.ts", change_kind: "modify", directory: false }];
    expect(sealTicketContracts([validModify], { repositoryRoot: repo })).toHaveLength(1);
    const validDelete = clone(baseDraft()) as any;
    validDelete.scope = [{ path: "src/existing.ts", change_kind: "delete", directory: false }];
    expect(sealTicketContracts([validDelete], { repositoryRoot: repo })).toHaveLength(1);
    const validRename = clone(baseDraft()) as any;
    validRename.scope = [{ path: "src/renamed.ts", from_path: "src/existing.ts", change_kind: "rename", directory: false }];
    expect(sealTicketContracts([validRename], { repositoryRoot: repo })).toHaveLength(1);
  });
});

describe("TicketContract typed verification", () => {
  it("rejects legacy shell strings and malformed argv/cwd/environment/output policies", () => {
    const cases: Array<[string, (draft: any) => void, string]> = [
      ["legacy-shell-string", (draft) => { draft.verifications = "npm test"; }, "TICKET_VERIFICATION_INVALID"],
      ["shell-executable", (draft) => { draft.verifications[0].executable = "/bin/bash"; }, "TICKET_VERIFICATION_SHELL_FORBIDDEN"],
      ["malformed-argv", (draft) => { draft.verifications[0].args = [1]; }, "TICKET_VERIFICATION_INVALID"],
      ["malformed-cwd", (draft) => { draft.verifications[0].cwd_class = "package"; }, "TICKET_VERIFICATION_CWD_INVALID"],
      ["duplicate-environment", (draft) => { draft.verifications[0].env_allowlist = ["PATH", "PATH"]; }, "TICKET_VERIFICATION_ENV_INVALID"],
      ["invalid-environment", (draft) => { draft.verifications[0].env_allowlist = ["Path"]; }, "TICKET_VERIFICATION_ENV_INVALID"],
      ["unbounded-timeout", (draft) => { draft.verifications[0].timeout_ms = 3_600_001; }, "TICKET_VERIFICATION_TIMEOUT_INVALID"],
      ["network-enabled", (draft) => { draft.verifications[0].network = "allow"; }, "TICKET_VERIFICATION_NETWORK_FORBIDDEN"],
      ["malformed-outputs", (draft) => { draft.verifications[0].writable_outputs = "out"; }, "TICKET_VERIFICATION_OUTPUT_INVALID"],
      ["unsafe-output", (draft) => { draft.verifications[0].writable_outputs = ["../out"]; }, "TICKET_SCOPE_PATH_TRAVERSAL"],
      ["empty-exit-policy", (draft) => { draft.verifications[0].expected_exit_codes = []; }, "TICKET_VERIFICATION_EXIT_INVALID"],
      ["duplicate-exit-policy", (draft) => { draft.verifications[0].expected_exit_codes = [0, 0]; }, "TICKET_VERIFICATION_EXIT_INVALID"],
      ["invalid-exit-policy", (draft) => { draft.verifications[0].expected_exit_codes = [256]; }, "TICKET_VERIFICATION_EXIT_INVALID"],
    ];
    for (const [name, mutate, code] of cases) {
      const draft = clone(baseDraft()) as any;
      mutate(draft);
      expectCode(() => sealTicketContracts([draft]), code);
      expect(name).not.toBe("");
    }
  });

  it("keeps shell metacharacters inert inside argv elements", () => {
    const draft = clone(baseDraft()) as any;
    draft.verifications[0].args = ["literal; rm -rf /", "$(touch nope)"];
    const [contract] = sealTicketContracts([draft]);
    expect(contract?.verifications[0]?.args).toEqual(["literal; rm -rf /", "$(touch nope)"]);
  });

  it("selects the same stable path error regardless of property insertion order", () => {
    const draft = clone(baseDraft()) as any;
    draft.scope[0].path = "/escape";
    const first = sealedValue(draft);
    const second = Object.fromEntries(Object.entries(first).reverse());
    expectCode(() => normalizeTicketContracts([first]), "TICKET_SCOPE_PATH_ABSOLUTE");
    expectCode(() => normalizeTicketContracts([second]), "TICKET_SCOPE_PATH_ABSOLUTE");
  });
});
