# OpenCode JetStream Wiring Example

This repository does not own the global `opencode.json`, but Issue #8 requires a documented OpenCode-side integration surface. The practical shape is:

```json
{
  "neuralBus": {
    "servers": ["nats://127.0.0.1:4222"],
    "token": "${NATS_AUTH_TOKEN}",
    "trace": true,
    "autoProvisionTaxonomyStreams": true,
    "durables": {
      "workflowWorker": "issue-8-worker",
      "operatorContext": "operator-context-cache"
    }
  }
}
```

## Recommended runtime behavior
1. Connect the OpenCode process once at startup.
2. Auto-provision the OpenSIN taxonomy streams.
3. Publish operator directives/context to `opensin.ops.operator.*`.
4. Consume work from durable workflow subjects.
5. Publish lessons/capabilities as durable events with Ouroboros hints.
6. Reuse the same durable names after restart.

## Why this removes repeated operator instructions
Operator instructions become durable workflow or context events instead of ephemeral terminal history. When the same durable consumer reconnects, it resumes from the last acked event and can also mirror important lessons into Ouroboros memory for future context injection.
