/**
 * ==============================================================================
 * OpenSIN Neural Bus - OpenCode JetStream Surface
 * ==============================================================================
 *
 * DESCRIPTION:
 * This class is the primary OpenCode/agent integration surface for Issue #8. It
 * wraps NATS JetStream with a deliberately small API for connect/reconnect,
 * publish, subscribe, durable consumers, request/reply, stream provisioning, and
 * debug tracing.
 *
 * WHY:
 * The raw NATS client is powerful, but it pushes too much transport detail into
 * every caller. A single reusable surface keeps OpenCode hooks, agent runtimes,
 * and future bridges aligned on the same envelope validation and consumer setup.
 *
 * CONSEQUENCES:
 * - Durable consumers use explicit manual-ack semantics by default.
 * - Default taxonomy streams can be provisioned automatically on first connect.
 * - Trace hooks expose the exact transport lifecycle without requiring operators
 *   to inspect the underlying NATS callbacks manually.
 * ==============================================================================
 */

import {
  connect,
  consumerOpts,
  createInbox,
  JetStreamClient,
  JetStreamManager,
  JsMsg,
  Msg,
  NatsConnection,
  StringCodec,
  Subscription,
} from "nats";
import {
  assertJetStreamEventEnvelope,
  EventEnvelope,
  parseJetStreamEventEnvelope,
} from "./event-envelope";
import {
  applyOuroborosBridgeUpdates,
  OuroborosBridge,
  OuroborosMutationBridge,
} from "./ouroboros-bridge";
import { DEFAULT_TAXONOMY_STREAMS, parseSubject } from "./subject-taxonomy";

export interface OpenCodeJetStreamConnectionOptions {
  servers: string | string[];
  token?: string;
  name?: string;
  connectTimeoutMs?: number;
  reconnectTimeWaitMs?: number;
  maxReconnectAttempts?: number;
  trace?: boolean | TraceHandler;
  autoProvisionTaxonomyStreams?: boolean;
  bridge?: OuroborosBridge;
}

export interface OpenSinStreamConfig {
  name: string;
  subjects: string[];
  description?: string;
}

export interface PublishEnvelopeOptions {
  ensureStream?: OpenSinStreamConfig;
}

export interface DurableSubscriptionOptions {
  subject: string;
  stream: string;
  durableName: string;
  deliverPolicy?: "all" | "last" | "new";
  ackWaitMs?: number;
  maxDeliver?: number;
  autoAck?: boolean;
  bridge?: OuroborosBridge;
}

export interface EphemeralSubscriptionOptions {
  subject: string;
  autoAck?: boolean;
  bridge?: OuroborosBridge;
}

export interface RequestOptions {
  timeoutMs?: number;
}

export interface CloseableSubscription {
  unsubscribe(): void;
  closed: Promise<void>;
}

// JetStream subscriptions yield `JsMsg` items instead of core `Msg` items. We
// model only the surface we actually consume so the wrapper does not depend on
// unstable upstream type aliases.
type JetStreamIterableSubscription = AsyncIterable<JsMsg> & {
  unsubscribe(): void;
  closed: Promise<void>;
};

export interface TraceEvent {
  action:
    | "connect"
    | "consume"
    | "disconnect"
    | "error"
    | "publish"
    | "reconnect"
    | "reply"
    | "request"
    | "stream.ensure"
    | "subscription.stop";
  subject?: string;
  envelopeId?: string;
  detail?: Record<string, unknown>;
}

export type TraceHandler = (event: TraceEvent) => void;

/**
 * The concrete JetStream wrapper used by OpenCode and agents.
 */
export class OpenCodeJetStreamClient {
  private readonly stringCodec = StringCodec();
  private readonly traceHandler?: TraceHandler;
  private readonly defaultBridge?: OuroborosBridge;
  private nc?: NatsConnection;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;

  private constructor(traceHandler?: TraceHandler, defaultBridge?: OuroborosBridge) {
    this.traceHandler = traceHandler;
    this.defaultBridge = defaultBridge;
  }

  /**
   * Connect and optionally auto-provision the default OpenSIN taxonomy streams.
   */
  static async connect(
    options: OpenCodeJetStreamConnectionOptions,
  ): Promise<OpenCodeJetStreamClient> {
    const traceHandler = normalizeTraceHandler(options.trace);
    const client = new OpenCodeJetStreamClient(traceHandler, options.bridge);

    client.nc = await connect({
      servers: options.servers,
      token: options.token,
      name: options.name,
      timeout: options.connectTimeoutMs,
      reconnectTimeWait: options.reconnectTimeWaitMs,
      maxReconnectAttempts: options.maxReconnectAttempts,
    });

    client.js = client.nc.jetstream();
    client.jsm = await client.nc.jetstreamManager();
    client.trace("connect", undefined, undefined, {
      connectedUrl: client.nc.getServer(),
      autoProvisionTaxonomyStreams: options.autoProvisionTaxonomyStreams !== false,
    });

    void client.nc.closed().then((error) => {
      client.trace(error ? "error" : "subscription.stop", undefined, undefined, {
        closed: true,
        error: error?.message,
      });
    });

    if (options.autoProvisionTaxonomyStreams !== false) {
      for (const stream of DEFAULT_TAXONOMY_STREAMS) {
        await client.ensureStream(stream);
      }
    }

    return client;
  }

  /**
   * Access the raw connection for advanced scenarios without making callers own
   * the entire transport lifecycle.
   */
  get connection(): NatsConnection {
    if (!this.nc) {
      throw new Error("OpenSIN JetStream client is not connected.");
    }
    return this.nc;
  }

  /**
   * Ensure a stream exists and contains the requested subject filters.
   */
  async ensureStream(config: OpenSinStreamConfig): Promise<void> {
    const manager = this.getManager();
    const normalizedSubjects = Array.from(new Set(config.subjects.map((subject) => subject.trim())));

    try {
      const existing = await manager.streams.info(config.name);
      const existingSubjects = existing.config.subjects ?? [];
      const mergedSubjects = Array.from(new Set([...existingSubjects, ...normalizedSubjects]));

      if (mergedSubjects.length !== existingSubjects.length) {
          await manager.streams.update(config.name, {
            ...existing.config,
            subjects: mergedSubjects,
            description: config.description ?? existing.config.description,
          });
        }

      this.trace("stream.ensure", undefined, undefined, {
        stream: config.name,
        subjects: mergedSubjects,
        existed: true,
      });
      return;
    } catch {
      await manager.streams.add({
        name: config.name,
        subjects: normalizedSubjects,
        description: config.description,
      });
      this.trace("stream.ensure", undefined, undefined, {
        stream: config.name,
        subjects: normalizedSubjects,
        existed: false,
      });
    }
  }

  /**
   * Publish one validated envelope into JetStream.
   */
  async publishEnvelope(
    envelope: EventEnvelope,
    options?: PublishEnvelopeOptions,
  ): Promise<void> {
    assertJetStreamEventEnvelope(envelope);
    if (options?.ensureStream) {
      await this.ensureStream(options.ensureStream);
    }

    await this.getJetStream().publish(
      envelope.subject,
      this.stringCodec.encode(JSON.stringify(envelope)),
    );
    this.trace("publish", envelope.subject, envelope.id, {
      kind: envelope.kind,
      durability: envelope.durability,
    });
  }

  /**
   * Subscribe to a durable JetStream consumer so replay and restart recovery are
   * handled by JetStream rather than fragile local state.
   */
  async subscribeDurable(
    options: DurableSubscriptionOptions,
    handler: (envelope: EventEnvelope, message: JsMsg) => Promise<void> | void,
  ): Promise<CloseableSubscription> {
    parseSubject(options.subject);
    await this.ensureStream({ name: options.stream, subjects: [options.subject] });

    const subscriptionOptions = consumerOpts();
    subscriptionOptions.bindStream(options.stream);
    subscriptionOptions.durable(options.durableName);
    subscriptionOptions.manualAck();
    subscriptionOptions.ackExplicit();
    subscriptionOptions.deliverTo(createInbox());
    subscriptionOptions.filterSubject(options.subject);

    if (options.deliverPolicy === "new") {
      subscriptionOptions.deliverNew();
    } else if (options.deliverPolicy === "last") {
      subscriptionOptions.deliverLast();
    } else {
      subscriptionOptions.deliverAll();
    }

    if (options.ackWaitMs !== undefined) {
      subscriptionOptions.ackWait(options.ackWaitMs);
    }
    if (options.maxDeliver !== undefined) {
      subscriptionOptions.maxDeliver(options.maxDeliver);
    }

    const subscription = await this.getJetStream().subscribe(options.subject, subscriptionOptions);
    return this.runJetStreamSubscription(subscription, options.autoAck !== false, options.bridge, handler);
  }

  /**
   * Subscribe to plain NATS subjects for lightweight request-reply or debug feeds.
   */
  async subscribeEphemeral(
    options: EphemeralSubscriptionOptions,
    handler: (envelope: EventEnvelope, message: Msg) => Promise<void> | void,
  ): Promise<CloseableSubscription> {
    parseSubject(options.subject);
    const subscription = this.connection.subscribe(options.subject);
    return this.runCoreSubscription(subscription, options.autoAck !== false, options.bridge, handler);
  }

  /**
   * Send a request envelope and await a reply envelope.
   */
  async request<TResponse = unknown>(
    envelope: EventEnvelope,
    options?: RequestOptions,
  ): Promise<EventEnvelope<TResponse>> {
    assertJetStreamEventEnvelope(envelope);
    const encodedEnvelope = this.stringCodec.encode(JSON.stringify(envelope));
    const reply =
      options?.timeoutMs === undefined
        ? await this.connection.request(envelope.subject, encodedEnvelope)
        : await this.connection.request(envelope.subject, encodedEnvelope, {
            timeout: options.timeoutMs,
          });
    const decoded = parseJetStreamEventEnvelope<TResponse>(this.stringCodec.decode(reply.data));
    this.trace("request", envelope.subject, envelope.id, {
      correlationId: envelope.correlationId,
      replyEnvelopeId: decoded.id,
    });
    return decoded;
  }

  /**
   * Serve request/reply traffic using the same envelope contract.
   */
  async serveRequests(
    subject: string,
    handler: (envelope: EventEnvelope, message: Msg) => Promise<EventEnvelope> | EventEnvelope,
  ): Promise<CloseableSubscription> {
    parseSubject(subject);
    const subscription = this.connection.subscribe(subject);
    const closed = (async () => {
      for await (const message of subscription) {
        const envelope = parseJetStreamEventEnvelope(this.stringCodec.decode(message.data));
        const response = await handler(envelope, message);
        assertJetStreamEventEnvelope(response);
        message.respond(this.stringCodec.encode(JSON.stringify(response)));
        this.trace("reply", subject, response.id, {
          requestEnvelopeId: envelope.id,
          correlationId: response.correlationId,
        });
      }
    })();

    return {
      unsubscribe: () => {
        subscription.unsubscribe();
        this.trace("subscription.stop", subject, undefined, { kind: "request-reply" });
      },
      closed,
    };
  }

  /**
   * Drain the connection so pending acknowledgements and replies can flush.
   */
  async close(): Promise<void> {
    if (!this.nc) {
      return;
    }
    await this.nc.drain();
    await this.nc.close();
    this.trace("subscription.stop", undefined, undefined, { closedBy: "client.close" });
  }

  private async runJetStreamSubscription(
    subscription: JetStreamIterableSubscription,
    autoAck: boolean,
    bridge: OuroborosMutationBridge | undefined,
    handler: (envelope: EventEnvelope, message: JsMsg) => Promise<void> | void,
  ): Promise<CloseableSubscription> {
    const closed = (async () => {
      for await (const message of subscription) {
        const envelope = parseJetStreamEventEnvelope(this.stringCodec.decode(message.data));
        this.trace("consume", envelope.subject, envelope.id, {
          kind: envelope.kind,
          durableConsumer: true,
          redeliveryCount: message.info?.redeliveryCount,
        });

        try {
          await handler(envelope, message);
          await applyOuroborosBridgeUpdates(bridge ?? this.defaultBridge, envelope);
          if (autoAck) {
            message.ack();
          }
        } catch (error) {
          message.nak?.();
          this.trace("error", envelope.subject, envelope.id, {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
    })();

    return {
      unsubscribe: () => {
        subscription.unsubscribe();
        this.trace("subscription.stop", undefined, undefined, { kind: "durable" });
      },
      closed,
    };
  }

  private async runCoreSubscription(
    subscription: Subscription,
    autoAck: boolean,
    bridge: OuroborosMutationBridge | undefined,
    handler: (envelope: EventEnvelope, message: Msg) => Promise<void> | void,
  ): Promise<CloseableSubscription> {
    const closed = (async () => {
      for await (const message of subscription) {
        const envelope = parseJetStreamEventEnvelope(this.stringCodec.decode(message.data));
        this.trace("consume", envelope.subject, envelope.id, {
          kind: envelope.kind,
          durableConsumer: false,
        });
        await handler(envelope, message);
        await applyOuroborosBridgeUpdates(bridge ?? this.defaultBridge, envelope);
        if (autoAck && isJetStreamMessage(message)) {
          message.ack();
        }
      }
    })();

    return {
      unsubscribe: () => {
        subscription.unsubscribe();
        this.trace("subscription.stop", undefined, undefined, { kind: "ephemeral" });
      },
      closed,
    };
  }

  private getJetStream(): JetStreamClient {
    if (!this.js) {
      throw new Error("OpenSIN JetStream client is not connected.");
    }
    return this.js;
  }

  private getManager(): JetStreamManager {
    if (!this.jsm) {
      throw new Error("OpenSIN JetStream manager is not connected.");
    }
    return this.jsm;
  }

  private trace(
    action: TraceEvent["action"],
    subject?: string,
    envelopeId?: string,
    detail?: Record<string, unknown>,
  ): void {
    this.traceHandler?.({ action, subject, envelopeId, detail });
  }
}

function isJetStreamMessage(message: Msg | JsMsg): message is JsMsg {
  return typeof (message as Partial<JsMsg>).ack === "function";
}

function normalizeTraceHandler(trace: boolean | TraceHandler | undefined): TraceHandler | undefined {
  if (typeof trace === "function") {
    return trace;
  }
  if (trace) {
    return (event) => {
      const detail = event.detail ? ` ${JSON.stringify(event.detail)}` : "";
      const subject = event.subject ? ` subject=${event.subject}` : "";
      const envelopeId = event.envelopeId ? ` envelope=${event.envelopeId}` : "";
      console.log(`[OpenSIN JetStream] ${event.action}${subject}${envelopeId}${detail}`);
    };
  }
  return undefined;
}
