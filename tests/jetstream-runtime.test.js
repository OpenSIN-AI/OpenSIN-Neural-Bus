const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OpenCodeJetStreamClient,
  OpenSinAgentRuntime,
  SUBJECTS,
  buildSubject,
  createJetStreamEventEnvelope,
  parseSubject,
} = require("../dist/src/index.js");

const NATS_URL = process.env.OPENSIN_NATS_URL || "nats://127.0.0.1:4222";

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

test("subject taxonomy and envelopes stay canonical", async () => {
  const agentSubject = SUBJECTS.agentObservation("A2A-SIN-Hermes");
  assert.equal(agentSubject, "opensin.agent.a2a-sin-hermes.observation");
  assert.deepEqual(parseSubject(agentSubject).segments, ["a2a-sin-hermes", "observation"]);

  const customSubject = buildSubject("workflow", "issue-8", "request");
  const envelope = createJetStreamEventEnvelope({
    kind: "workflow.request",
    subject: customSubject,
    source: {
      id: "opencode-cli",
      runtime: "opencode-cli",
      sessionId: "session-001",
    },
    payload: {
      objective: "continue jetstream work",
    },
  });

  assert.equal(envelope.subject, "opensin.workflow.issue-8.request");
  assert.equal(envelope.durability, "durable");
});

test("publish and durable replay work against a real JetStream server", async () => {
  const suffix = uniqueSuffix();
  const subject = buildSubject("workflow", `issue-${suffix}`, "request");
  const stream = `OPENSIN_TEST_${suffix.replace(/-/g, "_").toUpperCase()}`;
  const bus = await OpenCodeJetStreamClient.connect({
    servers: NATS_URL,
    autoProvisionTaxonomyStreams: false,
  });

  try {
    await bus.ensureStream({
      name: stream,
      subjects: [subject],
    });

    const publishedIds = [];
    for (let index = 0; index < 2; index += 1) {
      const envelope = createJetStreamEventEnvelope({
        kind: "workflow.request",
        subject,
        source: {
          id: "opencode-cli",
          runtime: "opencode-cli",
        },
        payload: {
          index,
        },
      });
      publishedIds.push(envelope.id);
      await bus.publishEnvelope(envelope);
    }

    const firstDelivery = [];
    const replayDelivery = [];

    const firstConsumer = await bus.subscribeDurable(
      {
        subject,
        stream,
        durableName: `worker-${suffix}-first`,
        deliverPolicy: "all",
        ackWaitMs: 500,
      },
      async (envelope) => {
        firstDelivery.push(envelope.id);
      },
    );

    await waitFor(() => firstDelivery.length === 2);
    firstConsumer.unsubscribe();
    await firstConsumer.closed;

    const replayConsumer = await bus.subscribeDurable(
      {
        subject,
        stream,
        durableName: `worker-${suffix}-replay`,
        deliverPolicy: "all",
        ackWaitMs: 500,
      },
      async (envelope) => {
        replayDelivery.push(envelope.id);
      },
    );

    await waitFor(() => replayDelivery.length === 2);
    replayConsumer.unsubscribe();
    await replayConsumer.closed;

    assert.deepEqual(firstDelivery, publishedIds);
    assert.deepEqual(replayDelivery, publishedIds);
  } finally {
    await bus.close();
  }
});

test("durable consumers resume unacked events after restart-like resubscribe", async () => {
  const suffix = uniqueSuffix();
  const subject = buildSubject("workflow", `resume-${suffix}`, "request");
  const stream = `OPENSIN_RESUME_${suffix.replace(/-/g, "_").toUpperCase()}`;
  const bus = await OpenCodeJetStreamClient.connect({
    servers: NATS_URL,
    autoProvisionTaxonomyStreams: false,
  });

  try {
    await bus.ensureStream({
      name: stream,
      subjects: [subject],
    });

    const envelope = createJetStreamEventEnvelope({
      kind: "workflow.request",
      subject,
      source: {
        id: "opencode-cli",
        runtime: "opencode-cli",
      },
      payload: {
        objective: "prove resume",
      },
    });
    await bus.publishEnvelope(envelope);

    const durableName = `worker-${suffix}-resume`;
    const firstSeen = [];
    let firstConsumer;
    firstConsumer = await bus.subscribeDurable(
      {
        subject,
        stream,
        durableName,
        deliverPolicy: "all",
        ackWaitMs: 200,
        autoAck: false,
      },
      async (receivedEnvelope) => {
        firstSeen.push(receivedEnvelope.id);
        if (firstSeen.length === 1) {
          setTimeout(() => firstConsumer.unsubscribe(), 0);
        }
      },
    );

    await waitFor(() => firstSeen.length === 1);
    await firstConsumer.closed;
    await delay(250);

    const replayed = [];
    let secondConsumer;
    secondConsumer = await bus.subscribeDurable(
      {
        subject,
        stream,
        durableName,
        deliverPolicy: "all",
        ackWaitMs: 200,
        autoAck: false,
      },
      async (receivedEnvelope, message) => {
        replayed.push(receivedEnvelope.id);
        message.ack();
        setTimeout(() => secondConsumer.unsubscribe(), 0);
      },
    );

    await waitFor(() => replayed.length === 1);
    await secondConsumer.closed;

    assert.deepEqual(firstSeen, [envelope.id]);
    assert.deepEqual(replayed, [envelope.id]);
  } finally {
    await bus.close();
  }
});

test("request reply works through the OpenSIN envelope surface", async () => {
  const suffix = uniqueSuffix();
  const subject = buildSubject("workflow", `rpc-${suffix}`, "request");
  const bus = await OpenCodeJetStreamClient.connect({
    servers: NATS_URL,
    autoProvisionTaxonomyStreams: false,
  });

  try {
    const server = await bus.serveRequests(subject, async (requestEnvelope) => {
      return createJetStreamEventEnvelope({
        kind: "workflow.reply",
        subject: buildSubject("workflow", `rpc-${suffix}`, "reply"),
        source: {
          id: "a2a-sin-orchestrator",
          runtime: "agent-runtime",
        },
        correlationId: requestEnvelope.id,
        payload: {
          accepted: true,
          mirroredObjective: requestEnvelope.payload.objective,
        },
      });
    });

    const reply = await bus.request(
      createJetStreamEventEnvelope({
        kind: "workflow.request",
        subject,
        source: {
          id: "opencode-cli",
          runtime: "opencode-cli",
        },
        payload: {
          objective: "resume durable worker",
        },
      }),
      { timeoutMs: 2000 },
    );

    server.unsubscribe();
    await server.closed;

    assert.equal(reply.kind, "workflow.reply");
    assert.equal(reply.payload.accepted, true);
    assert.equal(reply.payload.mirroredObjective, "resume durable worker");
  } finally {
    await bus.close();
  }
});

test("agent runtime emits lesson and capability events with bus-native bridge hints", async () => {
  const suffix = uniqueSuffix();
  const published = [];
  const fakeBus = {
    async publishEnvelope(envelope) {
      published.push(envelope);
    },
  };

  const runtime = new OpenSinAgentRuntime({
    agentId: `agent-${suffix}`,
    sessionId: "session-issue-8",
    bus: fakeBus,
  });

  const lessonEnvelope = await runtime.publishLessonLearned({
    context: "resume semantics",
    lesson: "reuse the same durable consumer name",
    successRate: 1,
  });
  const capabilityEnvelope = await runtime.publishCapabilityRegistration({
    capability: "jetstream-bridge",
    path: "/srv/mcp/jetstream-bridge.py",
  });

  assert.equal(lessonEnvelope.ouroboros.rememberLesson.context, "resume semantics");
  assert.equal(capabilityEnvelope.ouroboros.registerCapability.capability, "jetstream-bridge");
  assert.equal(published.length, 2);
  assert.equal(published[0].kind, "memory.lesson.learned");
  assert.equal(published[1].kind, "capability.registered");
});
