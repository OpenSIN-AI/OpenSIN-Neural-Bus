/**
 * ==============================================================================
 * OpenSIN Neural Bus - Reusable Agent Runtime Patterns
 * ==============================================================================
 *
 * DESCRIPTION:
 * This class packages the highest-value publish/consume patterns that every
 * OpenSIN agent needs: observations, task states, completions, failures,
 * capability announcements, lesson capture, and durable work intake.
 *
 * WHY:
 * Issue #8 is not just about a transport wrapper. It is about making the bus the
 * default operational path so agents resume with durable state instead of forcing
 * operators to retype the same context after every restart.
 *
 * CONSEQUENCES:
 * - Agents share one consistent event contract.
 * - Durable work consumers resume from the same durable name after restart.
 * - Capability and lesson events can automatically feed Ouroboros via the bridge.
 * ==============================================================================
 */

import {
  createJetStreamEventEnvelope,
  EventEnvelope,
  LessonLearnedRecord,
} from "./event-envelope";
import { OpenCodeJetStreamClient, CloseableSubscription } from "./jetstream-client";
import { OuroborosBridge } from "./ouroboros-bridge";
import { SUBJECTS } from "./subject-taxonomy";

export interface AgentRuntimeOptions {
  agentId: string;
  sessionId?: string;
  bus: OpenCodeJetStreamClient;
  bridge?: OuroborosBridge;
}

export interface TaskStatePayload {
  taskId: string;
  state: "accepted" | "completed" | "failed" | "in-progress" | "queued";
  detail?: Record<string, unknown>;
}

export interface DurableWorkConsumerOptions {
  subject: string;
  stream: string;
  durableName: string;
  deliverPolicy?: "all" | "last" | "new";
  ackWaitMs?: number;
  maxDeliver?: number;
}

/**
 * `OpenSinAgentRuntime` is intentionally thin. It orchestrates the stable bus
 * patterns, but leaves business-specific payloads to the calling agent.
 */
export class OpenSinAgentRuntime {
  private readonly source;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.source = {
      id: options.agentId,
      runtime: "agent-runtime" as const,
      sessionId: options.sessionId,
    };
  }

  async publishObservation(payload: Record<string, unknown>): Promise<EventEnvelope<Record<string, unknown>>> {
    const envelope = createJetStreamEventEnvelope({
      kind: "agent.observation",
      subject: SUBJECTS.agentObservation(this.options.agentId),
      source: this.source,
      payload,
      durability: "durable",
    });
    await this.options.bus.publishEnvelope(envelope);
    return envelope;
  }

  async publishTaskState(payload: TaskStatePayload): Promise<EventEnvelope<TaskStatePayload>> {
    const envelope = createJetStreamEventEnvelope({
      kind: "agent.task.state",
      subject: SUBJECTS.agentTaskState(this.options.agentId),
      source: this.source,
      payload,
      durability: "durable",
    });
    await this.options.bus.publishEnvelope(envelope);
    return envelope;
  }

  async publishTaskCompleted(payload: Record<string, unknown>): Promise<EventEnvelope<Record<string, unknown>>> {
    const envelope = createJetStreamEventEnvelope({
      kind: "agent.task.completed",
      subject: SUBJECTS.agentTaskCompleted(this.options.agentId),
      source: this.source,
      payload,
      durability: "durable",
    });
    await this.options.bus.publishEnvelope(envelope);
    return envelope;
  }

  async publishTaskFailed(payload: Record<string, unknown>): Promise<EventEnvelope<Record<string, unknown>>> {
    const envelope = createJetStreamEventEnvelope({
      kind: "agent.task.failed",
      subject: SUBJECTS.agentTaskFailed(this.options.agentId),
      source: this.source,
      payload,
      durability: "durable",
    });
    await this.options.bus.publishEnvelope(envelope);
    return envelope;
  }

  async publishCapabilityRegistration(payload: {
    capability: string;
    path: string;
  }): Promise<EventEnvelope<{ capability: string; path: string; synthesizedBy: string }>> {
    const enrichedPayload = {
      capability: payload.capability,
      path: payload.path,
      synthesizedBy: this.options.agentId,
    };

    const envelope = createJetStreamEventEnvelope({
      kind: "capability.registered",
      subject: SUBJECTS.agentCapabilityAnnouncement(this.options.agentId),
      source: this.source,
      payload: enrichedPayload,
      durability: "durable",
      ouroboros: {
        registerCapability: enrichedPayload,
      },
    });
    await this.options.bus.publishEnvelope(envelope);
    return envelope;
  }

  async publishLessonLearned(record: Omit<LessonLearnedRecord, "agentId">): Promise<EventEnvelope<LessonLearnedRecord>> {
    const payload: LessonLearnedRecord = {
      agentId: this.options.agentId,
      context: record.context,
      lesson: record.lesson,
      successRate: record.successRate,
    };

    const envelope = createJetStreamEventEnvelope({
      kind: "memory.lesson.learned",
      subject: SUBJECTS.memoryLessonLearned,
      source: this.source,
      payload,
      durability: "durable",
      ouroboros: {
        rememberLesson: payload,
      },
    });
    await this.options.bus.publishEnvelope(envelope);
    return envelope;
  }

  /**
   * Consume assigned work from a durable subject so the same durable name can be
   * reused after process restarts.
   */
  async consumeAssignedWork(
    consumer: DurableWorkConsumerOptions,
    handler: (envelope: EventEnvelope) => Promise<void> | void,
  ): Promise<CloseableSubscription> {
    return this.options.bus.subscribeDurable(
      {
        ...consumer,
        bridge: this.options.bridge,
        autoAck: true,
      },
      async (envelope) => {
        await handler(envelope);
      },
    );
  }
}
