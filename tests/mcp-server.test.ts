/**
 * ==============================================================================
 * OpenSIN Neural Bus - MCP Server Flow Tests
 * ==============================================================================
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NeuralBus } from '../src/neural-bus';
import { RecentEventStore } from '../src/recent-event-store';
import { NeuralBusMcpServer } from '../src/mcp-server';
import { OuroborosPythonBridge } from '../src/ouroboros-python-bridge';
import { FakeNeuralBusTransport } from './fake-transport';

/**
 * Helper to keep JSON parsing noise out of the actual assertions.
 */
function parseTextResponse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

test('MCP server exposes the expected OpenSIN tool surface', () => {
  const server = new NeuralBusMcpServer({
    bus: new NeuralBus(new FakeNeuralBusTransport(), new RecentEventStore(50)),
    neuralBusUrl: 'nats://example.invalid:4222',
  });

  const toolNames = server.listTools().map((tool) => tool.name).sort();

  assert.deepEqual(toolNames, [
    'opensin_listen_events',
    'opensin_publish_event',
    'opensin_query_capabilities',
    'opensin_query_recent_events',
    'opensin_query_recent_lessons',
    'opensin_register_capability',
  ]);
});

test('publish and query flows work through the MCP surface', async () => {
  const transport = new FakeNeuralBusTransport();
  const bus = new NeuralBus(transport, new RecentEventStore(50));
  const server = new NeuralBusMcpServer({
    bus,
    neuralBusUrl: 'nats://example.invalid:4222',
  });

  const publishResult = await server.handleToolCall('opensin_publish_event', {
    topic: 'fleet.context.sync',
    source: 'SIN-Test-Agent',
    payload: {
      capability: 'neural-bus-mcp',
      mode: 'publish',
    },
    metadata: {
      environment: 'test',
    },
  });

  const published = parseTextResponse(publishResult);
  assert.equal(published.event.topic, 'fleet.context.sync');
  assert.equal(published.event.metadata.environment, 'test');

  const queryResult = await server.handleToolCall('opensin_query_recent_events', {
    topic: 'fleet.context.sync',
    limit: 5,
  });

  const queried = parseTextResponse(queryResult);
  assert.equal(queried.observedCount, 1);
  assert.equal(queried.events[0].source, 'SIN-Test-Agent');
});

test('listen flow captures a live event through the MCP surface', async () => {
  const transport = new FakeNeuralBusTransport();
  const bus = new NeuralBus(transport, new RecentEventStore(50));
  const server = new NeuralBusMcpServer({
    bus,
    neuralBusUrl: 'nats://example.invalid:4222',
  });

  const listenPromise = server.handleToolCall('opensin_listen_events', {
    topic: 'fleet.live.goal',
    maxMessages: 1,
    timeoutMs: 500,
  });

  await new Promise((resolve) => setTimeout(resolve, 25));

  await server.handleToolCall('opensin_publish_event', {
    topic: 'fleet.live.goal',
    source: 'SIN-Live-Publisher',
    payload: {
      mission: 'listen-test',
    },
  });

  const listenResult = parseTextResponse(await listenPromise);
  assert.equal(listenResult.observedCount, 1);
  assert.equal(listenResult.events[0].payload.mission, 'listen-test');
});

test('capability registration and lesson queries work through the bridge-backed MCP surface', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opensin-neural-bus-'));
  const dbPath = path.join(tempRoot, 'ouroboros.sqlite');
  const bridge = new OuroborosPythonBridge({ dbPath });
  const server = new NeuralBusMcpServer({
    bus: new NeuralBus(new FakeNeuralBusTransport(), new RecentEventStore(20)),
    ouroboros: bridge,
    neuralBusUrl: 'nats://example.invalid:4222',
  });

  try {
    await bridge.rememberLesson({
      agentId: 'SIN-Knowledge-Agent',
      context: 'capability registry',
      lesson: 'Always expose durable MCP addresses through Ouroboros.',
      successRate: 1,
    });

    const registerResult = parseTextResponse(
      await server.handleToolCall('opensin_register_capability', {
        capability: 'neural-bus-mcp',
        path: 'sin://fleet/neural-bus/mcp',
        agent: 'SIN-Test-Agent',
      }),
    );

    assert.equal(registerResult.capability.capability_name, 'neural-bus-mcp');

    const capabilityQuery = parseTextResponse(
      await server.handleToolCall('opensin_query_capabilities', {
        keyword: 'neural-bus',
        limit: 5,
      }),
    );

    assert.equal(capabilityQuery.count, 1);
    assert.equal(capabilityQuery.capabilities[0].mcp_path, 'sin://fleet/neural-bus/mcp');

    const lessonQuery = parseTextResponse(
      await server.handleToolCall('opensin_query_recent_lessons', {
        keyword: 'capability',
        limit: 5,
      }),
    );

    assert.equal(lessonQuery.count, 1);
    assert.match(lessonQuery.lessons[0].lesson_learned, /Ouroboros/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
