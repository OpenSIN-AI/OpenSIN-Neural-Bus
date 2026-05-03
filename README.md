<a name="readme-top"></a>

# OpenSIN Neural Bus

<p align="center">
  <a href="https://github.com/OpenSIN-AI/OpenSIN-Neural-Bus/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  </a>
  <a href="https://github.com/OpenSIN-AI/OpenSIN-Neural-Bus/stargazers">
    <img src="https://img.shields.io/github/stars/OpenSIN-AI/OpenSIN-Neural-Bus?style=social" alt="Stars" />
  </a>
  <a href="https://www.npmjs.com/package/@opensin/neural-bus">
    <img src="https://img.shields.io/badge/npm-package-CB3837?logo=npm" alt="npm" />
  </a>
  <a href="https://www.python.org/downloads/">
    <img src="https://img.shields.io/badge/python-3.11+-3776AB?logo=python&logoColor=white" alt="Python" />
  </a>
  <a href="https://nats.io">
    <img src="https://img.shields.io/badge/NATS-JetStream-27AAE1?logo=natsdotio&logoColor=white" alt="NATS" />
  </a>
  <a href="https://github.com/OpenSIN-AI/OpenSIN-Neural-Bus/actions">
    <img src="https://img.shields.io/badge/build-passing-2EA043" alt="Build" />
  </a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#deploy">Deploy</a> ·
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <em>The event-driven nervous system connecting all OpenSIN agents — durable, replayable, and Ouroboros-aware.</em>
</p>

---

## Quick Start

<table>
<tr>
<td width="33%" align="center">
<strong>1. Start NATS</strong><br/><br/>
<code>docker compose up -d nats</code><br/><br/>
<img src="https://img.shields.io/badge/5s-Blue?style=flat" />
</td>
<td width="33%" align="center">
<strong>2. Install</strong><br/><br/>
<code>bun install</code><br/><br/>
<img src="https://img.shields.io/badge/30s-Blue?style=flat" />
</td>
<td width="33%" align="center">
<strong>3. Test</strong><br/><br/>
<code>bun test</code><br/><br/>
<img src="https://img.shields.io/badge/Go!-Green?style=flat" />
</td>
</tr>
</table>

> [!TIP]
> Full setup: `bun install && docker compose up -d nats && bun test` — all tests cover pub/sub, request/reply, durable resume, and replay.

---

## Features

| Capability | Description | Status |
|:---|:---|:---:|
| **JetStream Integration** | Stable connect/reconnect wrapper with validated event envelopes | ✅ |
| **Durable Consumers** | Resume from last acked message after restart — no context loss | ✅ |
| **Request/Reply** | Synchronous request-response pattern over NATS subjects | ✅ |
| **Event Envelopes** | Standardized envelope with correlation IDs and source tracking | ✅ |
| **Subject Taxonomy** | Documented subject hierarchy for all event types | ✅ |
| **Ouroboros Bridge** | Auto-bridge to memory (`rememberLesson`) and capability (`registerCapability`) | ✅ |
| **Python SDK** | SQLite-backed memory with `apply_event_envelope()` | ✅ |
| **Agent Runtime** | Reusable publish/consume patterns for A2A agents | ✅ |

<details>
<summary>Core Exports (TypeScript)</summary>

```ts
import {
  OpenCodeJetStreamClient,   // Stable NATS connection wrapper
  OpenSinAgentRuntime,       // Agent runtime with pub/sub patterns
  SUBJECTS,                  // Subject taxonomy constants
  createEventEnvelope,       // Envelope factory with validation
} from "@opensin/neural-bus";
```

</details>

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Architecture

```mermaid
flowchart TB
    subgraph Agents["Agent Runtimes"]
        HERMES[A2A-SIN-Hermes]
        ORCH[A2A-SIN-Orchestrator]
        CLI[OpenCode CLI]
    end

    subgraph Bus["Neural Bus (NATS JetStream)"]
        PUB[Publish]
        SUB[Subscribe]
        REQ[Request/Reply]
        DUR[Durable Consumer]
    end

    subgraph Memory["Ouroboros Memory"]
        LESSON[rememberLesson]
        CAPA[registerCapability]
        SQLITE[(SQLite Memory)]
    end

    HERMES --> PUB
    ORCH --> REQ
    CLI --> PUB
    PUB --> SUB
    REQ --> SUB
    SUB --> DUR
    DUR --> LESSON
    DUR --> CAPA
    LESSON --> SQLITE
    CAPA --> SQLITE

    classDef agentClass fill:#e1f5fe,stroke:#01579b,stroke-width:2px
    classDef busClass fill:#fff3e0,stroke:#e65100,stroke-width:2px
    classDef memClass fill:#fce4ec,stroke:#880e4f,stroke-width:2px

    class HERMES,ORCH,CLI agentClass
    class PUB,SUB,REQ,DUR busClass
    class LESSON,CAPA,SQLITE memClass
```

For detailed subject taxonomy see [docs/jetstream-subject-taxonomy.md](docs/jetstream-subject-taxonomy.md).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Usage

### Agent Runtime — Publish Events

```ts
const runtime = new OpenSinAgentRuntime({
  agentId: "a2a-sin-hermes",
  sessionId: "session-001",
  bus,
});

await runtime.publishObservation({
  message: "worker booted",
  branch: "feat/new-feature",
});

await runtime.publishLessonLearned({
  context: "JetStream reconnect handling",
  lesson: "Reuse durable consumer name for automatic restart recovery.",
  successRate: 1.0,
});
```

### Durable Consumer Pattern

```ts
const worker = await runtime.consumeAssignedWork(
  {
    subject: SUBJECTS.workflowRequest,
    stream: "OPENSIN_WORKFLOW_EVENTS",
    durableName: "my-worker",
    deliverPolicy: "all",
    ackWaitMs: 500,
  },
  async (event) => {
    console.log("received work", event.payload);
  },
);
```

> [!IMPORTANT]
> Reusing the same `durableName` after restart resumes from the last acked message — no context resend needed!

### Request / Reply

```ts
// Server side
const server = await bus.serveRequests(SUBJECTS.workflowRequest, async (request) => {
  return createEventEnvelope({
    kind: "workflow.reply",
    subject: SUBJECTS.workflowReply,
    source: { id: "a2a-sin-orchestrator", runtime: "agent-runtime" },
    correlationId: request.id,
    payload: { accepted: true },
  });
});

// Client side
const reply = await bus.request(
  createEventEnvelope({
    kind: "workflow.request",
    subject: SUBJECTS.workflowRequest,
    source: { id: "opencode-cli", runtime: "opencode-cli" },
    payload: { task: "resume durable work" },
  }),
);
```

### Ouroboros Bridge

The bus automatically invokes bridge methods when events include `ouroboros.rememberLesson` or `ouroboros.registerCapability`:

| Bridge Method | Purpose | Storage |
|:---|:---|:---|
| `rememberLesson(record)` | Store learned lessons for future agents | SQLite |
| `registerCapability(record)` | Register new agent capabilities | SQLite |

The Python SDK exposes `apply_event_envelope()` for mirroring JetStream envelopes into SQLite-backed memory.

---

## Deploy
| Methode | Target | Zweck |
|:---|:---|:---|
| **Local** | `docker compose up -d nats` | Development with embedded NATS |
| **OCI VM** | `92.5.60.87:4222` | Production NATS JetStream server |
| **Package** | `@opensin/neural-bus` (npm) | Shared library for all agents |
| **Box Storage** | `room-09-box-storage:3000` | Artifact/log storage via A2A-SIN-Box-Storage |

> [!WARNING]
> The production NATS server runs on the OCI VM. All agents must connect to `nats://92.5.60.87:4222` in production.

---

## Cloud Storage (A2A-SIN-Box-Storage)

Neural-Bus agents can persist artifacts (logs, crash dumps, reports, recordings) to **Box.com** via the fleet-wide `A2A-SIN-Box-Storage` service.

### Box Storage Access

| Property | Value |
|:---|:---|
| **Service** | `http://room-09-box-storage:3000` |
| **Static IP** | `172.20.0.109:3000` |
| **Upload** | `POST /api/v1/upload` |
| **Validate** | `POST /api/v1/validate` |
| **Auth** | `X-Box-Storage-Key: $BOX_STORAGE_API_KEY` |

### Usage Example

```bash
# Upload a log file to Box.com /Cache folder
curl -X POST "http://room-09-box-storage:3000/api/v1/upload" \
  -H "X-Box-Storage-Key: $BOX_STORAGE_API_KEY" \
  -F "file=@/tmp/jetstream-crash.log"

# Preflight validation
curl -X POST "http://room-09-box-storage:3000/api/v1/validate" \
  -H "Content-Type: application/json" \
  -d '{"filename":"crash.dump","size":5242880}'
```

### Python Integration

```python
import requests, os

BOX_URL = os.getenv("BOX_STORAGE_URL", "http://room-09-box-storage:3000")
BOX_KEY = os.getenv("BOX_STORAGE_API_KEY")

def upload_artifact(file_path: str, filename: str = None) -> dict:
    """Upload artifact to Box.com via A2A-SIN-Box-Storage"""
    filename = filename or os.path.basename(file_path)
    with open(file_path, "rb") as f:
        return requests.post(
            f"{BOX_URL}/api/v1/upload",
            headers={"X-Box-Storage-Key": BOX_KEY},
            files={"file": (filename, f)}
        ).json()
```

> **Note:** Box Storage replaces the deprecated GitLab Storage (`room-07-gitlab-storage`). See [Box Cloud Storage Docs](https://github.com/OpenSIN-AI/OpenSIN-documentation/blob/main/docs/storage/box-cloud-storage.md) for full migration guide.

---

## Documentation

| Document | Purpose |
|:---|:---|
| [Subject Taxonomy](docs/jetstream-subject-taxonomy.md) | Complete NATS subject hierarchy |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture deep dive |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

---

## Changelog

### v1.0.0 (2026-04-14)
- JetStream integration surface with stable connect/reconnect
- Validated event envelopes with correlation IDs
- Durable consumer pattern for restart recovery
- Request/reply helpers over NATS subjects
- Ouroboros bridge points (rememberLesson, registerCapability)
- Python SDK with SQLite-backed memory
- Documented subject taxonomy

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Start NATS: `docker compose up -d nats`
4. Install: `bun install`
5. Run tests: `bun test`
6. Commit and push
7. Open a Pull Request

---

## License

MIT. See [LICENSE](LICENSE) for details.

---

<p align="center">
  <sub>Built by <a href="https://github.com/OpenSIN-AI">OpenSIN-AI Fleet</a></sub>
</p>

<p align="right">(<a href="#readme-top">back to top</a>)</p>


---

## Agent Configuration System (v5)

This project is part of the OpenSIN-AI agent ecosystem and uses the unified agent configuration system:

| Datei | Zweck |
|:---|:---|
| `oh-my-sin.json` | Zentrales Team Register |
| `oh-my-openagent.json` | Subagenten-Modelle |
| `my-sin-team-infra.json` | Team Infrastructure Modelle |

### Subagenten-Modelle

| Subagent | Modell |
|:---|:---|
| **explore** | `nvidia-nim/stepfun-ai/step-3.5-flash` |
| **librarian** | `nvidia-nim/stepfun-ai/step-3.5-flash` |

### PARALLEL-EXPLORATION MANDATE

Bei Codebase-Analyse auf grossen Projekten MUESSEN Agenten **5-10 parallele explore + 5-10 librarian-Agenten** starten.

→ [Full Documentation](https://github.com/OpenSIN-AI/OpenSIN-documentation/blob/main/docs/guide/agent-configuration.md)
RecursiveMAS integration - see plan: https://github.com/OpenSIN-AI/OpenSIN-overview/blob/main/docs/03_ops/recursive-mas-integration.md
