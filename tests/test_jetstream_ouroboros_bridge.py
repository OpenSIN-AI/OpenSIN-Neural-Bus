# ==============================================================================
# OpenSIN Neural Bus - JetStream Ouroboros Bridge Tests
# ==============================================================================
#
# DESCRIPTION:
# These tests verify that JetStream/OpenCode event envelopes can be mirrored into
# durable Ouroboros memory without an operator re-entering the same lesson or
# capability metadata manually.
# ==============================================================================

import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from sdk.python.ouroboros import OuroborosDNA


class JetStreamOuroborosBridgeTests(unittest.TestCase):
    def test_apply_event_envelope_remembers_lessons_and_registers_capabilities(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            dna = OuroborosDNA(
                db_path=Path(temp_dir) / "ouroboros.sqlite",
                auto_migrate_legacy=False,
            )

            result = dna.apply_event_envelope(
                {
                    "kind": "memory.lesson.learned",
                    "payload": {
                        "agentId": "a2a-sin-hermes",
                        "context": "JetStream restart recovery",
                        "lesson": "Reuse the durable consumer name after restart.",
                        "successRate": 1.0,
                    },
                    "ouroboros": {
                        "registerCapability": {
                            "capability": "jetstream-runtime",
                            "path": "/srv/mcp/jetstream-runtime.py",
                            "synthesizedBy": "a2a-sin-hermes",
                        }
                    },
                }
            )

            lessons = dna.recall_lessons("JetStream restart")
            capabilities = dna.list_capabilities()

            self.assertEqual(result["remembered_lessons"], 1)
            self.assertEqual(result["registered_capabilities"], 1)
            self.assertEqual(lessons[0]["lesson_learned"], "Reuse the durable consumer name after restart.")
            self.assertEqual(capabilities[0]["capability_name"], "jetstream-runtime")


if __name__ == "__main__":
    unittest.main()
