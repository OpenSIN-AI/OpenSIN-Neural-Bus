# OpenSIN Neural Bus OpenCode MCP Wiring

## What this MCP server exposes

The `opensin-neural-bus-mcp` entrypoint exposes these first-class OpenCode tools:

- `opensin_publish_event`
- `opensin_listen_events`
- `opensin_query_recent_events`
- `opensin_register_capability`
- `opensin_query_capabilities`
- `opensin_query_recent_lessons`

The event tools use the TypeScript Neural Bus runtime. The capability and lesson
queries use the Python Ouroboros registry through a JSON CLI bridge.

## Build the server

```bash
bun install
bun run build
```

## Required environment

| Variable | Purpose | Required |
|---|---|---|
| `NEURAL_BUS_URL` | NATS/JetStream server URL for event publish/listen tools | only for event tools |
| `NEURAL_BUS_TOKEN` | NATS auth token if the bus requires one | optional |
| `OUROBOROS_DB_PATH` | SQLite file used by the Python Ouroboros registry | recommended |
| `OUROBOROS_PYTHON` | Python executable for the bridge | optional, defaults to `python3` |

## opencode.json example

```json
{
  "mcp": {
    "opensin-neural-bus": {
      "type": "local",
      "command": "node",
      "args": [
        "/absolute/path/to/OpenSIN-Neural-Bus/dist/src/mcp-server.js"
      ],
      "env": {
        "NEURAL_BUS_URL": "nats://127.0.0.1:4222",
        "NEURAL_BUS_TOKEN": "replace-if-needed",
        "OUROBOROS_DB_PATH": "/tmp/ouroboros_dna.sqlite",
        "OUROBOROS_PYTHON": "python3"
      }
    }
  }
}
```

## Tool behavior notes

### `opensin_publish_event`
Publishes a fully validated envelope and also stores it in the MCP server's
recent-event cache.

### `opensin_listen_events`
Listens to a topic for a bounded number of live events. Use `timeoutMs` so the
request returns quickly in OpenCode sessions.

### `opensin_query_recent_events`
Returns only the MCP server process cache. This is intentional for the first
integration: it lets operators inspect what this OpenCode session has already
published or observed without assuming any specific JetStream retention model.

### `opensin_register_capability`
Writes a capability record into Ouroboros so later OpenCode sessions can query
where a reusable tool or MCP surface lives.

### `opensin_query_capabilities`
Searches the capability registry by keyword across name, path, and synthesizing
agent.

### `opensin_query_recent_lessons`
Pulls recent procedural lessons so operators can inject historical context into a
session without manually restating it.

## Python bridge note

The MCP server automatically prepends this repo's `sdk/python` directory to
`PYTHONPATH` before calling `python3 -m ouroboros.cli ...`, so no separate
virtualenv packaging step is required for local repo usage.
