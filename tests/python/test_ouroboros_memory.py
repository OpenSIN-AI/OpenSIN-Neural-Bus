# ==============================================================================
# OpenSIN Neural Bus - Tests for Ouroboros procedural memory recall
# ==============================================================================
#
# DESCRIPTION:
# These tests verify the deterministic retrieval pipeline that powers automatic
# OpenCode context injection.
#
# WHY:
# Issue #5 requires proof that lesson recall is relevant, deduplicated, and
# token-budget aware. These tests lock in that behavior at the Python layer.
# ==============================================================================

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

# The repository does not ship as an installed Python package in CI, so the test
# adds the SDK directory explicitly. This keeps the test self-contained and
# avoids assuming global Python environment state.
REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON_SDK_DIR = REPO_ROOT / "sdk" / "python" / "ouroboros"
sys.path.insert(0, str(PYTHON_SDK_DIR))

from memory import OuroborosDNA  # noqa: E402


class OuroborosMemoryTests(unittest.TestCase):
    """Regression tests for ranked lesson recall and context packet building."""

    def setUp(self) -> None:
        # Each test gets a dedicated SQLite file so ranking and trimming checks do
        # not leak state across test cases.
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "ouroboros.sqlite"
        self.dna = OuroborosDNA(str(self.db_path))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_build_context_packet_ranks_deduplicates_and_trims(self) -> None:
        """Relevant lessons should win, duplicates should disappear, and the packet must honor the budget."""

        self.dna.remember_lesson(
            "SIN-Builder",
            "OpenCode plugin context injection and ranking",
            "Cache the latest user prompt from OpenCode message events before the system-transform hook runs.",
            0.95,
        )
        self.dna.remember_lesson(
            "SIN-Builder",
            "OpenCode plugin context injection and ranking",
            "Cache the latest user prompt from OpenCode message events before the system-transform hook runs.",
            0.80,
        )
        self.dna.remember_lesson(
            "SIN-Builder",
            "OpenCode plugin token budget trimming",
            "Trim recalled lessons against a strict token budget before adding them to system context.",
            0.92,
        )
        self.dna.remember_lesson(
            "SIN-Builder",
            "Unrelated browser automation",
            "Use browser automation only when a browser task truly exists.",
            0.99,
        )

        packet = self.dna.build_context_packet(
            "Need OpenCode plugin ranking and token budget context injection for procedural memory.",
            max_lessons=4,
            token_budget=150,
            debug=True,
        )

        self.assertTrue(packet["injected"])
        self.assertLessEqual(packet["estimated_injected_tokens"], 150)
        self.assertEqual(packet["selected_count"], 2)
        self.assertEqual(len(packet["lessons"]), 2)
        self.assertIn("OpenCode plugin context injection and ranking", packet["injected_text"])
        self.assertIn("token budget", packet["injected_text"].lower())
        self.assertTrue(all(lesson["reasons"] for lesson in packet["lessons"]))

        normalized_lessons = {lesson["lesson_learned"] for lesson in packet["lessons"]}
        self.assertEqual(len(normalized_lessons), 2)
        self.assertNotIn("Use browser automation only when a browser task truly exists.", normalized_lessons)

    def test_search_lessons_returns_empty_for_blank_prompt(self) -> None:
        """Blank prompts should not produce fake recalls."""

        self.dna.remember_lesson(
            "SIN-Builder",
            "OpenCode plugin context injection and ranking",
            "Always keep the retrieval pipeline deterministic.",
            1.0,
        )

        self.assertEqual(self.dna.search_lessons("   "), [])


if __name__ == "__main__":
    unittest.main()
