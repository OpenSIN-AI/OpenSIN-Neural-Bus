# Project Rules

## Global Rules (synced from AGENTS.md)
- [2026-04-13T14:00:00Z] Images MUST be opened in macOS Preview.app — never tell users to check /tmp (priority: -4.5)
- [2026-04-13T14:00:00Z] Auto-sync after every chat turn via sync-chat-turn hook (priority: -4.0)

## Project-Specific Rules
- All event envelopes must pass validation before publishing to JetStream
- Subjects must follow the canonical taxonomy in docs/jetstream-subject-taxonomy.md
- MCP servers must be registered in global opencode.json before use
