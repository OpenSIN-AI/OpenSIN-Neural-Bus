/**
 * ==============================================================================
 * OpenSIN Neural Bus - Recent Event Store
 * ==============================================================================
 *
 * DESCRIPTION:
 * In-memory rolling cache of recently published or observed event envelopes.
 *
 * WHY:
 * MCP tools are request/response based. Operators still need a fast way to ask
 * "what just happened?" without manually replaying all context. A bounded local
 * cache gives that answer even though the live bus itself is streaming.
 *
 * CONSEQUENCES:
 * `query_recent_events` returns only events seen by the current MCP server
 * process. That is deliberate for this first-class integration and avoids making
 * unsafe assumptions about JetStream retention in every deployment.
 * ==============================================================================
 */

import { NeuralEventEnvelope, QueryRecentEventsOptions } from './types';

/**
 * Small rolling store with a global cap. A global cap is simpler than per-topic
 * trimming and is sufficient for the lightweight operator workflows targeted by
 * this repo.
 */
export class RecentEventStore {
  private readonly events: NeuralEventEnvelope[] = [];

  constructor(private readonly maxEvents: number = 200) {}

  /**
   * Remember a new event and immediately evict the oldest entry if the cache is
   * already at capacity.
   */
  remember(event: NeuralEventEnvelope): void {
    this.events.push(event);

    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  /**
   * Query is intentionally read-only and returns newest-first ordering because
   * that matches how operators typically inspect recent state.
   */
  query(options: QueryRecentEventsOptions = {}): NeuralEventEnvelope[] {
    const limit = options.limit ?? 10;
    const filtered = options.topic
      ? this.events.filter((event) => event.topic === options.topic)
      : [...this.events];

    return filtered.slice(-limit).reverse();
  }

  /**
   * Tests sometimes need a clean slate between scenarios.
   */
  clear(): void {
    this.events.length = 0;
  }
}
