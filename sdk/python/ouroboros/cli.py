# ==============================================================================
# OpenSIN Neural Bus - Ouroboros CLI
# ==============================================================================
#
# DESCRIPTION:
# Machine-readable CLI wrapper around the OuroborosDNA class.
#
# WHY:
# The TypeScript bridge and OpenCode plugin need a stable subprocess interface for
# capability lookups, lesson recall, and context-packet construction.
#
# CONSEQUENCES:
# Every subcommand prints a single JSON object on stdout and exits non-zero if
# argument parsing or runtime execution fails.
# ==============================================================================

from __future__ import annotations

import argparse
import json
from typing import Any

# The CLI must work both as `python -m ouroboros.cli` and as a direct script path
# invoked by the Node bridge. The fallback import keeps both entry modes alive.
try:
    from .memory import OuroborosDNA
except ImportError:  # pragma: no cover - exercised implicitly by the Node bridge.
    from memory import OuroborosDNA


def build_parser() -> argparse.ArgumentParser:
    """Construct the parser and all supported subcommands."""

    parser = argparse.ArgumentParser(description="OpenSIN Ouroboros JSON CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    register_capability = subparsers.add_parser("register-capability")
    register_capability.add_argument("--db-path", default=None)
    register_capability.add_argument("--capability", required=True)
    register_capability.add_argument("--path", required=True)
    register_capability.add_argument("--agent", required=True)

    query_capabilities = subparsers.add_parser("query-capabilities")
    query_capabilities.add_argument("--db-path", default=None)
    query_capabilities.add_argument("--keyword", default="")
    query_capabilities.add_argument("--limit", type=int, default=20)

    query_lessons = subparsers.add_parser("query-lessons")
    query_lessons.add_argument("--db-path", default=None)
    query_lessons.add_argument("--keyword", default="")
    query_lessons.add_argument("--limit", type=int, default=5)

    build_context = subparsers.add_parser("build-context-packet")
    build_context.add_argument("--db-path", default=None)
    build_context.add_argument("--prompt", required=True)
    build_context.add_argument("--limit", type=int, default=5)
    build_context.add_argument("--token-budget", type=int, default=400)
    build_context.add_argument("--min-score", type=float, default=0.2)

    remember_lesson = subparsers.add_parser("remember-lesson")
    remember_lesson.add_argument("--db-path", default=None)
    remember_lesson.add_argument("--agent-id", required=True)
    remember_lesson.add_argument("--context", required=True)
    remember_lesson.add_argument("--lesson", required=True)
    remember_lesson.add_argument("--success-rate", type=float, default=1.0)

    return parser


def execute_command(args: argparse.Namespace) -> dict[str, Any]:
    """Route parsed arguments into OuroborosDNA and wrap the result."""

    dna = OuroborosDNA(db_path=args.db_path)

    if args.command == "register-capability":
        return {
            "capability": dna.register_capability(
                capability=args.capability,
                path=args.path,
                agent=args.agent,
            )
        }

    if args.command == "query-capabilities":
        return {
            "capabilities": dna.query_capabilities(keyword=args.keyword, limit=args.limit)
        }

    if args.command == "query-lessons":
        return {
            "lessons": dna.recall_lessons(context_keyword=args.keyword, limit=args.limit)
        }

    if args.command == "build-context-packet":
        return {
            "packet": dna.build_context_packet(
                prompt=args.prompt,
                limit=args.limit,
                token_budget=args.token_budget,
                min_score=args.min_score,
                debug=False,
            )
        }

    if args.command == "remember-lesson":
        return {
            "lesson": dna.remember_lesson(
                agent_id=args.agent_id,
                context=args.context,
                lesson=args.lesson,
                success_rate=args.success_rate,
            )
        }

    raise ValueError(f"Unsupported command: {args.command}")


def main() -> None:
    """Parse args, execute, and print a single JSON object."""

    parser = build_parser()
    args = parser.parse_args()
    result = execute_command(args)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
