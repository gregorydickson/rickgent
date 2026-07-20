#!/usr/bin/env python3
"""One-off M0 reconciliation: mark t00-t21 Done with completed_at evidence.

Reads docs/remediation/trust-spine-manifest.json, sets status="Done" for every
ticket t00..t21, and attaches a completed_at object referencing the owning
commit SHA and the closest phase-report path. Tickets t22+ are left unchanged.

Run once from the repo root:
    python3 orchestrator/scripts/reconcile-m0-manifest.py
"""
from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
MANIFEST = REPO / "docs/remediation/trust-spine-manifest.json"

# Phase-report paths.
PHASE_0 = "docs/remediation/phase-0-baseline-manifest-reconcile-execution-report-2026-07-20.md"
PHASE_1 = "docs/remediation/phase-1-containment-execution-report-2026-07-15.md"
PHASE_2 = "docs/remediation/phase-2-native-policy-execution-report-2026-07-16.md"
PHASE_4_STATE_BRIDGE = "docs/remediation/phase-4-attempt-runner-state-bridge-report-2026-07-18.md"
PHASE_4_PROCESS = "docs/remediation/phase-4-process-supervisor-execution-report-2026-07-17.md"
PHASE_4_COMMIT = "docs/remediation/phase-4-commit-attribution-execution-report-2026-07-17.md"
PHASE_4_SALVAGE = "docs/remediation/phase-4-salvage-cleanup-execution-report-2026-07-18.md"

# ticket_id -> (commit_sha, phase_report)
EVIDENCE = {
    "t00": ("9c0d47f3a5f9b2bb863bfd84e5edb887d71f7ea0", PHASE_0),
    "t01": ("8738fa02f2b2403c5e63f20b6baf8aab2c31a8ba", PHASE_0),
    "t02": ("7f55ac1d3ee5505b60846d021df0bc9356f12fba", PHASE_0),
    "t03": ("e1499f3cf5a2cf322b9367a38e3008f67684de5a", PHASE_1),
    "t04": ("092f4f3909f09dafa1cae976e6cc6d67f8fdb82f", PHASE_1),
    "t05": ("8b3f28c4c9b67f894e3b88076d3e91a9b76aa2e9", PHASE_1),
    "t06": ("3690f8c638aa0c733d0dd6d7cd61b6ad4b2d6bd9", PHASE_1),
    "t07": ("4b1bb22c7eba09fe7e9af364a036cc56ede60d1e", PHASE_1),
    "t08": ("827eec9eedc0999357d8c4d3e5f58f388e27d98b", PHASE_2),
    "t09": ("a1cc3cecb15d89e9f4de78c96c33e81a8cb9df00", PHASE_2),
    "t10": ("dd6ee0d65a10bf22be88c12464f8f5897131ca2c", PHASE_2),
    "t11": ("1e97d9b3fc0249aa76bf7dca8f0b967e01c4d6ec", PHASE_2),
    "t12": ("92b2c4fa9f5da73371ee74e97b5d0153224dc4d0", PHASE_0),
    "t13": ("5649db56d165a902495dc3ed6876f26e3929e616", PHASE_0),
    "t14": ("b7d11cf644b28b1f77bea41573478d04ba4bb476", PHASE_0),
    "t15": ("cf9073c8f6a21e38bad7a7a70053162713f45f13", PHASE_0),
    "t16": ("7a402bbd8f6b59a0ff00e1ea335b043ca0b42bbe", PHASE_0),
    "t17": ("1cecbfe74c9ef25285a4783c8b5f7270971301b0", PHASE_0),
    "t18": ("5590ca2579f1ecb82c13de8b269a8abde84d1009", PHASE_4_STATE_BRIDGE),
    "t19": ("35ab3f78b5d114ac457452d91c7ff0ce9d5ffe6f", PHASE_4_PROCESS),
    "t20": ("78420f03e352759338b0016578edfc4e4f5e522d", PHASE_4_COMMIT),
    "t21": ("efcf32c5dc5fda6e8a45550d0050bb9e11a6d2c0", PHASE_4_SALVAGE),
}


def main() -> int:
    data = json.loads(MANIFEST.read_text())
    updated = 0
    for ticket in data["tickets"]:
        tid = ticket["id"]
        if tid not in EVIDENCE:
            continue
        commit, report = EVIDENCE[tid]
        ticket["status"] = "Done"
        ticket["completed_at"] = {"commit": commit, "phase_report": report}
        updated += 1
    MANIFEST.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"reconcile-m0-manifest: updated {updated} tickets (t00-t21) to Done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
