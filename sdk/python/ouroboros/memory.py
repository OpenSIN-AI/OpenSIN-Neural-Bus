import sqlite3
import json
import logging
from datetime import datetime
from typing import List, Dict, Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s - [OUROBOROS] - %(message)s")

class OuroborosDNA:
    """
    The Ouroboros Memory System (Software 3.0).
    Provides Persistent DNA and Procedural Memory for the OpenSIN-AI Swarm.
    Agents use this to 'remember' lessons across sessions and generations.
    """
    
    def __init__(self, db_path: str = "/tmp/ouroboros_dna.sqlite"):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS procedural_memory (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agent_id TEXT NOT NULL,
                    task_context TEXT NOT NULL,
                    lesson_learned TEXT NOT NULL,
                    success_rate REAL,
                    timestamp TEXT NOT NULL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS capability_registry (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    capability_name TEXT UNIQUE NOT NULL,
                    mcp_path TEXT NOT NULL,
                    synthesized_by TEXT NOT NULL,
                    timestamp TEXT NOT NULL
                )
            """)
            conn.commit()

    def remember_lesson(self, agent_id: str, context: str, lesson: str, success_rate: float = 1.0):
        """Speichert eine erfolgreiche (oder fehlerhafte) Lektion in die globale DNA."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO procedural_memory (agent_id, task_context, lesson_learned, success_rate, timestamp) VALUES (?, ?, ?, ?, ?)",
                (agent_id, context, lesson, success_rate, datetime.now().isoformat())
            )
            conn.commit()
        logging.info(f"🧬 DNA aktualisiert: [{agent_id}] hat eine neue Lektion gelernt.")

    def recall_lessons(self, context_keyword: str, limit: int = 5) -> List[Dict[str, Any]]:
        """Ruft vergangene Lektionen basierend auf einem Kontext-Keyword ab."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM procedural_memory WHERE task_context LIKE ? ORDER BY success_rate DESC, timestamp DESC LIMIT ?",
                (f"%{context_keyword}%", limit)
            )
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def register_capability(self, capability: str, path: str, agent: str):
        """Registriert einen neu synthetisierten MCP Server im globalen Gedächtnis."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO capability_registry (capability_name, mcp_path, synthesized_by, timestamp) VALUES (?, ?, ?, ?)",
                (capability, path, agent, datetime.now().isoformat())
            )
            conn.commit()
        logging.info(f"🌐 Capability registriert: {capability} steht dem Swarm nun zur Verfügung.")

if __name__ == "__main__":
    # Test the DNA Memory
    dna = OuroborosDNA()
    dna.remember_lesson("A2A-SIN-Medusa", "TypeScript MCP Synthesis", "Always use @modelcontextprotocol/sdk/server/stdio.js for transport to avoid connection drops.", 1.0)
    lessons = dna.recall_lessons("MCP")
    print(f"Recalled Lesson: {lessons[0]['lesson_learned']}")
