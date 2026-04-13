/**
 * ==============================================================================
 * OpenSIN Neural Bus - Subject Taxonomy
 * ==============================================================================
 *
 * DESCRIPTION:
 * This file defines the canonical subject taxonomy for OpenSIN event traffic.
 *
 * WHY:
 * Issue #8 requires a stable JetStream surface with subjects that are easy to
 * reason about, validate, document, and replay. If every agent invents its own
 * subject naming, durable consumers cannot be shared safely and operators end up
 * repeating routing instructions manually.
 *
 * CONSEQUENCES:
 * - The `opensin.` prefix is mandatory for all published traffic.
 * - Subject segments must stay lowercase and transport-safe.
 * - Helper functions centralize naming so OpenCode and agent runtimes stay in sync.
 * ==============================================================================
 */

/**
 * The entire fleet uses one visible prefix so streams can safely wildcard-match
 * `opensin.>` without accidentally capturing unrelated NATS subjects.
 */
export const SUBJECT_PREFIX = "opensin";

/**
 * The taxonomy is intentionally small. We optimize for operator clarity, durable
 * replay, and low cognitive load rather than trying to model every theoretical
 * event class up front.
 */
export type SubjectNamespace =
  | "agent"
  | "capability"
  | "debug"
  | "fleet"
  | "memory"
  | "ops"
  | "workflow";

/**
 * JetStream subjects must remain transport-safe. Lowercase segments with digits
 * and hyphens are easy to read and avoid wildcard collisions.
 */
const SUBJECT_SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Parsed subject metadata makes logs and validation errors easier to interpret.
 */
export interface ParsedSubject {
  full: string;
  namespace: SubjectNamespace;
  segments: string[];
}

/**
 * Build a canonical subject from namespace + transport-safe segments.
 */
export function buildSubject(namespace: SubjectNamespace, ...segments: string[]): string {
  const sanitizedSegments = segments.map((segment) => sanitizeSubjectSegment(segment));
  return [SUBJECT_PREFIX, namespace, ...sanitizedSegments].join(".");
}

/**
 * Validate and normalize one subject segment.
 */
export function sanitizeSubjectSegment(segment: string): string {
  const normalized = segment.trim().toLowerCase().replace(/[\s_/]+/g, "-");
  if (!normalized) {
    throw new Error("OpenSIN subject segments cannot be empty.");
  }
  if (!SUBJECT_SEGMENT_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid OpenSIN subject segment \"${segment}\". Use lowercase letters, digits, and hyphens only.`,
    );
  }
  return normalized;
}

/**
 * Parse and validate a subject string.
 */
export function parseSubject(subject: string): ParsedSubject {
  const trimmed = subject.trim();
  if (!trimmed) {
    throw new Error("OpenSIN subjects cannot be empty.");
  }

  const parts = trimmed.split(".");
  if (parts.length < 3) {
    throw new Error(
      `OpenSIN subject \"${subject}\" must include at least prefix, namespace, and one concrete segment.`,
    );
  }

  if (parts[0] !== SUBJECT_PREFIX) {
    throw new Error(
      `OpenSIN subjects must start with \"${SUBJECT_PREFIX}.\". Received \"${subject}\".`,
    );
  }

  const namespace = parts[1] as SubjectNamespace;
  const knownNamespaces: SubjectNamespace[] = [
    "agent",
    "capability",
    "debug",
    "fleet",
    "memory",
    "ops",
    "workflow",
  ];
  if (!knownNamespaces.includes(namespace)) {
    throw new Error(
      `OpenSIN subject \"${subject}\" uses unsupported namespace \"${parts[1]}\".`,
    );
  }

  const segments = parts.slice(2).map((segment) => sanitizeSubjectSegment(segment));
  return {
    full: [SUBJECT_PREFIX, namespace, ...segments].join("."),
    namespace,
    segments,
  };
}

/**
 * Boolean helper for places that prefer soft validation over throwing.
 */
export function isOpenSinSubject(subject: string): boolean {
  try {
    parseSubject(subject);
    return true;
  } catch {
    return false;
  }
}

/**
 * Canonical subject helpers for the highest-value event classes required by
 * Issue #8. Keeping them in one object prevents copy/paste drift.
 */
export const SUBJECTS = {
  operatorContext: buildSubject("ops", "operator", "context"),
  operatorDirective: buildSubject("ops", "operator", "directive"),
  workflowRequest: buildSubject("workflow", "task", "request"),
  workflowReply: buildSubject("workflow", "task", "reply"),
  memoryLessonLearned: buildSubject("memory", "lesson", "learned"),
  memoryContextRequested: buildSubject("memory", "context", "requested"),
  capabilityRegistered: buildSubject("capability", "registry", "registered"),
  debugTrace: buildSubject("debug", "trace", "event"),
  agentObservation: (agentId: string) => buildSubject("agent", agentId, "observation"),
  agentTaskState: (agentId: string) => buildSubject("agent", agentId, "task", "state"),
  agentTaskCompleted: (agentId: string) => buildSubject("agent", agentId, "task", "completed"),
  agentTaskFailed: (agentId: string) => buildSubject("agent", agentId, "task", "failed"),
  agentCapabilityAnnouncement: (agentId: string) =>
    buildSubject("agent", agentId, "capability", "registered"),
  fleetHeartbeat: (agentId: string) => buildSubject("fleet", "heartbeat", agentId),
};

/**
 * Default stream layout. Auto-provisioning these streams means the OpenCode-side
 * wrapper can come up on a clean NATS server without manual pre-seeding.
 */
export const DEFAULT_TAXONOMY_STREAMS: ReadonlyArray<{ name: string; subjects: string[] }> = [
  { name: "OPENSIN_AGENT_EVENTS", subjects: [`${SUBJECT_PREFIX}.agent.>`] },
  { name: "OPENSIN_MEMORY_EVENTS", subjects: [`${SUBJECT_PREFIX}.memory.>`] },
  { name: "OPENSIN_CAPABILITY_EVENTS", subjects: [`${SUBJECT_PREFIX}.capability.>`] },
  { name: "OPENSIN_OPERATOR_EVENTS", subjects: [`${SUBJECT_PREFIX}.ops.>`] },
  { name: "OPENSIN_WORKFLOW_EVENTS", subjects: [`${SUBJECT_PREFIX}.workflow.>`] },
  { name: "OPENSIN_FLEET_EVENTS", subjects: [`${SUBJECT_PREFIX}.fleet.>`] },
  { name: "OPENSIN_DEBUG_EVENTS", subjects: [`${SUBJECT_PREFIX}.debug.>`] },
];
