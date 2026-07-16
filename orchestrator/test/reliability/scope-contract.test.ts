import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  checkStructuredScope,
  type ScopeDeclaration,
  type ScopeOperation,
  type StructuredScopeInput,
} from "../../src/core/scope.js";

const CORPUS_ROOT = resolve(
  process.cwd(),
  "../rickgent-policies/test/fixtures/native-policy-corpus",
);
const manifest = JSON.parse(readFileSync(join(CORPUS_ROOT, "manifest.json"), "utf8")) as CorpusManifest;
const expected = JSON.parse(readFileSync(join(CORPUS_ROOT, "expected-verdicts.json"), "utf8")) as ExpectedDocument;

interface ScopeCase {
  readonly id: string;
  readonly worktree_root?: string;
  readonly authorized_root?: string;
  readonly reserved_roots?: readonly string[];
  readonly setup: {
    readonly dirs?: readonly string[];
    readonly files?: readonly string[];
    readonly symlinks?: readonly { readonly link: string; readonly target: string }[];
  };
  readonly declared_scope: readonly {
    readonly path: string;
    readonly from_path?: string;
    readonly change_kind: "create" | "modify" | "delete" | "rename";
    readonly directory: boolean;
  }[];
  readonly operation: {
    readonly kind: "read" | "create" | "modify" | "delete" | "rename" | "link";
    readonly directory: boolean;
    readonly path?: string;
    readonly source_path?: string;
    readonly destination_path?: string;
  };
  readonly expected_result: "ALLOW" | "DENY" | "ABSTAIN";
  readonly expected_change_kind: "create" | "modify" | "delete" | "rename" | null;
}

interface CorpusManifest {
  readonly schema_version: string;
  readonly scope_contract: {
    readonly schema_version: string;
    readonly cases: readonly ScopeCase[];
  };
}

interface ExpectedDocument {
  readonly scope_contract: {
    readonly schema_version: string;
    readonly manifest_case_count: number;
    readonly required_observations: readonly string[];
  };
}

interface MaterializedCase {
  readonly container: string;
  readonly input: StructuredScopeInput;
}

const activeContainers: string[] = [];

function expand(token: string, roots: Record<string, string>, defaultRoot: string): string {
  for (const [name, value] of Object.entries(roots)) {
    if (token === name) return value;
    if (token.startsWith(`${name}/`)) return join(value, token.slice(name.length + 1));
  }
  return join(defaultRoot, token);
}

function materialize(scopeCase: ScopeCase): MaterializedCase {
  const container = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-scope-contract-")));
  activeContainers.push(container);
  const worktree = join(container, "worktree");
  const outside = join(container, "outside");
  const state = join(container, "state");
  const policy = join(container, "policy");
  const bundle = join(container, "bundle");
  for (const path of [worktree, outside, state, policy, bundle]) mkdirSync(path);
  const worktreeLink = join(container, "worktree-link");
  symlinkSync(worktree, worktreeLink);
  const roots = {
    $WORKTREE: worktree,
    $WORKTREE_LINK: worktreeLink,
    $OUTSIDE: outside,
    $STATE: state,
    $POLICY: policy,
    $BUNDLE: bundle,
  };

  for (const directory of scopeCase.setup.dirs ?? []) {
    mkdirSync(expand(directory, roots, worktree), { recursive: true });
  }
  for (const file of scopeCase.setup.files ?? []) {
    const path = expand(file, roots, worktree);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture\n");
  }
  for (const symbolicLink of scopeCase.setup.symlinks ?? []) {
    const linkPath = expand(symbolicLink.link, roots, worktree);
    mkdirSync(dirname(linkPath), { recursive: true });
    const target = symbolicLink.target.startsWith("$")
      ? expand(symbolicLink.target, roots, worktree)
      : symbolicLink.target;
    symlinkSync(target, linkPath);
  }

  const declaredScope: ScopeDeclaration[] = scopeCase.declared_scope.map((declaration) => ({
    path: declaration.path,
    changeKind: declaration.change_kind,
    directory: declaration.directory,
    ...(declaration.from_path === undefined ? {} : { fromPath: declaration.from_path }),
  }));
  const rawOperation = scopeCase.operation;
  const operation: ScopeOperation = rawOperation.kind === "rename" || rawOperation.kind === "link"
    ? {
        kind: rawOperation.kind,
        sourcePath: rawOperation.source_path ?? "",
        destinationPath: rawOperation.destination_path ?? "",
        directory: rawOperation.directory,
      }
    : {
        kind: rawOperation.kind,
        path: rawOperation.path ?? "",
        directory: rawOperation.directory,
      };
  return {
    container,
    input: {
      worktreeRoot: expand(scopeCase.worktree_root ?? "$WORKTREE", roots, worktree),
      authorizedRoot: expand(scopeCase.authorized_root ?? "$WORKTREE", roots, worktree),
      reservedRoots: (scopeCase.reserved_roots ?? ["$STATE", "$POLICY", "$BUNDLE"])
        .map((path) => expand(path, roots, worktree)),
      declaredScope,
      operation,
    },
  };
}

afterEach(() => {
  while (activeContainers.length > 0) {
    rmSync(activeContainers.pop()!, { recursive: true, force: true });
  }
});

describe("canonical scope contract corpus", () => {
  it("is unique, versioned, and expectation-complete", () => {
    expect(manifest.schema_version).toBe("rickgent-native-policy-corpus/v3");
    expect(manifest.scope_contract.schema_version).toBe("rickgent-canonical-scope-corpus/v1");
    expect(expected.scope_contract.schema_version).toBe(manifest.scope_contract.schema_version);
    expect(expected.scope_contract.required_observations).toEqual(["result", "change_kind"]);
    const ids = manifest.scope_contract.cases.map((scopeCase) => scopeCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(expected.scope_contract.manifest_case_count);
    for (const scopeCase of manifest.scope_contract.cases) {
      expect(scopeCase.id).toMatch(/^scope-/);
      expect(["ALLOW", "DENY", "ABSTAIN"]).toContain(scopeCase.expected_result);
      expect(scopeCase.setup).toBeTypeOf("object");
      expect(Array.isArray(scopeCase.declared_scope)).toBe(true);
    }
  });

  for (const scopeCase of manifest.scope_contract.cases) {
    it(scopeCase.id, () => {
      const materialized = materialize(scopeCase);
      const verdict = checkStructuredScope(materialized.input);
      expect(
        { result: verdict.result, change_kind: verdict.changeKind },
        verdict.result === "DENY" ? verdict.reason : undefined,
      ).toEqual({
        result: scopeCase.expected_result,
        change_kind: scopeCase.expected_change_kind,
      });
    });
  }

  it("rejects endpoints that do not match operation cardinality", () => {
    const container = realpathSync(mkdtempSync(join(tmpdir(), "rickgent-scope-shape-")));
    activeContainers.push(container);
    const worktree = join(container, "worktree");
    mkdirSync(join(worktree, "owned"), { recursive: true });
    writeFileSync(join(worktree, "owned", "old.txt"), "old\n");
    const base = {
      worktreeRoot: worktree,
      authorizedRoot: worktree,
      reservedRoots: [],
      declaredScope: [{ path: "owned", changeKind: "modify", directory: true }] as const,
    };

    expect(checkStructuredScope({
      ...base,
      operation: {
        kind: "modify",
        path: "owned/old.txt",
        directory: false,
        sourcePath: "owned/old.txt",
      } as ScopeOperation,
    }).result).toBe("DENY");
    expect(checkStructuredScope({
      ...base,
      operation: {
        kind: "rename",
        sourcePath: "owned/old.txt",
        destinationPath: "owned/new.txt",
        directory: false,
        path: "owned/old.txt",
      } as ScopeOperation,
    }).result).toBe("DENY");
  });
});
