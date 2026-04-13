# ==============================================================================
# OpenSIN Neural Bus - OpenCode Ouroboros Context Bridge
# ==============================================================================
#
# DESCRIPTION:
# This file is the thin command-line bridge between the OpenCode plugin runtime
# and the Python Ouroboros retrieval layer. The plugin sends a JSON payload to
# stdin, this script resolves the relevant lessons, and then returns a JSON
# packet that can be injected into the active OpenCode system context.
#
# WHY:
# The procedural memory storage already lives in Python. Keeping ranking and
# token-budget trimming close to the SQLite layer prevents duplicated retrieval
# logic in the plugin, keeps the behavior deterministic, and makes testing
# simpler.
#
# CONSEQUENCES:
# - The OpenCode plugin can stay very small and mostly orchestration-focused.
# - Any future consumers besides OpenCode can reuse the same JSON bridge.
# ==============================================================================

from __future__ import annotations

import json
import sys
from typing import Any, Dict

from memory import OuroborosDNA


def _read_payload() -> Dict[str, Any]:
    """Read a JSON payload from stdin and normalize missing fields."""

    raw_stdin = sys.stdin.read().strip()
    if not raw_stdin:
        return {}
    return json.loads(raw_stdin)


def _build_packet(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Translate the OpenCode hook payload into a retrieval request."""

    dna = OuroborosDNA(db_path=payload.get("db_path", "/tmp/ouroboros_dna.sqlite"))
    return dna.build_context_packet(
        prompt=str(payload.get("prompt", "")),
        max_lessons=int(payload.get("max_lessons", 5)),
        token_budget=int(payload.get("token_budget", 400)),
        min_score=float(payload.get("min_score", 0.2)),
        debug=bool(payload.get("debug", False)),
    )


def main() -> int:
    """Process stdin JSON and print the retrieval packet to stdout."""

    try:
        payload = _read_payload()
        packet = _build_packet(payload)
        sys.stdout.write(json.dumps(packet))
        return 0
    except Exception as exc:  # pragma: no cover - exercised indirectly via plugin tests.
        error_packet = {
            "injected": False,
            "injected_text": "",
            "lessons": [],
            "error": str(exc),
        }
        sys.stdout.write(json.dumps(error_packet))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
