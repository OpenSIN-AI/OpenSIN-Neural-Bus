/**
 * ==============================================================================
 * OpenSIN Neural Bus - Core Runtime
 * ==============================================================================
 *
 * DESCRIPTION:
 * Public TypeScript API for publishing and listening on the OpenSIN Neural Bus.
 *
 * WHY:
 * The MCP server and any future Node-based agents need one shared runtime layer
 * for event publication, live listening, and recent-event recall.
 *
 * CONSEQUENCES:
 * Production traffic uses the NATS-backed transport, while tests can inject a
 * fake transport to verify behavior without a running broker.
 * ==============================================================================
 */

import { connect, JetStreamClient, NatsConnection, StringCodec } from 'nats';

import { RecentEventStore } from './recent-event-store';
import {
  CollectEventsOptions,
  ListenOptions,
  NeuralBusConnectionOptions,
  NeuralBusTransport,
  NeuralEventEnvelope,
  PublishNeuralEventInput,
  QueryRecentEventsOptions,
} from './types';
import {
  createEventEnvelope,
  validateEventEnvelope,
  validateNonEmptyString,
  validateOptionalPositiveInteger,
} from './validation';

/**
 * Real transport implementation that talks to NATS + JetStream.
 */
export class NatsNeuralBusTransport implements NeuralBusTransport {
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private readonly codec = StringCodec();

  /**
   * Connect lazily so the MCP server can boot even when operators only want the
   * Ouroboros registry tools.
   */
  async connect(options: NeuralBusConnectionOptions): Promise<void> {
    this.nc = await connect({ servers: options.url, token: options.token });
    this.js = this.nc.jetstream();
  }

  /**
   * Publishing goes through JetStream so deployments that already rely on stream
   * retention keep that behavior.
   */
  async publish(topic: string, encodedEnvelope: string): Promise<void> {
    if (!this.js) {
      throw new Error('Neural Bus transport is not connected.');
    }

    await this.js.publish(topic, this.codec.encode(encodedEnvelope));
  }

  /**
   * Subscribe yields decoded strings so higher layers can focus on envelope
   * validation rather than wire codecs.
   */
  async *subscribe(topic: string): AsyncIterable<string> {
    if (!this.nc) {
      throw new Error('Neural Bus transport is not connected.');
    }

    const subscription = this.nc.subscribe(topic);

    try {
      for await (const message of subscription) {
        yield this.codec.decode(message.data);
      }
    } finally {
      subscription.unsubscribe();
    }
  }

  /**
   * Close is idempotent so callers can safely invoke it during shutdown paths.
   */
  async close(): Promise<void> {
    await this.nc?.close();
    this.nc = undefined;
    this.js = undefined;
  }
}

/**
 * High-level bus API used by the MCP surface and by direct library consumers.
 */
export class NeuralBus {
  constructor(
    private readonly transport: NeuralBusTransport = new NatsNeuralBusTransport(),
    private readonly recentEvents: RecentEventStore = new RecentEventStore(),
  ) {}

  /**
   * Explicit connect keeps backwards compatibility with the original entrypoint
   * shape while allowing callers to decide when network I/O should happen.
   */
  async connect(options: NeuralBusConnectionOptions): Promise<void> {
    await this.transport.connect(options);
    console.log(`[Neural-Bus] Connected to ${options.url}`);
  }

  /**
   * Publish a fully typed and validated event envelope.
   */
  async publishEvent<TPayload extends PublishNeuralEventInput['payload']>(
    input: PublishNeuralEventInput<TPayload>,
  ): Promise<NeuralEventEnvelope<TPayload>> {
    const envelope = createEventEnvelope(input);
    await this.transport.publish(envelope.topic, JSON.stringify(envelope));
    this.recentEvents.remember(envelope);
    return envelope;
  }

  /**
   * Legacy alias preserved so existing callers using the original SDK surface do
   * not break while the repo evolves toward the richer envelope API.
   */
  async emit(topic: string, source: string, payload: PublishNeuralEventInput['payload']) {
    return this.publishEvent({ topic, source, payload });
  }

  /**
   * Listen to live events on a topic. The loop is intentionally bounded by the
   * provided signal and/or message count to stay safe for CLI-driven callers.
   */
  async listen(
    topic: string,
    callback: (event: NeuralEventEnvelope) => void | Promise<void>,
    options: ListenOptions = {},
  ): Promise<void> {
    const normalizedTopic = validateNonEmptyString(topic, 'topic');
    const maxMessages = options.maxMessages;
    let messageCount = 0;

    for await (const rawEvent of this.transport.subscribe(normalizedTopic)) {
      if (options.signal?.aborted) {
        break;
      }

      try {
        const decoded = JSON.parse(rawEvent) as unknown;
        const envelope = validateEventEnvelope(decoded);
        this.recentEvents.remember(envelope);
        await callback(envelope);
        messageCount += 1;

        if (maxMessages !== undefined && messageCount >= maxMessages) {
          break;
        }
      } catch (error) {
        console.error('[Neural-Bus] Failed to parse event', error);
      }
    }
  }

  /**
   * Request/response helper used by the MCP listen tool. It waits for a bounded
   * amount of time and returns the captured envelopes as JSON.
   */
  async collectEvents(topic: string, options: CollectEventsOptions = {}): Promise<NeuralEventEnvelope[]> {
    const maxMessages = validateOptionalPositiveInteger(options.maxMessages, 'maxMessages', 5);
    const timeoutMs = validateOptionalPositiveInteger(options.timeoutMs, 'timeoutMs', 1000);
    const controller = new AbortController();
    const collected: NeuralEventEnvelope[] = [];
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      await this.listen(
        topic,
        (event) => {
          collected.push(event);
        },
        { maxMessages, signal: controller.signal },
      );
    } finally {
      clearTimeout(timeout);
    }

    return collected;
  }

  /**
   * Exposes the rolling cache for operator queries.
   */
  queryRecentEvents(options: QueryRecentEventsOptions = {}): NeuralEventEnvelope[] {
    const limit = validateOptionalPositiveInteger(options.limit, 'limit', 10);
    const normalizedTopic =
      options.topic === undefined ? undefined : validateNonEmptyString(options.topic, 'topic');

    return this.recentEvents.query({ topic: normalizedTopic, limit });
  }

  /**
   * Clean shutdown helper.
   */
  async close(): Promise<void> {
    await this.transport.close();
  }
}
