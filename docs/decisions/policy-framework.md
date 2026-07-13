# Decision: Policy Framework

## Component
§2 matrix row: Policy Framework — how the system declares, registers, and enforces behavioral policies (scope fences, cost limits, blast radius, lifecycle gates).

## Omnigent implementation
Omnigent has a proper policy framework in `omnigent/policies/`. The core schema (`policies/schema.py`) defines:

- **Policy events**: a closed `Literal` at `schema.py:219-224` — `request|tool_call|tool_result|response|llm_request|llm_response`. No other event types exist or can be introduced by plugins.
- **Verdicts**: `Literal["ALLOW", "DENY", "ASK"]` at `schema.py:294` — policies return one of these three verdicts with a `reason`, `data`, `state_updates`, and `set_labels`.
- **FunctionPolicy factories**: callables that receive a `PolicyEvent` (with `type`, `target`, `data`, `context`, `session_state`, `llm_client`, `request_data`) and return a `PolicyResult`.

Built-in policies live in `policies/builtins/`: `orchestration.py` contains `headless_subagent_purpose_guard` (lines 466-468, enforcing `implement|review|explore|search`), plus `blast_radius`, `spawn_bounds`, and cost policies.

Registry loading: `load_registry(extra_modules=[...])` at `policies/registry.py:68` scans built-in and user-configured modules and populates the singleton registry. It is called at server startup with `policy_modules=cfg.get("policy_modules")` — wired in `cli.py:3164` (CLI server start) and `app.py:1320` (`create_app` lifespan). Modules that fail to import are logged and skipped (a broken module does not prevent startup).

JSON-schema param validation is performed by the registry on every registered policy. CEL (Common Expression Language) is available for declarative policy expressions.

## Pickle Rick implementation
Pickle Rick has no policy framework. Instead, it uses a collection of TypeScript hooks that run as subprocesses at specific lifecycle points:

- `check-scope-diff.ts` (`pickle-rick-claude/extension/src/bin/check-scope-diff.ts`, 201 LOC) — a pre-commit scope fence. It reads `scope.json:allowed_paths`, runs `git diff --staged --name-only`, and exits 1 if any staged path is outside scope. The `isTrapDoorCatalogPath` function (line ~50) exempts `CLAUDE.md` files from the scope check.
- `config-protection.ts` — blocks writes to `state.json`, `pickle_settings.json`, `circuit_breaker.json`, `pipeline-status.json`, and `~/.claude/pickle-rick/**`.
- `tsc-gate.ts` — blocks commits when `npx tsc --noEmit` fails.
- `bash-scanner` — blocks `bash install.sh` from worker context.

These are ad hoc shell-script hooks with no shared schema, no registry, no param validation, and no compositional model. Each hook is a standalone Node script that reads stdin JSON, does its check, and exits with a code.

## Contract
The policy framework must: (1) provide a closed vocabulary of lifecycle events, (2) allow policies to be registered and composed, (3) validate policy parameters against a schema, (4) return a verdict (allow/deny/ask) with a reason, (5) support both declarative (CEL) and programmatic (FunctionPolicy) policy definitions. Invariants: the event vocabulary is closed — no new event types can be introduced; every policy returns a verdict from `{ALLOW, DENY, ASK}`; a broken policy module does not prevent startup. Failure modes: policy module import failure (logged and skipped), policy timeout, policy returning an invalid verdict.

## Evaluation
Omnigent is strictly better for Rickgent's goals. It has a real framework: closed event vocabulary (`schema.py:219-224`), three-valued verdicts (`schema.py:294`), a registry with JSON-schema param validation (`registry.py:68`), CEL for declarative policies, and FunctionPolicy factories for programmatic ones. Lifecycle gates (scope fence, config protection, tsc gate) can be modeled as `tool_call` policies on rickgent-owned tools — no new event types are needed. Pickle Rick's hooks are bash-scanning scripts with no shared schema, no composition, and no registry. They work for Pickle Rick's single-process model but cannot scale to a multi-session, multi-model orchestrator.

## §2.1.1 Finding
ADOPT — "CONFIRMED, closed event vocabulary. Lifecycle gates are modeled as `tool_call` policies on rickgent-owned tools. No new event types needed." Evidence: `schema.py:219-224` (closed `Literal` of 6 event types), `schema.py:294` (verdicts `ALLOW|DENY|ASK`), `registry.py:68` (`load_registry(extra_modules=[...])`), `cli.py:3164` and `app.py:1320` (`policy_modules` wired at startup), `orchestration.py:466-468` (`headless_subagent_purpose_guard` as a FunctionPolicy factory). The event vocabulary is closed by construction (Python `Literal` type); plugins extend the policy registry, not the event set.

## Decision: reuse
Reuse Omnigent's policy framework — proper framework, no bash scanning.

## Reasoning
Rickgent needs composable, validated policies for scope fencing, cost limits, blast radius, and lifecycle gates. Omnigent already has all of this: the `policies/` package with its closed event vocabulary, three-valued verdicts, JSON-schema param validation, CEL, and FunctionPolicy factories. The `headless_subagent_purpose_guard` (`orchestration.py:466-468`) is a direct example of how to enforce a closed set of work types — exactly what Rickgent needs for its dispatch guards. Pickle Rick's hooks (`check-scope-diff.ts`, `config-protection.ts`, `tsc-gate.ts`, `bash-scanner`) are each 100-200 LOC of standalone Node script with no shared infrastructure. Porting them would mean rebuilding the policy registry, schema validation, and event model that Omnigent already provides. Instead, each Pickle Rick hook maps to an Omnigent `tool_call` policy: scope fence → policy on `git_commit` tool, config protection → policy on `file_write` tool, tsc gate → policy on `commit` tool. The `policy_modules` config (`cli.py:3164`, `app.py:1320`) lets Rickgent register its own policy module without forking. No mash needed; reuse is the clean path.
