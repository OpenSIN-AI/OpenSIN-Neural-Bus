# ==============================================================================
# OpenSIN Neural Bus - Ouroboros Persistence Tests
# ==============================================================================
#
# DESCRIPTION:
# These tests verify the durable storage, migration, backup/restore, and restart
# persistence behavior required by Issue #6.
#
# WHY:
# The acceptance criteria explicitly require proof that data survives restarts and
# that legacy /tmp databases can be imported into the new durable location.
#
# CONSEQUENCES:
# If these tests fail, the fleet memory layer cannot be considered durable.
# ==============================================================================

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# The repository is not packaged as an installable Python distribution yet, so the
# tests insert the repo root to make `sdk.python.ouroboros` importable directly.
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from sdk.python.ouroboros import OuroborosDNA, default_ouroboros_db_path


# The legacy helper writes the historical schema exactly as the old implementation
# expected it so migration tests prove compatibility rather than a new format.
def create_legacy_database(legacy_path: Path) -> None:
    legacy_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(str(legacy_path)) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS procedural_memory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT NOT NULL,
                task_context TEXT NOT NULL,
                lesson_learned TEXT NOT NULL,
                success_rate REAL,
                timestamp TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS capability_registry (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                capability_name TEXT UNIQUE NOT NULL,
                mcp_path TEXT NOT NULL,
                synthesized_by TEXT NOT NULL,
                timestamp TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            INSERT INTO procedural_memory (
                agent_id,
                task_context,
                lesson_learned,
                success_rate,
                timestamp
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                "legacy-agent",
                "legacy context",
                "legacy lesson",
                0.91,
                "2026-04-10T00:00:00+00:00",
            ),
        )
        connection.execute(
            """
            INSERT INTO capability_registry (
                capability_name,
                mcp_path,
                synthesized_by,
                timestamp
            )
            VALUES (?, ?, ?, ?)
            """,
            (
                "legacy-capability",
                "/srv/legacy/mcp.py",
                "legacy-agent",
                "2026-04-10T00:00:00+00:00",
            ),
        )
        connection.commit()


class OuroborosPersistenceTests(unittest.TestCase):
    def test_default_path_uses_durable_opencode_home(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            fake_home = Path(temp_dir) / "opencode-home"

            # Patching the environment keeps the test hermetic and avoids writing
            # into the operator's real ~/.config/opencode directory.
            with mock.patch.dict(os.environ, {"OPENCODE_HOME": str(fake_home)}, clear=False):
                durable_path = default_ouroboros_db_path()
                dna = OuroborosDNA(auto_migrate_legacy=False)

            self.assertEqual(durable_path, fake_home / "ouroboros" / "ouroboros_dna.sqlite")
            self.assertEqual(Path(dna.db_path), durable_path)
            self.assertTrue(durable_path.exists())
            self.assertNotIn("/tmp/", str(durable_path))

    def test_explicit_legacy_import_moves_data_into_durable_database(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            durable_db = temp_root / "durable" / "ouroboros.sqlite"
            legacy_db = temp_root / "legacy" / "ouroboros_dna.sqlite"
            create_legacy_database(legacy_db)

            dna = OuroborosDNA(
                db_path=str(durable_db),
                legacy_db_path=str(legacy_db),
                auto_migrate_legacy=False,
            )
            migration_result = dna.migrate_legacy_db()

            recalled_lessons = dna.recall_lessons("legacy")
            capabilities = dna.list_capabilities()

            self.assertTrue(migration_result["migrated"])
            self.assertEqual(migration_result["procedural_memory_rows"], 1)
            self.assertEqual(migration_result["capability_registry_rows"], 1)
            self.assertEqual(recalled_lessons[0]["lesson_learned"], "legacy lesson")
            self.assertEqual(capabilities[0]["capability_name"], "legacy-capability")

    def test_data_survives_restart_and_generates_sync_outbox_entries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            durable_db = Path(temp_dir) / "durable" / "ouroboros.sqlite"

            first_instance = OuroborosDNA(db_path=str(durable_db), auto_migrate_legacy=False)
            first_instance.remember_lesson(
                "restart-agent",
                "restart proof",
                "survive the next process start",
                1.0,
            )
            first_instance.register_capability(
                "sync-export",
                "/srv/mcp/sync_export.py",
                "restart-agent",
            )

            # Re-instantiating the class simulates the next process start. If the
            # file path were still in /tmp on an ephemeral host, this would be the
            # place where data loss would surface.
            second_instance = OuroborosDNA(db_path=str(durable_db), auto_migrate_legacy=False)
            recalled_lessons = second_instance.recall_lessons("restart proof")
            capabilities = second_instance.list_capabilities()
            pending_sync_events = second_instance.export_sync_batch(limit=10)

            self.assertEqual(len(recalled_lessons), 1)
            self.assertEqual(recalled_lessons[0]["agent_id"], "restart-agent")
            self.assertEqual(capabilities[0]["capability_name"], "sync-export")
            self.assertEqual(len(pending_sync_events), 2)
            self.assertTrue(all(event["delivered_at"] is None for event in pending_sync_events))

    def test_backup_and_restore_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            source_db = temp_root / "source" / "ouroboros.sqlite"
            backup_db = temp_root / "backup" / "ouroboros.sqlite"
            restored_db = temp_root / "restored" / "ouroboros.sqlite"

            source = OuroborosDNA(db_path=str(source_db), auto_migrate_legacy=False)
            source.remember_lesson("backup-agent", "backup", "backups must restore cleanly", 1.0)
            source.register_capability("backup-capability", "/srv/mcp/backup.py", "backup-agent")
            source.create_backup(str(backup_db))

            restored = OuroborosDNA(db_path=str(restored_db), auto_migrate_legacy=False)
            restore_result = restored.restore_from_backup(str(backup_db), replace_existing=True)

            restored_lessons = restored.recall_lessons("backup")
            restored_capabilities = restored.list_capabilities()

            self.assertTrue(restore_result["restored"])
            self.assertEqual(restored_lessons[0]["lesson_learned"], "backups must restore cleanly")
            self.assertEqual(restored_capabilities[0]["capability_name"], "backup-capability")


if __name__ == "__main__":
    unittest.main()
