/**
 * ==============================================================================
 * OpenSIN Neural Bus - Validation Helpers
 * ==============================================================================
 *
 * DESCRIPTION:
 * Runtime validation for event envelopes and MCP input fragments.
 *
 * WHY:
 * TypeScript types disappear at runtime, but MCP inputs and NATS payloads are
 * untrusted strings/JSON. These guards stop malformed payloads before they can
 * poison the operator session or the recent-event cache.
 *
 * CONSEQUENCES:
 * All tool handlers can rely on normalized, strongly typed values after the
 * helpers return successfully.
 * ==============================================================================
 */

import { randomUUID } from 'node:crypto';

import {
  JsonValue,
  NeuralEventEnvelope,
  PublishNeuralEventInput,
} from './types';

/**
 * Small reusable runtime assertion helper so all thrown validation errors share
 * the same readable shape.
 */
function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * We need plain objects for metadata and arbitrary JSON structures. Arrays and
 * null are explicitly excluded because they behave differently when merged.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON payload validation is recursive because payloads can nest objects/arrays
 * many levels deep.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (isPlainObject(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry));
  }

  return false;
}

/**
 * Topic/source fields must always be present and meaningful. Empty strings are
 * operationally useless because subscribers cannot route them correctly.
 */
export function validateNonEmptyString(value: unknown, fieldName: string): string {
  invariant(typeof value === 'string', `${fieldName} must be a string.`);

  const trimmed = value.trim();
  invariant(trimmed.length > 0, `${fieldName} must not be empty.`);

  return trimmed;
}

/**
 * ISO timestamps are stored as strings so they survive JSON round-trips, but we
 * still validate that they parse as real dates.
 */
export function validateIsoTimestamp(value: unknown, fieldName: string): string {
  const timestamp = validateNonEmptyString(value, fieldName);
  invariant(!Number.isNaN(Date.parse(timestamp)), `${fieldName} must be an ISO timestamp.`);
  return timestamp;
}

/**
 * Metadata is intentionally constrained to string:string because operators often
 * use it for headers, tags, and tracing IDs.
 */
export function validateStringRecord(
  value: unknown,
  fieldName: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  invariant(isPlainObject(value), `${fieldName} must be an object with string values.`);

  const normalized: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    normalized[validateNonEmptyString(key, `${fieldName} key`)] = validateNonEmptyString(
      entry,
      `${fieldName}.${key}`,
    );
  }

  return normalized;
}

/**
 * Numeric MCP inputs are usually optional. This helper enforces positive integer
 * semantics only when a value is actually provided.
 */
export function validateOptionalPositiveInteger(
  value: unknown,
  fieldName: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  invariant(typeof value === 'number' && Number.isInteger(value), `${fieldName} must be an integer.`);
  invariant(value > 0, `${fieldName} must be greater than zero.`);
  return value;
}

/**
 * Normalizes publish input into the canonical envelope used everywhere else.
 */
export function createEventEnvelope<TPayload extends JsonValue>(
  input: PublishNeuralEventInput<TPayload>,
): NeuralEventEnvelope<TPayload> {
  invariant(isJsonValue(input.payload), 'payload must be JSON serializable.');

  return {
    eventId: input.eventId ? validateNonEmptyString(input.eventId, 'eventId') : randomUUID(),
    topic: validateNonEmptyString(input.topic, 'topic'),
    source: validateNonEmptyString(input.source, 'source'),
    timestamp: input.timestamp
      ? validateIsoTimestamp(input.timestamp, 'timestamp')
      : new Date().toISOString(),
    payload: input.payload,
    correlationId: input.correlationId
      ? validateNonEmptyString(input.correlationId, 'correlationId')
      : undefined,
    causationId: input.causationId
      ? validateNonEmptyString(input.causationId, 'causationId')
      : undefined,
    metadata: validateStringRecord(input.metadata, 'metadata'),
  };
}

/**
 * Converts unknown decoded JSON back into the trusted event envelope contract.
 */
export function validateEventEnvelope(value: unknown): NeuralEventEnvelope {
  invariant(isPlainObject(value), 'event envelope must be an object.');
  invariant(isJsonValue(value.payload), 'event envelope payload must be JSON serializable.');

  return {
    eventId: validateNonEmptyString(value.eventId, 'eventId'),
    topic: validateNonEmptyString(value.topic, 'topic'),
    source: validateNonEmptyString(value.source, 'source'),
    timestamp: validateIsoTimestamp(value.timestamp, 'timestamp'),
    payload: value.payload,
    correlationId:
      value.correlationId === undefined
        ? undefined
        : validateNonEmptyString(value.correlationId, 'correlationId'),
    causationId:
      value.causationId === undefined
        ? undefined
        : validateNonEmptyString(value.causationId, 'causationId'),
    metadata: validateStringRecord(value.metadata, 'metadata'),
  };
}
