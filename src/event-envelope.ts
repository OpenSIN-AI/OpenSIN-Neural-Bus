/**
 * ==============================================================================
 * OpenSIN Neural Bus - Typed Event Envelopes
 * ==============================================================================
 *
 * DESCRIPTION:
 * This file defines the validated event envelope shared by OpenCode and agent
 * runtimes when they publish onto JetStream.
 *
 * WHY:
 * Issue #8 explicitly requires typed and validated envelopes. The goal is not to
 * invent a giant schema framework; the goal is to keep envelopes small, stable,
 * inspectable, and safe enough that replayed durable traffic still means the same
 * thing after a restart.
 *
 * CONSEQUENCES:
 * - Every event carries subject, source, timestamps, and a trace id.
 * - Memory/capability hooks can be embedded directly in the envelope so Ouroboros
 *   updates happen automatically instead of relying on operators to repeat context.
 * ==============================================================================
 */

import { isOpenSinSubject, parseSubject } from "./subject-taxonomy";

/**
 * The fleet only needs a focused set of event kinds for Issue #8. We can grow
 * this later, but the initial list should remain concrete and reviewable.
 */
export type OpenSinEventKind =
  | "agent.observation"
  | "agent.task.state"
  | "agent.task.completed"
  | "agent.task.failed"
  | "capability.registered"
  | "debug.trace"
  | "memory.context.requested"
  | "memory.lesson.learned"
  | "operator.context"
  | "operator.directive"
  | "workflow.request"
  | "workflow.reply";

export type EnvelopeDurability = "durable" | "ephemeral";

/**
 * Source metadata is intentionally explicit because operators frequently need to
 * know which agent/session produced a replayed event.
 */
export interface EnvelopeSource {
  id: string;
  runtime: "agent-runtime" | "bridge" | "opencode-cli" | "system";
  capability?: string;
  sessionId?: string;
}

/**
 * Capability registration can be carried inline so JetStream traffic can drive
 * the Ouroboros capability registry automatically.
 */
export interface CapabilityRegistration {
  capability: string;
  path: string;
  synthesizedBy: string;
}

/**
 * Lesson capture is the minimum data Ouroboros needs to persist operator-free
 * memory updates.
 */
export interface LessonLearnedRecord {
  agentId: string;
  context: string;
  lesson: string;
  successRate?: number;
}

/**
 * Envelope-level memory hooks keep the contract simple: the event payload does
 * business work, and the `ouroboros` block explains which side effects should be
 * mirrored into durable memory.
 */
export interface OuroborosHints {
  rememberLesson?: LessonLearnedRecord;
  registerCapability?: CapabilityRegistration;
}

export interface EventEnvelope<TPayload = unknown> {
  specVersion: "1.0.0";
  id: string;
  kind: OpenSinEventKind;
  subject: string;
  time: string;
  traceId: string;
  correlationId?: string;
  durability: EnvelopeDurability;
  source: EnvelopeSource;
  headers: Record<string, string>;
  payload: TPayload;
  ouroboros?: OuroborosHints;
}

export interface CreateEventEnvelopeInput<TPayload> {
  kind: OpenSinEventKind;
  subject: string;
  source: EnvelopeSource;
  payload: TPayload;
  traceId?: string;
  correlationId?: string;
  durability?: EnvelopeDurability;
  headers?: Record<string, string>;
  ouroboros?: OuroborosHints;
}

/**
 * Generate a deterministic-enough event id without adding a new dependency. The
 * exact algorithm is less important than guaranteeing a unique-ish identifier per
 * publish in normal agent runtime conditions.
 */
function generateEventId(): string {
  const now = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `evt-${now}-${random}`;
}

/**
 * Create a validated event envelope.
 */
export function createJetStreamEventEnvelope<TPayload>(
  input: CreateEventEnvelopeInput<TPayload>,
): EventEnvelope<TPayload> {
  const envelope: EventEnvelope<TPayload> = {
    specVersion: "1.0.0",
    id: generateEventId(),
    kind: input.kind,
    subject: input.subject,
    time: new Date().toISOString(),
    traceId: input.traceId ?? generateEventId().replace(/^evt-/, "trace-"),
    correlationId: input.correlationId,
    durability: input.durability ?? "durable",
    source: input.source,
    headers: input.headers ?? {},
    payload: input.payload,
    ouroboros: input.ouroboros,
  };

  assertJetStreamEventEnvelope(envelope);
  return envelope;
}

/**
 * Parse an unknown payload into a validated envelope.
 */
export function parseJetStreamEventEnvelope<TPayload = unknown>(
  value: string | Uint8Array | unknown,
): EventEnvelope<TPayload> {
  let decoded: unknown = value;

  if (value instanceof Uint8Array) {
    decoded = new TextDecoder().decode(value);
  }
  if (typeof decoded === "string") {
    decoded = JSON.parse(decoded);
  }

  assertJetStreamEventEnvelope(decoded);
  return decoded as EventEnvelope<TPayload>;
}

/**
 * Runtime validator used by both publish and consume paths.
 */
export function assertJetStreamEventEnvelope(value: unknown): asserts value is EventEnvelope {
  if (!value || typeof value !== "object") {
    throw new Error("OpenSIN event envelope must be an object.");
  }

  const envelope = value as Partial<EventEnvelope>;

  if (envelope.specVersion !== "1.0.0") {
    throw new Error("OpenSIN event envelope specVersion must be 1.0.0.");
  }
  if (!envelope.id || typeof envelope.id !== "string") {
    throw new Error("OpenSIN event envelope requires a string id.");
  }
  if (!envelope.kind || typeof envelope.kind !== "string") {
    throw new Error("OpenSIN event envelope requires a string kind.");
  }
  if (!envelope.subject || typeof envelope.subject !== "string" || !isOpenSinSubject(envelope.subject)) {
    throw new Error(`OpenSIN event envelope subject \"${String(envelope.subject)}\" is invalid.`);
  }
  if (!envelope.time || typeof envelope.time !== "string") {
    throw new Error("OpenSIN event envelope requires an ISO timestamp string.");
  }
  if (!envelope.source || typeof envelope.source !== "object") {
    throw new Error("OpenSIN event envelope requires source metadata.");
  }
  if (!envelope.source.id || typeof envelope.source.id !== "string") {
    throw new Error("OpenSIN event envelope source.id must be a string.");
  }
  if (!envelope.source.runtime || typeof envelope.source.runtime !== "string") {
    throw new Error("OpenSIN event envelope source.runtime must be a string.");
  }
  if (envelope.durability !== "durable" && envelope.durability !== "ephemeral") {
    throw new Error("OpenSIN event envelope durability must be either durable or ephemeral.");
  }
  if (!envelope.headers || typeof envelope.headers !== "object" || Array.isArray(envelope.headers)) {
    throw new Error("OpenSIN event envelope headers must be a string dictionary.");
  }

  parseSubject(envelope.subject);
  validateOuroborosHints(envelope.ouroboros);
}

/**
 * Keep Ouroboros hints narrow so bridge-side effects stay deterministic.
 */
export function validateOuroborosHints(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!value || typeof value !== "object") {
    throw new Error("OpenSIN ouroboros hints must be an object when present.");
  }

  const hints = value as OuroborosHints;

  if (hints.rememberLesson) {
    if (!hints.rememberLesson.agentId || !hints.rememberLesson.context || !hints.rememberLesson.lesson) {
      throw new Error("OpenSIN rememberLesson hints require agentId, context, and lesson.");
    }
  }

  if (hints.registerCapability) {
    if (
      !hints.registerCapability.capability ||
      !hints.registerCapability.path ||
      !hints.registerCapability.synthesizedBy
    ) {
      throw new Error(
        "OpenSIN registerCapability hints require capability, path, and synthesizedBy.",
      );
    }
  }
}
