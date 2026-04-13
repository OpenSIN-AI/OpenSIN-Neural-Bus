<div align="center">
  <h1>🧠 OpenSIN-Neural-Bus</h1>
  <p><strong>OpenSIN JetStream spine for OpenCode and agent runtimes</strong></p>
</div>

## What is in this repo?
This repository now exposes a first-class JetStream integration surface for OpenSIN/OpenCode runtimes:

- stable connect / reconnect wrapper
- validated event envelopes
- documented subject taxonomy
- durable consumer helpers
- request / reply helpers
- reusable agent runtime publish/consume patterns
- automatic bridge points into Ouroboros memory and capability updates

## Core exports

```ts
import {
  OpenCodeJetStreamClient,
  OpenSinAgentRuntime,
  SUBJECTS,
  createEventEnvelope,
} from "@opensin/neural-bus";
```

## Quick start

```ts
import {
  OpenCodeJetStreamClient,
  OpenSinAgentRuntime,
  SUBJECTS,
  createEventEnvelope,
} from "@opensin/neural-bus";

const bus = await OpenCodeJetStreamClient.connect({
  servers: "nats://127.0.0.1:4222",
  trace: true,
});

const runtime = new OpenSinAgentRuntime({
  agentId: "a2a-sin-hermes",
  sessionId: "session-001",
  bus,
});

await runtime.publishObservation({
  message: "worker booted",
  branch: "feat/issue-8-jetstream-opencode-hardwire",
});

await runtime.publishLessonLearned({
  context: "JetStream reconnect handling",
  lesson: "Reuse the same durable consumer name so restart recovery is automatic.",
  successRate: 1.0,
});

const request = createEventEnvelope({
  kind: "workflow.request",
  subject: SUBJECTS.workflowRequest,
  source: {
    id: "opencode-cli",
    runtime: "opencode-cli",
    sessionId: "cli-session-001",
  },
  payload: {
    objective: "continue issue #8 work",
  },
});

await bus.publishEnvelope(request);
```

## Durable consumer pattern

```ts
const worker = await runtime.consumeAssignedWork(
  {
    subject: SUBJECTS.workflowRequest,
    stream: "OPENSIN_WORKFLOW_EVENTS",
    durableName: "issue-8-worker",
    deliverPolicy: "all",
    ackWaitMs: 500,
  },
  async (event) => {
    console.log("received work", event.payload);
  },
);
```

Reusing `issue-8-worker` after a restart resumes from the last acked message instead of forcing the operator to resend context.

## Request / reply

```ts
const server = await bus.serveRequests(SUBJECTS.workflowRequest, async (request) => {
  return createEventEnvelope({
    kind: "workflow.reply",
    subject: SUBJECTS.workflowReply,
    source: {
      id: "a2a-sin-orchestrator",
      runtime: "agent-runtime",
    },
    correlationId: request.id,
    payload: {
      accepted: true,
    },
  });
});

const reply = await bus.request(
  createEventEnvelope({
    kind: "workflow.request",
    subject: SUBJECTS.workflowRequest,
    source: {
      id: "opencode-cli",
      runtime: "opencode-cli",
    },
    payload: { task: "resume durable work" },
  }),
);
```

## Ouroboros bridge points
The TypeScript bus surface accepts a bridge object with two methods:

- `rememberLesson(record)`
- `registerCapability(record)`

If an event includes `ouroboros.rememberLesson` or `ouroboros.registerCapability`, the bridge is invoked automatically after successful handling. The Python SDK now also exposes `apply_event_envelope()` so JetStream envelopes can be mirrored into SQLite-backed memory directly.

## Subject taxonomy
See [`docs/jetstream-subject-taxonomy.md`](docs/jetstream-subject-taxonomy.md).

## Docker-backed local verification
Start a local JetStream server:

```bash
docker compose up -d nats
```

Then run:

```bash
npm install
npm test
```

The Node tests cover publish / subscribe, request / reply, durable resume, and replay behavior. The Python tests cover durability, backup/restore, legacy migration, sync outbox, and Ouroboros event ingestion.
