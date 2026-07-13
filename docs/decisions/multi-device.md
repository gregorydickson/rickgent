# Decision: Multi-Device

## Component
§2 matrix row: Multi-Device — how the system is observed and controlled from different devices/form factors (web dashboard, desktop app, mobile, CLI status).

## Omnigent implementation
Omnigent is a real FastAPI server with a React web UI and iOS/Android/Electron shell clients. The server is defined in `omnigent/server/app.py` (2,614 LOC). Routes are hardcoded via `app.include_router(...)` calls in `create_app` (`app.py`): `create_builtin_agents_router`, `create_comments_router`, `create_default_policies_router`, `create_harnesses_router`, `create_policy_registry_router`, `create_runner_tunnel_router`, `create_session_mcp_servers_router`, `create_session_policies_router`, `create_sessions_router`, `create_sharing_router`, `create_terminal_attach_router` (all imported at `app.py:44-66`). There are 13+ `app.include_router(...)` calls — the route set is fixed at server construction time.

The plugin system (`harness_plugins.py:100-193`) extends harnesses only (new `NativeCodingAgent` registrations). An external package cannot add a dashboard route: there is no route plugin mechanism, no `extra_routes` parameter in `create_app`, and the router factories are all imported from `omnigent.server.routes.*` at module load time. Policy modules can be extended via `policy_modules` config (`app.py:1320`, `cli.py:3164`), but that extends the policy registry, not the HTTP route table.

The server binds a host/port (`cli.py:~3160` `click.echo(f"Starting omnigent server on {host}:{port}")`) and serves the web UI via `StaticFiles` (`app.py` imports `StaticFiles`). Mobile/desktop shells connect to the same server.

## Pickle Rick implementation
Pickle Rick's UI is a tmux-based TUI living in the extension directory: `monitor.js`, `log-watcher.js`, `morty-watcher.js`, and `raw-morty.js` (per the architecture table in `pickle-rick-claude/CLAUDE.md`). These render Matrix-styled panes attached to tmux sessions. There is no HTTP server, no web UI, no mobile client. Observation is local-only: you must be on the host machine with a tmux client attached. The `metrics.js` + `metrics-utils.js` reporters write to a cache file (`~/.claude/pickle-rick/metrics-cache.json`) but have no network surface.

## Contract
The multi-device component must: (1) provide a way to observe running sessions and their status from any device, (2) allow control actions (start/stop/inspect) remotely, (3) surface session trees, labels, and worker progress. Invariants: the observation surface is network-accessible, not just local tmux; the server is the single source of truth for session state. Failure modes: server unreachable, route not found, stale UI state. Deferred for v0.1: a custom dashboard with Rickgent-specific visualizations.

## Evaluation
Omnigent is better for Rickgent's goals. A real FastAPI server with a React web UI means you can monitor sessions from a phone, a laptop, or a remote browser. Pickle Rick's tmux TUI requires SSH + tmux on the host — it is single-device by construction. However, Omnigent's routes are hardcoded: the 13+ `include_router` calls in `create_app` are fixed, and the plugin system extends harnesses only. A custom Rickgent dashboard (e.g., a route showing ticket-level progress, convergence metrics, or scope-drift visualizations) cannot be added by an external package — it requires forking the server. This makes a custom dashboard the second fork trigger (after the policy event vocabulary, if needed).

For v0.1, Rickgent's visibility needs are modest: session tree + labels + `rickgent status` over `registry.json`. These are satisfiable with Omnigent's existing session routes and a CLI status command, without any custom dashboard route.

## §2.1.1 Finding
ADOPT — "CONFIRMED, dashboard deferred. Server routes are hardcoded; the plugin system extends harnesses only. An external package cannot add a dashboard route. v0.1 visibility = session tree + labels + `rickgent status` over registry.json." Evidence: `app.py:44-66` (13+ hardcoded `include_router` calls in `create_app`), `harness_plugins.py:100-193` (plugin system is harness-only), `app.py:1320` / `cli.py:3164` (`policy_modules` extends policy registry, not routes).

## Decision: reuse
Reuse Omnigent's server + web UI, with a deferred custom dashboard. A custom dashboard is fork trigger #2.

## Reasoning
Rickgent needs multi-device observability from day one — an operator should be able to check on a long-running multi-model session from their phone. Omnigent already provides this: FastAPI server, React web UI, iOS/Android/Electron shells. Pickle Rick's tmux TUI is strictly local and cannot be extended to remote devices without building an entirely new server. Reusing Omnigent gives us network-accessible session trees, labels, and terminal attach for free. The hardcoded route table is a limitation, but not a v0.1 blocker: the existing sessions, comments, and terminal-attach routes cover Rickgent's visibility needs. When Rickgent needs a custom dashboard route (e.g., convergence metrics, scope-drift visualization), that becomes fork trigger #2 — the point at which extending Omnigent via an external package is no longer sufficient and we fork the server. Until then, `rickgent status` over `registry.json` plus the stock web UI is the plan.

## Countersign

- **Reviewer:** GPT-5.6-sol (Codex)
- **Verdict:** APPROVED_WITH_NOTES
- **Spot-checks performed:** `omnigent/server/app.py:60-75,1994-2102` shows fixed route factories and registrations; `extension/src/bin/monitor.ts:1-45` is terminal/tmux-oriented.
- **Notes:** The cited `app.py:44-66` is imports, not registrations; the construct is later in the same file.
- **Date:** 2026-07-12
