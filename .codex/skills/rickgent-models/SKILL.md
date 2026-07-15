---
name: rickgent-models
description: "View, edit, and validate the model roster that controls multi-vendor routing in rickgent. Use when the user needs to configure which AI models rickgent dispatches to."
metadata:
  short-description: "Rickgent model roster configurator"
---

# Rickgent Model Configurator

Help the user view, edit, and validate the model roster that controls multi-vendor routing.

## Roster Format

JSON array of model entries:

```json
[
  {"harness": "claude", "model": "claude-sonnet-4-20250514", "vendor": "anthropic", "tier": "mid", "pricing": {"cost_per_dispatch": 0.05}},
  {"harness": "codex", "model": "gpt-4o", "vendor": "openai", "tier": "capable", "pricing": {"cost_per_dispatch": 0.12}}
]
```

| Field | Type | Description |
|---|---|---|
| `harness` | string | omnigent harness name (`claude`, `codex`, `grok`, etc.) |
| `model` | string | Model identifier passed to the harness |
| `vendor` | string | Vendor name (used for cross-vendor review exclusion) |
| `tier` | `"cheap"` \| `"mid"` \| `"capable"` | Cost band for role-based routing |
| `pricing` | `{ cost_per_dispatch: number }` \| `null` | Per-dispatch cost in USD; `null` = unpriced (skipped) |

### Routing Rules

- **Cross-vendor review:** `code_review` role excludes implementer's vendor. One vendor only → DENY (fail-closed).
- **Tier by role:** research/review/simplify → `cheap`; plan/conformance/review → `mid`; implement → `capable`.
- **Cost gate:** unpriced (`null`) skipped; over `cost_budget_usd` skipped; over `soft_threshold_usd` → ASK.
- **Fail-closed:** empty roster or no candidates after constraints → DENY.

## Step 1: Show Current Roster

```bash
echo "${RICKGENT_MODEL_ROSTER:-<not set>}"
ls -la .rickgent/roster.json 2>/dev/null || echo "No roster file"
```

If a roster exists, display as a table: harness, model, vendor, tier, cost/dispatch.

## Step 2: Configure

Based on `$ARGUMENTS`:

- **"add"** — Ask for harness, model, vendor, tier, cost. Validate tier is `cheap`/`mid`/`capable`. Warn if vendor already exists (need 2+ vendors for cross-vendor review).
- **"remove"** — Remove by model name or vendor+harness.
- **"list"** or no args — Show current roster (Step 1).
- **"validate"** — Check: 2+ vendors, at least one `capable` (for implement), one `cheap`/`mid` (for research), all entries have non-null pricing, all harnesses are valid omnigent harness names.

## Step 3: Write

```bash
cat > .rickgent/roster.json << 'EOF'
<roster json>
EOF
```

Usage:
```bash
rickgent build prd.md --repo "$(pwd)" --roster .rickgent/roster.json   # option A: file
export RICKGENT_MODEL_ROSTER="$(cat .rickgent/roster.json)"            # option B: env var
```

## Step 4: Verify

```bash
cd rickgent-policies && python3 -c "
from rickgent_policies import select_model
import json
roster = json.load(open('../.rickgent/roster.json'))
for role in ['research', 'implement', 'code_review']:
    v = select_model(roster, role, implementer_vendor=roster[0]['vendor'] if roster else None)
    print(f'{role}: {v}')
"
```

If any role returns `DENY`, explain why and suggest fixes (add a second vendor, add a model in the missing tier, or add pricing).
