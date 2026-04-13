/**
 * ==============================================================================
 * OpenSIN Neural Bus - Ouroboros Bridge Helpers
 * ==============================================================================
 *
 * DESCRIPTION:
 * These helpers translate bus envelopes into durable Ouroboros updates and expose
 * a concrete bridge class that OpenCode/MCP callers can instantiate directly.
 *
 * WHY:
 * The repo needs two things at once:
 * 1. a tiny structural contract for envelope-driven memory mirroring, and
 * 2. a real bridge implementation backed by the Python Ouroboros CLI.
 *
 * CONSEQUENCES:
 * - Event handlers can depend on the narrow contract.
 * - Tests and MCP surfaces can instantiate `OuroborosBridge` directly.
 * ==============================================================================
 */

import {
  CapabilityRegistration,
  EventEnvelope,
  LessonLearnedRecord,
  OuroborosHints,
} from './event-envelope';
import { OuroborosPythonBridge } from './ouroboros-python-bridge';

/**
 * Structural bridge contract used by envelope mirroring.
 */
export interface OuroborosMutationBridge {
  rememberLesson(record: LessonLearnedRecord): Promise<unknown> | unknown;
  registerCapability(record: CapabilityRegistration): Promise<unknown> | unknown;
}

/**
 * Concrete bridge used by the MCP server and tests.
 *
 * The Python bridge already knows how to talk to the SQLite-backed Ouroboros CLI,
 * but its method names use the Python-oriented `agent` field. This wrapper keeps
 * the event-envelope side ergonomic by accepting `synthesizedBy` directly.
 */
export class OuroborosBridge
  extends OuroborosPythonBridge
  implements OuroborosMutationBridge
{
  async rememberLesson(record: LessonLearnedRecord) {
    return super.rememberLesson({
      agentId: record.agentId,
      context: record.context,
      lesson: record.lesson,
      successRate: record.successRate,
    });
  }

  async registerCapability(
    record: CapabilityRegistration | { capability: string; path: string; agent: string },
  ) {
    const agent = 'synthesizedBy' in record ? record.synthesizedBy : record.agent;
    return super.registerCapability({
      capability: record.capability,
      path: record.path,
      agent,
    });
  }
}

export interface AppliedOuroborosUpdates {
  rememberedLessons: number;
  registeredCapabilities: number;
}

/**
 * Infer memory updates from explicit hints first, then fall back to event kind.
 */
export function extractOuroborosHints(envelope: EventEnvelope): OuroborosHints {
  if (envelope.ouroboros) {
    return envelope.ouroboros;
  }

  if (envelope.kind === 'memory.lesson.learned') {
    const payload = envelope.payload as Partial<LessonLearnedRecord>;
    if (payload.agentId && payload.context && payload.lesson) {
      return {
        rememberLesson: {
          agentId: payload.agentId,
          context: payload.context,
          lesson: payload.lesson,
          successRate: payload.successRate,
        },
      };
    }
  }

  if (envelope.kind === 'capability.registered') {
    const payload = envelope.payload as Partial<CapabilityRegistration>;
    if (payload.capability && payload.path && payload.synthesizedBy) {
      return {
        registerCapability: {
          capability: payload.capability,
          path: payload.path,
          synthesizedBy: payload.synthesizedBy,
        },
      };
    }
  }

  return {};
}

/**
 * Apply bridge updates if a bridge is available. Returning counters instead of
 * booleans makes trace output and tests much clearer.
 */
export async function applyOuroborosBridgeUpdates(
  bridge: OuroborosMutationBridge | undefined,
  envelope: EventEnvelope,
): Promise<AppliedOuroborosUpdates> {
  if (!bridge) {
    return { rememberedLessons: 0, registeredCapabilities: 0 };
  }

  const hints = extractOuroborosHints(envelope);
  let rememberedLessons = 0;
  let registeredCapabilities = 0;

  if (hints.rememberLesson) {
    await bridge.rememberLesson(hints.rememberLesson);
    rememberedLessons += 1;
  }

  if (hints.registerCapability) {
    await bridge.registerCapability(hints.registerCapability);
    registeredCapabilities += 1;
  }

  return { rememberedLessons, registeredCapabilities };
}
