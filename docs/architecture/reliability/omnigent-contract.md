# Omnigent compatibility and observation contract

Status: current-compatible external contract, schema `1.0.0`.

Machine authority: `artifacts/reliability/omnigent-compatibility-contract.json`.

Offline compatibility proof: `orchestrator/scripts/verify-omnigent-contract.mjs` plus `orchestrator/scripts/omnigent-contract-probe.py`.

## Decision

Omnigent is an evolving external system. Rickgent does not pin a sibling Git
commit and does not infer compatibility from a package version. It discovers a
mounted source root through `OMNIGENT_ROOT`, executes the probe with the
interpreter selected by `OMNIGENT_PYTHON`, verifies that imports resolve under
that root, and accepts the runtime only when every required behavioral probe
passes. A different reported Omnigent version is compatible when the behavior
passes; the same reported version is incompatible when the behavior fails.

Missing discovery inputs, a different import origin, and incompatible behavior
are non-skipping pre-dispatch failures. Production must invoke Omnigent through
the same selected Python module origin. A PATH lookup for `omnigent` is not
evidence that the verified code will execute.

The offline command is:

```sh
node orchestrator/scripts/verify-omnigent-contract.mjs \
  --root "$OMNIGENT_ROOT" \
  --python "$OMNIGENT_PYTHON" \
  --contract artifacts/reliability/omnigent-compatibility-contract.json
```

The command is argv-only, uses no shell, denies network operations in the
Python probe, creates fixtures only in an operating-system temporary directory,
and does not mutate the Omnigent checkout. It compares its normalized output to
the committed deterministic result artifact. `--write-result` exists only for a
deliberate contract review after a compatible ABI change; ordinary verification
is non-mutating.

## FunctionPolicy ABI

Rickgent consumes the current native FunctionPolicy shape:

```text
policy(event, config)

event = {
  type,
  target,
  data,
  context,
  session_state,
  llm_client,
  request_data?
}
```

The six phase values are `request`, `tool_call`, `tool_result`, `response`,
`llm_request`, and `llm_response`. A tool call uses the tool name as `target`
and `{name, arguments}` as `data`. A tool result uses `{result}` as `data` and
the original `{name, arguments}` as `request_data`.

`guardrails.policies.<name>.config` is copied to the evaluator's second
argument. `function.arguments` is different: it is passed once to a factory
that constructs the evaluator. Function-policy `on:` selectors are not applied
by the engine, so every function policy must explicitly classify every phase.
A well-formed unrelated event returns explicit `ALLOW`, which is the native
encoding of abstention. Missing or malformed required data does not count as an
unrelated event and fails closed.

Although the current parser accepts any mapping, Rickgent restricts policy
config to string keys and string values. It uses config only for versioned file
references, digests, the dispatch identifier, and receipt paths. Lists,
booleans, and structured execution authority do not travel inline in config.

FunctionPolicy preserves `result`, `reason`, `data`, `state_updates`, and
`set_labels`. It discards an extra `code` mapping key. Stable Rickgent denial
codes therefore begin the reason, for example:

```text
RICKGENT_CONTEXT_INTEGRITY_FAILED: attempt context digest did not match
```

The same code is stored in a Rickgent-owned receipt. Policy exceptions and
invalid return shapes become DENY inside the Omnigent engine.

Additive, non-authoritative event fields are tolerated. Unknown phases,
unknown tools on governed tool phases, malformed required fields, duplicate or
conflicting identity, and unknown Rickgent ABI/context versions deny.

## Authoritative attempt context

Agent-controlled event data, including `event.context`, is never authority for
repository roots, run/ticket/attempt identity, phase, scope, budgets, role, or
selected model identity.

Before spawn, the orchestrator writes a fresh attempt context outside both the
target worktree and the source worker template. Its directory is mode `0700`
and its regular file is mode `0600`. The attempt-specific materializer copies
the worker bundle outside the target worktree and injects string config
containing the context path and SHA-256 digest, owner-token digest, lease and
receipt paths, ABI version, and dispatch identifier.

Policy code must:

1. require an absolute path beneath the canonical trusted state root;
2. reject symlink components and open with no-follow semantics;
3. verify the opened file is regular, owned by the orchestrator UID, mode
   `0600`, and at most the contracted size;
4. hash the opened raw bytes before parsing JSON;
5. reject duplicate JSON keys and unsupported schema/ABI versions;
6. compare dispatch ID, owner-token digest, attempt binding, canonical roots,
   ticket digest, and active lease; and
7. ignore conflicting copies in event data, prompts, transcripts, environment
   controlled by the worker, and router/ledger labels.

Repeated policy events within the same active attempt are normal, not replay.
Use with a different dispatch or owner token, nonce reuse by a new dispatch, or
use after lease closure is replay and denies.

Mode `0600` does not authenticate against an arbitrary process running as the
same operating-system user. This contract depends on capability isolation: the
worker has no raw shell and its structured writes cannot target the state root.
Adding HMAC material or an unpinned public key to the same bundle would not
repair a same-UID arbitrary-process threat.

Current FunctionPolicy does not expose its engine `conversation_id` to the
callable. Until that seam evolves, attempt-to-session binding is the combination
of a unique materialized bundle, a unique isolated Omnigent data directory, an
active owner-token lease, and exactly one newly observed root conversation. A
requirement for cryptographic per-conversation binding makes the current ABI
incompatible rather than inviting an inferred ID.

## Requested, invoked, and observed identity

Identity has separate producers:

- Requested: the router decision embedded in immutable attempt context.
- Invoked: actual array argv and the exact materialized bundle/config digest.
- Observed conversation: exactly one new root row in the isolated Omnigent
  `chat.db`—`parent_conversation_id IS NULL` and
  `root_conversation_id = id`.
- Observed harness: Omnigent's effective session harness or the effective
  session-scoped materialized bundle. For generic SDK harnesses this is
  effective runtime configuration, not an independently emitted harness field.
- Observed model: `llm_response` policy `event.data.usage.model`, corroborated
  by `session_usage.by_model`. Current Omnigent may populate this from a
  harness report or fall back to configured identity and exposes no provenance
  bit.
- Observed provider/vendor: unavailable generically in the current ABI.

Transcript prose and copied router or ledger labels are never observations.
The current `effective-session-v1` profile is useful structural evidence, but
cannot activate strict identity completion or cross-vendor claims.

`runtime-reported-identity-v1` remains unavailable until a separate protected
live probe proves a non-config-derived model receipt, proves provider identity
or a single-vendor harness, and produces separate implementer and reviewer
receipts. The offline compatibility probe cannot activate it.

Raw identity values are retained. Canonicalization uses only the explicit,
versioned alias corpus in the machine contract. Rickgent does not heuristically
strip provider prefixes or rewrite model IDs. Requested, invoked, and observed
identity must be exactly equal after that explicit normalization.

## Reviewer distinction

Independent review requires a reviewer role, a different process, a different
root conversation, read-only tools, immutable diff input, and its own valid
identity receipt. It may use the same effective model and must not be described
as cross-vendor.

Cross-vendor review additionally requires unequal canonical observed vendors
whose receipts both meet an activated live observation profile. A different
process alone or different harness spelling alone is insufficient. A
multi-provider harness without provider observation fails the cross-vendor
gate.

## Failure semantics

Pre-dispatch failures use `OMNIGENT_UNAVAILABLE`,
`OMNIGENT_IMPORT_ORIGIN_MISMATCH`, or `OMNIGENT_ABI_INCOMPATIBLE` and prevent
spawn. Policy failures use the `RICKGENT_*` codes enumerated in the machine
contract and return DENY.

Omnigent's harness bridge fails closed for unavailable request and tool-call
policy evaluation. LLM and tool-result bridge timeouts fail open because those
phases are advisory or the tool has already executed. Rickgent therefore never
uses transport success as identity proof: a missing or conflicting identity
receipt blocks its completion oracle even if a model response already ran.

## Offline versus live proof

The committed offline result proves import origin, parser/config behavior,
factory/config separation, all six native event phases, self-selection,
engine failure conversion, return-key behavior, harness aliases, and session
schema. It is deterministic and contains no absolute local path or reported
runtime version. The verifier prints the runtime version as informational
output only.

It does not prove provider credentials, actual model invocation, provider
identity, a denied tool's non-execution, or cross-vendor reviewer distinction.
Those claims require the separate protected live corpus before their capability
status can change.
