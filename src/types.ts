/**
 * ==============================================================================
 * OpenSIN Neural Bus - Shared Type Definitions
 * ==============================================================================
 *
 * DESCRIPTION:
 * Shared TypeScript contracts for Neural Bus events and Ouroboros responses.
 *
 * WHY:
 * The MCP server, the Neural Bus runtime, and the tests must all agree on the
 * exact event/capability/lesson shapes. Centralizing the contracts keeps the
 * OpenSIN surface predictable for operators and future maintainers.
 *
 * CONSEQUENCES:
 * Validation helpers can return strongly typed objects, and the MCP handlers can
 * serialize a stable JSON shape without each caller reinventing the schema.
 * ==============================================================================
 */

/**
 * JSON primitive values are the only payload leaf types we allow because MCP and
 * NATS messages must be serializable without custom codecs.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * JSON values cover objects, arrays, and primitives. This prevents functions,
 * Dates, Maps, and other non-serializable runtime types from leaking into the
 * event envelope.
 */
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The standardized event envelope passed through the Neural Bus and returned by
 * the MCP server.
 */
export interface NeuralEventEnvelope<TPayload extends JsonValue = JsonValue> {
  eventId: string;
  topic: string;
  source: string;
  timestamp: string;
  payload: TPayload;
  correlationId?: string;
  causationId?: string;
  metadata?: Record<string, string>;
}

/**
 * Input accepted when callers publish a new event. Optional IDs/timestamps allow
 * replay and deterministic test fixtures while still defaulting safely in normal
 * usage.
 */
export interface PublishNeuralEventInput<TPayload extends JsonValue = JsonValue> {
  topic: string;
  source: string;
  payload: TPayload;
  eventId?: string;
  timestamp?: string;
  correlationId?: string;
  causationId?: string;
  metadata?: Record<string, string>;
}

/**
 * Connection settings for the real NATS-backed transport.
 */
export interface NeuralBusConnectionOptions {
  url: string;
  token?: string;
}

/**
 * Bounded listen options prevent the MCP tool from blocking forever.
 */
export interface ListenOptions {
  maxMessages?: number;
  signal?: AbortSignal;
}

/**
 * Collect options are the request/response friendly variant used by MCP.
 */
export interface CollectEventsOptions {
  maxMessages?: number;
  timeoutMs?: number;
}

/**
 * Query options for the local recent-event cache that the MCP server maintains.
 */
export interface QueryRecentEventsOptions {
  topic?: string;
  limit?: number;
}

/**
 * Capability records come from the Python Ouroboros registry and intentionally
 * preserve the snake_case column names that already exist in SQLite.
 */
export interface RegisteredCapability {
  capability_name: string;
  mcp_path: string;
  synthesized_by: string;
  timestamp: string;
}

/**
 * Procedural lesson records mirror the SQLite schema for the same reason as the
 * capability records above.
 */
export interface ProceduralLesson {
  id: number;
  agent_id: string;
  task_context: string;
  lesson_learned: string;
  success_rate: number | null;
  timestamp: string;
}

/**
 * Input for capability registration operations.
 */
export interface RegisterCapabilityInput {
  capability: string;
  path: string;
  agent: string;
}

/**
 * Input for capability searches.
 */
export interface QueryCapabilitiesInput {
  keyword?: string;
  limit?: number;
}

/**
 * Input for lesson searches.
 */
export interface QueryLessonsInput {
  keyword?: string;
  limit?: number;
}

/**
 * Internal helper input for seeding lessons in tests or support scripts.
 */
export interface RememberLessonInput {
  agentId: string;
  context: string;
  lesson: string;
  successRate?: number;
}

/**
 * The transport contract lets us keep the public Neural Bus API independent from
 * the wire implementation. Production uses NATS; tests use a lightweight fake.
 */
export interface NeuralBusTransport {
  connect(options: NeuralBusConnectionOptions): Promise<void>;
  publish(topic: string, encodedEnvelope: string): Promise<void>;
  subscribe(topic: string): AsyncIterable<string>;
  close(): Promise<void>;
}
