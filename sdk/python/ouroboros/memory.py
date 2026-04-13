# ==============================================================================
# OpenSIN Neural Bus - Ouroboros Memory System (v1.2.0)
# ==============================================================================
#
# DESCRIPTION / BESCHREIBUNG:
# This module stores and retrieves OpenSIN procedural memory lessons, capability
# registrations, and sync-ready memory updates. It also exposes bridge helpers so
# JetStream events can hydrate durable memory automatically.
#
# WHY IT EXISTS / WARUM ES EXISTIERT:
# Issue #8 requires the event bus and Ouroboros memory to work together so
# operators do not have to repeat the same instructions after every restart.
# Separately, the existing persistence tests require a durable default path,
# backup/restore support, legacy migration, and an outbox that records which
# updates still need to be synchronized elsewhere.
#
# ARCHITECTURE / ARCHITEKTUR:
# - SQLite Backend: local persistence with zero external services.
# - Procedural Memory: lessons learned from prior successful work.
# - Capability Registry: shared inventory of synthesized agent capabilities.
# - Sync Outbox: append-only records for later export into other systems.
# - Deterministic Ranking: keyword overlap + success rate + recency.
# - Event Bridge: consumes JetStream-style envelopes and mirrors them into DNA.
#
# CONSEQUENCES / KONSEQUENZEN:
# - If this database is lost, agents lose their procedural memory.
# - The ranking intentionally stays deterministic and explainable instead of
#   relying on another model call, because hook-time context injection must stay
#   fast, inspectable, and cheap.
# - Memory updates are written into a sync outbox immediately so replay/export can
#   happen later without scraping operational tables.
# ==============================================================================

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence

# We keep module-level logging because the OpenCode plugin can opt into debug
# mode and surface these messages to operators when they need to understand why a
# lesson was or was not injected.
logging.basicConfig(level=logging.INFO, format="%(asctime)s - [OUROBOROS] - %(message)s")
LOGGER = logging.getLogger("ouroboros")

# A small stopword list keeps keyword extraction deterministic without requiring
# external NLP dependencies. The goal is not linguistic perfection; the goal is
# removing obviously low-signal filler words so ranking can focus on the task.
STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "need",
    "of",
    "on",
    "or",
    "our",
    "please",
    "should",
    "so",
    "that",
    "the",
    "their",
    "them",
    "then",
    "this",
    "to",
    "use",
    "we",
    "when",
    "with",
    "you",
    "your",
}


def utc_now_iso() -> str:
    """Return one canonical timestamp format for every persisted record."""

    return datetime.now(timezone.utc).isoformat()


# The durable default path intentionally lives under OPENCODE_HOME (or the user's
# config directory fallback) so HF/OCI agents stop depending on `/tmp`.
def default_ouroboros_db_path() -> Path:
    """Return the canonical durable database path used by OpenSIN agents."""

    opencode_home = os.environ.get("OPENCODE_HOME")
    if opencode_home:
        root = Path(opencode_home)
    else:
        root = Path.home() / ".config" / "opencode"

    durable_path = root / "ouroboros" / "ouroboros_dna.sqlite"
    durable_path.parent.mkdir(parents=True, exist_ok=True)
    return durable_path


@dataclass(frozen=True)
class RankedLesson:
    """
    Internal container for a scored lesson candidate.

    We keep the ranking structure explicit because both the plugin and the tests
    need stable, inspectable metadata such as score, token estimate, and the
    reasons that explain why a lesson was selected.
    """

    lesson_id: int
    agent_id: str
    task_context: str
    lesson_learned: str
    success_rate: float
    timestamp: str
    score: float
    reasons: List[str]
    token_estimate: int


class OuroborosDNA:
    """
    The Ouroboros Memory System (Software 3.0).

    This class provides the original storage APIs plus a deterministic retrieval
    pipeline, a sync outbox, durability helpers, and an event-ingest bridge that
    can be fed directly from JetStream/OpenCode integrations.
    """

    def __init__(
        self,
        db_path: str | Path | None = None,
        *,
        legacy_db_path: str | Path | None = None,
        auto_migrate_legacy: bool = True,
    ):
        # The database path stays configurable because different agents, test
        # suites, and OpenCode projects may want isolated memory stores.
        resolved_db_path = Path(db_path) if db_path is not None else default_ouroboros_db_path()
        resolved_db_path.parent.mkdir(parents=True, exist_ok=True)

        self.db_path = str(resolved_db_path)
        self.legacy_db_path = str(Path(legacy_db_path)) if legacy_db_path is not None else "/tmp/ouroboros_dna.sqlite"
        self.auto_migrate_legacy = auto_migrate_legacy

        self._init_db()

        # Automatic migration is best-effort because a missing legacy file is a
        # normal state on new installs, not an error.
        if self.auto_migrate_legacy:
            self.migrate_legacy_db()

    def _connect(self) -> sqlite3.Connection:
        """Create a connection with row access by column name."""

        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_db(self) -> None:
        """Create the SQLite tables if they do not already exist."""

        with self._connect() as conn:
            conn.execute(
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
            conn.execute(
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
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sync_outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    entity_type TEXT NOT NULL,
                    entity_key TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    delivered_at TEXT
                )
                """
            )
            conn.commit()

    def remember_lesson(self, agent_id: str, context: str, lesson: str, success_rate: float = 1.0) -> Dict[str, Any]:
        """Persist a lesson so future sessions can reuse it and return the stored row."""

        timestamp = utc_now_iso()
        payload = {
            "agent_id": agent_id,
            "task_context": context,
            "lesson_learned": lesson,
            "success_rate": success_rate,
            "timestamp": timestamp,
        }

        with self._connect() as conn:
            cursor = conn.execute(
                "INSERT INTO procedural_memory (agent_id, task_context, lesson_learned, success_rate, timestamp) VALUES (?, ?, ?, ?, ?)",
                (agent_id, context, lesson, success_rate, timestamp),
            )
            self._enqueue_sync_event(
                conn,
                entity_type="procedural_memory",
                entity_key=f"{agent_id}:{context}:{timestamp}",
                payload=payload,
            )
            row = conn.execute(
                "SELECT * FROM procedural_memory WHERE id = ?",
                (cursor.lastrowid,),
            ).fetchone()
            conn.commit()
        LOGGER.info("🧬 DNA updated: [%s] stored a new lesson.", agent_id)
        return dict(row) if row is not None else payload

    def recall_lessons(self, context_keyword: str, limit: int = 5) -> List[Dict[str, Any]]:
        """
        Backwards-compatible keyword recall.

        We keep this method because other callers may still rely on the original
        API, even though the new OpenCode integration prefers `search_lessons`
        and `build_context_packet`.
        """

        with self._connect() as conn:
            cursor = conn.execute(
                "SELECT * FROM procedural_memory WHERE task_context LIKE ? ORDER BY success_rate DESC, timestamp DESC LIMIT ?",
                (f"%{context_keyword}%", limit),
            )
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def register_capability(self, capability: str, path: str, agent: str) -> Dict[str, Any]:
        """Register a synthesized capability in the global capability registry."""

        timestamp = utc_now_iso()
        payload = {
            "capability_name": capability,
            "mcp_path": path,
            "synthesized_by": agent,
            "timestamp": timestamp,
        }

        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO capability_registry (capability_name, mcp_path, synthesized_by, timestamp) VALUES (?, ?, ?, ?)",
                (capability, path, agent, timestamp),
            )
            self._enqueue_sync_event(
                conn,
                entity_type="capability_registry",
                entity_key=capability,
                payload=payload,
            )
            row = conn.execute(
                "SELECT * FROM capability_registry WHERE capability_name = ?",
                (capability,),
            ).fetchone()
            conn.commit()
        LOGGER.info("🌐 Capability registered: %s is now available to the swarm.", capability)
        return dict(row) if row is not None else payload

    def query_capabilities(self, keyword: str = "", limit: int = 20) -> List[Dict[str, Any]]:
        """Query capabilities by optional keyword across the main searchable fields."""

        normalized_keyword = keyword.strip()
        with self._connect() as conn:
            if normalized_keyword:
                cursor = conn.execute(
                    "SELECT * FROM capability_registry WHERE capability_name LIKE ? OR mcp_path LIKE ? OR synthesized_by LIKE ? ORDER BY timestamp DESC, capability_name ASC LIMIT ?",
                    (
                        f"%{normalized_keyword}%",
                        f"%{normalized_keyword}%",
                        f"%{normalized_keyword}%",
                        limit,
                    ),
                )
            else:
                cursor = conn.execute(
                    "SELECT * FROM capability_registry ORDER BY timestamp DESC, capability_name ASC LIMIT ?",
                    (limit,),
                )
            return [dict(row) for row in cursor.fetchall()]

    def list_capabilities(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Return the registered capabilities in newest-first order."""

        with self._connect() as conn:
            cursor = conn.execute(
                "SELECT * FROM capability_registry ORDER BY timestamp DESC, capability_name ASC LIMIT ?",
                (limit,),
            )
            return [dict(row) for row in cursor.fetchall()]

    def export_sync_batch(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Return pending sync outbox rows in creation order."""

        with self._connect() as conn:
            cursor = conn.execute(
                "SELECT * FROM sync_outbox WHERE delivered_at IS NULL ORDER BY created_at ASC, id ASC LIMIT ?",
                (limit,),
            )
            return [dict(row) for row in cursor.fetchall()]

    def mark_sync_delivered(self, outbox_ids: Sequence[int]) -> int:
        """Mark outbox rows as delivered after an external sync succeeds."""

        if not outbox_ids:
            return 0

        placeholders = ", ".join(["?"] * len(outbox_ids))
        delivered_at = utc_now_iso()

        with self._connect() as conn:
            cursor = conn.execute(
                f"UPDATE sync_outbox SET delivered_at = ? WHERE id IN ({placeholders})",
                [delivered_at, *outbox_ids],
            )
            conn.commit()
            return int(cursor.rowcount)

    def migrate_legacy_db(self) -> Dict[str, Any]:
        """
        Import rows from the historical `/tmp` database into the durable store.

        The migration is idempotent enough for repeated calls in tests and startup
        hooks: rows are copied into the current database and the current DB remains
        authoritative.
        """

        legacy_path = Path(self.legacy_db_path)
        current_path = Path(self.db_path)

        if not legacy_path.exists():
            return {
                "migrated": False,
                "reason": "legacy_database_missing",
                "procedural_memory_rows": 0,
                "capability_registry_rows": 0,
            }

        if legacy_path.resolve() == current_path.resolve():
            return {
                "migrated": False,
                "reason": "legacy_database_is_current_database",
                "procedural_memory_rows": 0,
                "capability_registry_rows": 0,
            }

        memory_rows = 0
        capability_rows = 0

        with sqlite3.connect(str(legacy_path)) as legacy_conn, self._connect() as current_conn:
            legacy_conn.row_factory = sqlite3.Row
            current_conn.row_factory = sqlite3.Row

            try:
                legacy_memory_rows = legacy_conn.execute(
                    "SELECT agent_id, task_context, lesson_learned, success_rate, timestamp FROM procedural_memory"
                ).fetchall()
            except sqlite3.OperationalError:
                legacy_memory_rows = []

            try:
                legacy_capability_rows = legacy_conn.execute(
                    "SELECT capability_name, mcp_path, synthesized_by, timestamp FROM capability_registry"
                ).fetchall()
            except sqlite3.OperationalError:
                legacy_capability_rows = []

            for row in legacy_memory_rows:
                current_conn.execute(
                    "INSERT INTO procedural_memory (agent_id, task_context, lesson_learned, success_rate, timestamp) VALUES (?, ?, ?, ?, ?)",
                    (
                        row["agent_id"],
                        row["task_context"],
                        row["lesson_learned"],
                        row["success_rate"],
                        row["timestamp"],
                    ),
                )
                self._enqueue_sync_event(
                    current_conn,
                    entity_type="procedural_memory",
                    entity_key=f"{row['agent_id']}:{row['task_context']}:{row['timestamp']}",
                    payload=dict(row),
                )
                memory_rows += 1

            for row in legacy_capability_rows:
                current_conn.execute(
                    "INSERT OR REPLACE INTO capability_registry (capability_name, mcp_path, synthesized_by, timestamp) VALUES (?, ?, ?, ?)",
                    (
                        row["capability_name"],
                        row["mcp_path"],
                        row["synthesized_by"],
                        row["timestamp"],
                    ),
                )
                self._enqueue_sync_event(
                    current_conn,
                    entity_type="capability_registry",
                    entity_key=str(row["capability_name"]),
                    payload=dict(row),
                )
                capability_rows += 1

            current_conn.commit()

        return {
            "migrated": True,
            "reason": "ok",
            "procedural_memory_rows": memory_rows,
            "capability_registry_rows": capability_rows,
        }

    def create_backup(self, backup_path: str | Path) -> Dict[str, Any]:
        """Create a byte-for-byte SQLite backup of the current database."""

        backup_destination = Path(backup_path)
        backup_destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.db_path, backup_destination)
        return {
            "backed_up": True,
            "source": self.db_path,
            "backup_path": str(backup_destination),
        }

    def restore_from_backup(self, backup_path: str | Path, *, replace_existing: bool = False) -> Dict[str, Any]:
        """Restore the current database from a previously created backup."""

        backup_source = Path(backup_path)
        if not backup_source.exists():
            raise FileNotFoundError(f"Backup database does not exist: {backup_source}")

        destination = Path(self.db_path)
        destination.parent.mkdir(parents=True, exist_ok=True)

        if destination.exists() and not replace_existing:
            raise FileExistsError(
                "Refusing to overwrite an existing Ouroboros database without replace_existing=True."
            )

        shutil.copy2(backup_source, destination)
        self._init_db()
        return {
            "restored": True,
            "backup_path": str(backup_source),
            "db_path": self.db_path,
        }

    def apply_event_envelope(self, envelope: Dict[str, Any]) -> Dict[str, int]:
        """
        Apply JetStream/OpenCode event envelopes to durable memory.

        The envelope contract intentionally mirrors the TypeScript side: explicit
        `ouroboros` hints win, and event-kind fallbacks cover the two canonical
        side effects we need for Issue #8.
        """

        remembered_lessons = 0
        registered_capabilities = 0

        hints = envelope.get("ouroboros") if isinstance(envelope, dict) else None
        payload = envelope.get("payload", {}) if isinstance(envelope, dict) else {}
        kind = str(envelope.get("kind", "")) if isinstance(envelope, dict) else ""

        if isinstance(hints, dict) and isinstance(hints.get("rememberLesson"), dict):
            self.remember_lesson_from_event(hints["rememberLesson"])
            remembered_lessons += 1
        elif kind == "memory.lesson.learned" and isinstance(payload, dict):
            self.remember_lesson_from_event(payload)
            remembered_lessons += 1

        if isinstance(hints, dict) and isinstance(hints.get("registerCapability"), dict):
            self.register_capability_from_event(hints["registerCapability"])
            registered_capabilities += 1
        elif kind == "capability.registered" and isinstance(payload, dict):
            self.register_capability_from_event(payload)
            registered_capabilities += 1

        return {
            "remembered_lessons": remembered_lessons,
            "registered_capabilities": registered_capabilities,
        }

    def remember_lesson_from_event(self, record: Dict[str, Any]) -> None:
        """Hydrate a lesson from a bus event payload."""

        self.remember_lesson(
            agent_id=str(record["agentId"]),
            context=str(record["context"]),
            lesson=str(record["lesson"]),
            success_rate=self._clamp_success_rate(record.get("successRate", 1.0)),
        )

    def register_capability_from_event(self, record: Dict[str, Any]) -> None:
        """Hydrate a capability registration from a bus event payload."""

        synthesized_by = record.get("synthesizedBy") or record.get("agentId") or "unknown-agent"
        self.register_capability(
            capability=str(record["capability"]),
            path=str(record["path"]),
            agent=str(synthesized_by),
        )

    def extract_keywords(self, prompt: str, limit: int = 8) -> List[str]:
        """
        Extract stable, low-noise keywords from the active prompt.

        The extractor is intentionally simple and dependency-free. That makes the
        hook cheap to run on every OpenCode request and keeps the ranking logic
        fully inspectable in tests and debug payloads.
        """

        words = re.findall(r"[a-zA-Z0-9_./:-]+", prompt.lower())
        ordered_keywords: List[str] = []
        seen: set[str] = set()
        for word in words:
            if len(word) < 3:
                continue
            if word in STOPWORDS:
                continue
            # Normalizing trailing punctuation and separators reduces duplicate
            # keys like `plugin,` vs `plugin` while still keeping technical terms
            # like `openai/gpt-5.4` or `sdk/python` intact.
            cleaned = word.strip("._:-/")
            if len(cleaned) < 3:
                continue
            if cleaned in STOPWORDS or cleaned in seen:
                continue
            ordered_keywords.append(cleaned)
            seen.add(cleaned)
            if len(ordered_keywords) >= limit:
                break
        return ordered_keywords

    def search_lessons(self, prompt: str, limit: int = 5, min_score: float = 0.2) -> List[Dict[str, Any]]:
        """
        Search procedural lessons using deterministic scoring.

        The ranking balances four signals:
        1. keyword overlap with the task context and lesson body,
        2. exact phrase presence from the current prompt,
        3. historical success rate,
        4. a small recency bias for tie-breaking.
        """

        prompt = prompt.strip()
        if not prompt:
            return []

        keywords = self.extract_keywords(prompt)
        rows = self._fetch_candidate_rows(keywords=keywords, fallback_limit=max(limit * 6, 12))
        ranked = self._rank_rows(rows=rows, prompt=prompt, keywords=keywords, min_score=min_score)
        deduped = self._deduplicate_ranked_lessons(ranked)
        return [self._ranked_lesson_to_dict(item) for item in deduped[:limit]]

    def build_context_packet(
        self,
        prompt: str,
        *,
        max_lessons: int = 5,
        token_budget: int = 400,
        min_score: float = 0.2,
        debug: bool = False,
    ) -> Dict[str, Any]:
        """
        Build the full context injection packet for the OpenCode hook.

        The returned structure is intentionally explicit because operators need to
        inspect not only the final injected text, but also which lessons were
        discarded due to deduplication or token trimming.
        """

        normalized_prompt = prompt.strip()
        keywords = self.extract_keywords(normalized_prompt)
        selected_lessons = [
            self._dict_to_ranked_lesson(item)
            for item in self.search_lessons(prompt=normalized_prompt, limit=max(max_lessons * 3, 12), min_score=min_score)
        ]

        injected_lessons: List[RankedLesson] = []
        skipped_lessons: List[Dict[str, Any]] = []
        token_budget = max(token_budget, 0)

        for lesson in selected_lessons:
            if len(injected_lessons) >= max_lessons:
                skipped_lessons.append(
                    {
                        "lesson_id": lesson.lesson_id,
                        "reason": "max_lessons_reached",
                        "score": round(lesson.score, 4),
                    }
                )
                continue

            candidate_lessons = [*injected_lessons, lesson]
            candidate_text = self._build_injected_text(candidate_lessons)
            candidate_token_cost = self.estimate_tokens(candidate_text)

            if candidate_token_cost > token_budget:
                skipped_lessons.append(
                    {
                        "lesson_id": lesson.lesson_id,
                        "reason": "token_budget_exceeded",
                        "score": round(lesson.score, 4),
                        "token_estimate": candidate_token_cost,
                    }
                )
                continue

            injected_lessons = candidate_lessons

        injected_text = self._build_injected_text(injected_lessons)
        total_estimated_tokens = self.estimate_tokens(injected_text)
        remaining_budget = max(token_budget - total_estimated_tokens, 0)

        packet = {
            "prompt": normalized_prompt,
            "keywords": keywords,
            "debug": debug,
            "token_budget": token_budget,
            "remaining_token_budget": remaining_budget,
            "selected_count": len(injected_lessons),
            "candidate_count": len(selected_lessons),
            "injected": bool(injected_lessons),
            "injected_text": injected_text,
            "estimated_injected_tokens": total_estimated_tokens,
            "lessons": [self._ranked_lesson_to_dict(item) for item in injected_lessons],
            "skipped": skipped_lessons,
        }

        if debug:
            LOGGER.info(
                "🪞 Built context packet: selected=%s candidates=%s token_budget=%s used=%s keywords=%s",
                packet["selected_count"],
                packet["candidate_count"],
                token_budget,
                total_estimated_tokens,
                ", ".join(keywords) or "<none>",
            )

        return packet

    def estimate_tokens(self, text: str) -> int:
        """
        Estimate token cost without external tokenizers.

        We intentionally use a conservative character-based heuristic here. The
        exact tokenizer varies by model anyway, so a stable approximation is more
        useful than pretending we have exact token counts when we do not.
        """

        if not text:
            return 0
        return max(1, math.ceil(len(text) / 4))

    def _enqueue_sync_event(
        self,
        conn: sqlite3.Connection,
        *,
        entity_type: str,
        entity_key: str,
        payload: Dict[str, Any],
    ) -> None:
        """Append a sync-ready event to the outbox inside the current transaction."""

        conn.execute(
            "INSERT INTO sync_outbox (entity_type, entity_key, payload_json, created_at, delivered_at) VALUES (?, ?, ?, ?, NULL)",
            (entity_type, entity_key, json.dumps(payload, sort_keys=True), utc_now_iso()),
        )

    def _fetch_candidate_rows(self, keywords: Sequence[str], fallback_limit: int) -> List[sqlite3.Row]:
        """Fetch candidate rows using keyword filtering when possible."""

        with self._connect() as conn:
            if not keywords:
                cursor = conn.execute(
                    "SELECT * FROM procedural_memory ORDER BY success_rate DESC, timestamp DESC LIMIT ?",
                    (fallback_limit,),
                )
                return cursor.fetchall()

            where_clauses: List[str] = []
            params: List[Any] = []
            for keyword in keywords:
                wildcard = f"%{keyword}%"
                where_clauses.append("(LOWER(task_context) LIKE ? OR LOWER(lesson_learned) LIKE ?)")
                params.extend([wildcard, wildcard])

            query = (
                "SELECT * FROM procedural_memory "
                f"WHERE {' OR '.join(where_clauses)} "
                "ORDER BY success_rate DESC, timestamp DESC LIMIT ?"
            )
            params.append(fallback_limit)
            cursor = conn.execute(query, params)
            return cursor.fetchall()

    def _rank_rows(
        self,
        *,
        rows: Iterable[sqlite3.Row],
        prompt: str,
        keywords: Sequence[str],
        min_score: float,
    ) -> List[RankedLesson]:
        """Score rows and discard weak matches."""

        prompt_lower = prompt.lower()
        ranked_lessons: List[RankedLesson] = []

        for row in rows:
            task_context = str(row["task_context"])
            lesson_text = str(row["lesson_learned"])
            combined_text = f"{task_context} {lesson_text}".lower()
            matched_keywords = [keyword for keyword in keywords if keyword in combined_text]
            overlap_ratio = (len(matched_keywords) / len(keywords)) if keywords else 0.0
            phrase_bonus = 0.2 if prompt_lower and prompt_lower in combined_text else 0.0
            success_rate = self._clamp_success_rate(row["success_rate"])
            success_bonus = success_rate * 0.25
            recency_bonus = self._compute_recency_bonus(timestamp=str(row["timestamp"]))

            score = overlap_ratio + phrase_bonus + success_bonus + recency_bonus
            if score < min_score:
                continue

            reasons = []
            if matched_keywords:
                reasons.append(f"matched keywords: {', '.join(matched_keywords[:6])}")
            if phrase_bonus:
                reasons.append("matched the full prompt phrase")
            reasons.append(f"success rate contribution: {success_rate:.2f}")
            reasons.append(f"recency contribution: {recency_bonus:.2f}")

            ranked_lessons.append(
                RankedLesson(
                    lesson_id=int(row["id"]),
                    agent_id=str(row["agent_id"]),
                    task_context=task_context,
                    lesson_learned=lesson_text,
                    success_rate=success_rate,
                    timestamp=str(row["timestamp"]),
                    score=score,
                    reasons=reasons,
                    token_estimate=self.estimate_tokens(self._format_lesson_for_injection_text(task_context, lesson_text)),
                )
            )

        ranked_lessons.sort(key=lambda item: (-item.score, -item.success_rate, item.timestamp))
        return ranked_lessons

    def _deduplicate_ranked_lessons(self, ranked_lessons: Sequence[RankedLesson]) -> List[RankedLesson]:
        """Remove repeated lessons so the system prompt never wastes budget."""

        deduplicated: List[RankedLesson] = []
        seen_texts: set[str] = set()

        for lesson in ranked_lessons:
            normalized_lesson = self._normalize_text(lesson.lesson_learned)
            if normalized_lesson in seen_texts:
                continue
            seen_texts.add(normalized_lesson)
            deduplicated.append(lesson)

        return deduplicated

    def _compute_recency_bonus(self, timestamp: str) -> float:
        """Give newer lessons a small bonus without overpowering relevance."""

        try:
            parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError:
            return 0.0

        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)

        age_seconds = max((datetime.now(timezone.utc) - parsed).total_seconds(), 0.0)
        age_days = age_seconds / 86400.0
        return 0.15 / (1.0 + (age_days / 30.0))

    def _build_injected_text(self, lessons: Sequence[RankedLesson]) -> str:
        """Format the selected lessons into a compact system-context block."""

        if not lessons:
            return ""

        lesson_lines = [self._format_lesson_for_injection(lesson) for lesson in lessons]
        return (
            "<opensin_ouroboros_lessons>\n"
            "Use these OpenSIN procedural lessons when they directly fit the current task. "
            "Prefer them over re-discovering the same process, but do not force them onto unrelated work.\n"
            + "\n".join(lesson_lines)
            + "\n</opensin_ouroboros_lessons>"
        )

    def _format_lesson_for_injection(self, lesson: RankedLesson) -> str:
        """Render one lesson in the compact format used inside the system prompt."""

        return self._format_lesson_for_injection_text(lesson.task_context, lesson.lesson_learned)

    def _format_lesson_for_injection_text(self, task_context: str, lesson_text: str) -> str:
        """Shared formatter so scoring and formatting use the same token estimate."""

        compact_context = self._collapse_whitespace(task_context)
        compact_lesson = self._collapse_whitespace(lesson_text)
        return f"- Context: {compact_context}\n  Lesson: {compact_lesson}"

    def _ranked_lesson_to_dict(self, lesson: RankedLesson) -> Dict[str, Any]:
        """Serialize ranked lessons for JSON/debug payloads."""

        return {
            "id": lesson.lesson_id,
            "agent_id": lesson.agent_id,
            "task_context": lesson.task_context,
            "lesson_learned": lesson.lesson_learned,
            "success_rate": lesson.success_rate,
            "timestamp": lesson.timestamp,
            "score": round(lesson.score, 4),
            "reasons": lesson.reasons,
            "token_estimate": lesson.token_estimate,
        }

    def _dict_to_ranked_lesson(self, lesson: Dict[str, Any]) -> RankedLesson:
        """Hydrate ranked lessons when `search_lessons` output feeds later stages."""

        return RankedLesson(
            lesson_id=int(lesson["id"]),
            agent_id=str(lesson["agent_id"]),
            task_context=str(lesson["task_context"]),
            lesson_learned=str(lesson["lesson_learned"]),
            success_rate=float(lesson["success_rate"]),
            timestamp=str(lesson["timestamp"]),
            score=float(lesson["score"]),
            reasons=list(lesson["reasons"]),
            token_estimate=int(lesson["token_estimate"]),
        )

    def _normalize_text(self, value: str) -> str:
        """Normalize text for deduplication and stable comparisons."""

        return self._collapse_whitespace(value).lower()

    def _collapse_whitespace(self, value: str) -> str:
        """Remove formatting noise so prompt injection stays compact."""

        return re.sub(r"\s+", " ", value).strip()

    def _clamp_success_rate(self, value: Any) -> float:
        """Keep success rate within a predictable scoring range."""

        try:
            numeric_value = float(value)
        except (TypeError, ValueError):
            return 0.0
        return max(0.0, min(numeric_value, 1.0))


__all__ = ["OuroborosDNA", "default_ouroboros_db_path"]


if __name__ == "__main__":
    # This small manual example remains useful for local validation without the
    # OpenCode plugin, especially when operators want to inspect the retrieval
    # layer directly from the command line.
    dna = OuroborosDNA(auto_migrate_legacy=False)
    dna.remember_lesson(
        "A2A-SIN-Medusa",
        "TypeScript MCP Synthesis",
        "Always use the standard OpenSIN bus helpers so replay and memory hooks stay consistent.",
        1.0,
    )
    packet = dna.build_context_packet(
        "Need a stable JetStream transport for an OpenSIN agent runtime",
        max_lessons=3,
        token_budget=120,
        debug=True,
    )
    print(packet["injected_text"])
