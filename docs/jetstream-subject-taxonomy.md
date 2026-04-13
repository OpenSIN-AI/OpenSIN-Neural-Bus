# OpenSIN JetStream Subject Taxonomy

## Why this exists
Issue #8 requires one durable subject contract that OpenCode, agent runtimes, and Ouroboros memory hooks can share without operators manually repeating routing instructions.

## Prefix rule
All OpenSIN traffic must live under:

```text
opensin.<namespace>.<segment>... 
```

Namespaces currently hard-wired by the SDK:

- `opensin.agent.>`
- `opensin.memory.>`
- `opensin.capability.>`
- `opensin.ops.>`
- `opensin.workflow.>`
- `opensin.fleet.>`
- `opensin.debug.>`

## Canonical subjects

| Purpose | Subject |
|---|---|
| Operator context broadcast | `opensin.ops.operator.context` |
| Operator directive broadcast | `opensin.ops.operator.directive` |
| Agent observation | `opensin.agent.<agent-id>.observation` |
| Agent task state | `opensin.agent.<agent-id>.task.state` |
| Agent task completed | `opensin.agent.<agent-id>.task.completed` |
| Agent task failed | `opensin.agent.<agent-id>.task.failed` |
| Capability registered | `opensin.capability.registry.registered` |
| Agent capability announcement | `opensin.agent.<agent-id>.capability.registered` |
| Lesson learned | `opensin.memory.lesson.learned` |
| Memory context request | `opensin.memory.context.requested` |
| Workflow request | `opensin.workflow.task.request` |
| Workflow reply | `opensin.workflow.task.reply` |
| Debug trace event | `opensin.debug.trace.event` |
| Fleet heartbeat | `opensin.fleet.heartbeat.<agent-id>` |

## Segment rules
- lowercase only
- digits allowed
- hyphens allowed
- no spaces
- no slashes or underscores in the final published segment

## Durable consumer guidance
- Use one durable name per logical worker role, not per process instance.
- Reuse the same durable name after restart to resume from the last acked message.
- Publish lessons and capabilities as durable events so Ouroboros can mirror them into persistent memory.
