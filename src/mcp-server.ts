#!/usr/bin/env node
/**
 * ==============================================================================
 * OpenSIN Neural Bus - MCP Server Entry Point
 * ==============================================================================
 *
 * DESCRIPTION:
 * First-class OpenCode MCP surface for Neural Bus and Ouroboros operations.
 *
 * WHY:
 * Operators should be able to publish events, inspect recent traffic, register
 * capabilities, and pull recent lessons directly from OpenCode without manually
 * recreating the same context in every session.
 *
 * CONSEQUENCES:
 * The MCP server becomes the canonical OpenCode-native adapter between the Node
 * Neural Bus runtime and the Python Ouroboros registry.
 * ==============================================================================
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { NeuralBus } from './neural-bus';
import { RecentEventStore } from './recent-event-store';
import { OuroborosPythonBridge } from './ouroboros-python-bridge';
import { JsonValue } from './types';
import {
  isJsonValue,
  isPlainObject,
  validateNonEmptyString,
  validateOptionalPositiveInteger,
  validateStringRecord,
} from './validation';

/**
 * Lightweight JSON schema type so the tool definitions stay explicit and easy to
 * test without importing SDK-specific helper builders.
 */
interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  additionalProperties?: boolean;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
}

/**
 * Tool definitions are declared in one place so list-tools and tests stay in
 * sync.
 */
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/**
 * Options make the server testable and configurable without duplicating logic.
 */
export interface NeuralBusMcpServerOptions {
  bus?: NeuralBus;
  ouroboros?: OuroborosPythonBridge;
  neuralBusUrl?: string;
  neuralBusToken?: string;
  recentEventCacheSize?: number;
}

/**
 * Main MCP server wrapper.
 */
export class NeuralBusMcpServer {
  private readonly server: Server;
  private readonly bus: NeuralBus;
  private readonly ouroboros: OuroborosPythonBridge;
  private readonly neuralBusUrl?: string;
  private readonly neuralBusToken?: string;
  private busConnected = false;

  constructor(options: NeuralBusMcpServerOptions = {}) {
    this.bus =
      options.bus ??
      new NeuralBus(undefined, new RecentEventStore(options.recentEventCacheSize ?? 200));
    this.ouroboros = options.ouroboros ?? new OuroborosPythonBridge();
    this.neuralBusUrl = options.neuralBusUrl ?? process.env.NEURAL_BUS_URL;
    this.neuralBusToken = options.neuralBusToken ?? process.env.NEURAL_BUS_TOKEN;

    this.server = new Server(
      {
        name: 'opensin-neural-bus',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.listTools(),
    }));

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: { params: { name: string; arguments?: unknown } }) => {
        return this.handleToolCall(request.params.name, request.params.arguments ?? {});
      },
    );
  }

  /**
   * Public tool inventory for tests and for the MCP list-tools handler.
   */
  listTools(): ToolDefinition[] {
    return [
      {
        name: 'opensin_publish_event',
        description: 'Publish a validated OpenSIN Neural Bus event envelope.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['topic', 'source', 'payload'],
          properties: {
            topic: { type: 'string', description: 'Neural Bus topic / subject.' },
            source: { type: 'string', description: 'Agent or component emitting the event.' },
            payload: {
              description: 'JSON payload carried inside the event envelope.',
              anyOf: [
                { type: 'object' },
                { type: 'array' },
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                { type: 'null' },
              ],
            },
            eventId: { type: 'string', description: 'Optional deterministic event ID.' },
            timestamp: { type: 'string', description: 'Optional ISO timestamp override.' },
            correlationId: { type: 'string', description: 'Optional tracing correlation ID.' },
            causationId: { type: 'string', description: 'Optional parent event ID.' },
            metadata: { type: 'object', description: 'Optional string:string metadata.' },
          },
        },
      },
      {
        name: 'opensin_listen_events',
        description: 'Listen on a Neural Bus topic for a bounded number of live events.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['topic'],
          properties: {
            topic: { type: 'string', description: 'Neural Bus topic / subject to observe.' },
            maxMessages: { type: 'number', description: 'Maximum live events to capture.' },
            timeoutMs: { type: 'number', description: 'Maximum wait time in milliseconds.' },
          },
        },
      },
      {
        name: 'opensin_query_recent_events',
        description: 'Query the MCP server\'s recent-event cache for operator context.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            topic: { type: 'string', description: 'Optional exact topic filter.' },
            limit: { type: 'number', description: 'Maximum cached events to return.' },
          },
        },
      },
      {
        name: 'opensin_register_capability',
        description: 'Register a capability path in the Ouroboros capability registry.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['capability', 'path', 'agent'],
          properties: {
            capability: { type: 'string', description: 'Logical capability name.' },
            path: { type: 'string', description: 'MCP server path or address.' },
            agent: { type: 'string', description: 'Agent responsible for synthesis/ownership.' },
          },
        },
      },
      {
        name: 'opensin_query_capabilities',
        description: 'Query the Ouroboros capability registry.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            keyword: { type: 'string', description: 'Optional keyword filter.' },
            limit: { type: 'number', description: 'Maximum capability records to return.' },
          },
        },
      },
      {
        name: 'opensin_query_recent_lessons',
        description: 'Query recent Ouroboros procedural lessons for session context.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            keyword: { type: 'string', description: 'Optional context keyword filter.' },
            limit: { type: 'number', description: 'Maximum lessons to return.' },
          },
        },
      },
    ];
  }

  /**
   * Starts the stdio transport used by OpenCode MCP wiring.
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /**
   * Shared response path used by request handling and unit tests.
   */
  async handleToolCall(name: string, rawArguments: unknown) {
    const args = this.expectObject(rawArguments, 'arguments');

    switch (name) {
      case 'opensin_publish_event': {
        await this.ensureBusConnected();
        const payload = this.expectJsonPayload(args.payload);
        const event = await this.bus.publishEvent({
          topic: validateNonEmptyString(args.topic, 'topic'),
          source: validateNonEmptyString(args.source, 'source'),
          payload,
          eventId: this.optionalString(args.eventId, 'eventId'),
          timestamp: this.optionalString(args.timestamp, 'timestamp'),
          correlationId: this.optionalString(args.correlationId, 'correlationId'),
          causationId: this.optionalString(args.causationId, 'causationId'),
          metadata: validateStringRecord(args.metadata, 'metadata'),
        });

        return this.jsonResponse({ event });
      }

      case 'opensin_listen_events': {
        await this.ensureBusConnected();
        const events = await this.bus.collectEvents(validateNonEmptyString(args.topic, 'topic'), {
          maxMessages: validateOptionalPositiveInteger(args.maxMessages, 'maxMessages', 5),
          timeoutMs: validateOptionalPositiveInteger(args.timeoutMs, 'timeoutMs', 1000),
        });

        return this.jsonResponse({ events, observedCount: events.length });
      }

      case 'opensin_query_recent_events': {
        const events = this.bus.queryRecentEvents({
          topic: args.topic === undefined ? undefined : validateNonEmptyString(args.topic, 'topic'),
          limit: validateOptionalPositiveInteger(args.limit, 'limit', 10),
        });

        return this.jsonResponse({ events, observedCount: events.length });
      }

      case 'opensin_register_capability': {
        const capability = await this.ouroboros.registerCapability({
          capability: validateNonEmptyString(args.capability, 'capability'),
          path: validateNonEmptyString(args.path, 'path'),
          agent: validateNonEmptyString(args.agent, 'agent'),
        });

        return this.jsonResponse({ capability });
      }

      case 'opensin_query_capabilities': {
        const capabilities = await this.ouroboros.queryCapabilities({
          keyword: args.keyword === undefined ? undefined : validateNonEmptyString(args.keyword, 'keyword'),
          limit: validateOptionalPositiveInteger(args.limit, 'limit', 20),
        });

        return this.jsonResponse({ capabilities, count: capabilities.length });
      }

      case 'opensin_query_recent_lessons': {
        const lessons = await this.ouroboros.queryRecentLessons({
          keyword: args.keyword === undefined ? undefined : validateNonEmptyString(args.keyword, 'keyword'),
          limit: validateOptionalPositiveInteger(args.limit, 'limit', 5),
        });

        return this.jsonResponse({ lessons, count: lessons.length });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Neural Bus network I/O is started only when event tools are invoked.
   */
  private async ensureBusConnected(): Promise<void> {
    if (this.busConnected) {
      return;
    }

    if (!this.neuralBusUrl) {
      throw new Error(
        'NEURAL_BUS_URL must be configured before using Neural Bus event tools.',
      );
    }

    await this.bus.connect({ url: this.neuralBusUrl, token: this.neuralBusToken });
    this.busConnected = true;
  }

  /**
   * Reusable object check for MCP arguments.
   */
  private expectObject(value: unknown, fieldName: string): Record<string, unknown> {
    if (!isPlainObject(value)) {
      throw new Error(`${fieldName} must be an object.`);
    }

    return value;
  }

  /**
   * Payloads must remain JSON-safe because they are serialized for both MCP and
   * NATS transport.
   */
  private expectJsonPayload(value: unknown): JsonValue {
    if (!isJsonValue(value)) {
      throw new Error('payload must be JSON serializable.');
    }

    return value;
  }

  /**
   * Optional strings still go through trimming/emptiness validation when set.
   */
  private optionalString(value: unknown, fieldName: string): string | undefined {
    return value === undefined ? undefined : validateNonEmptyString(value, fieldName);
  }

  /**
   * MCP text responses intentionally return pretty JSON so operators can read the
   * result directly in OpenCode logs without extra formatting tools.
   */
  private jsonResponse(payload: unknown) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }
}

/**
 * CLI bootstrap. The guard keeps tests from auto-starting stdio when they import
 * the module.
 */
async function main(): Promise<void> {
  const server = new NeuralBusMcpServer();
  await server.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[OpenSIN Neural Bus MCP] Fatal error', error);
    process.exit(1);
  });
}
