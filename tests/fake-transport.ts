/**
 * ==============================================================================
 * OpenSIN Neural Bus - Test Transport
 * ==============================================================================
 *
 * DESCRIPTION:
 * In-memory transport used by unit tests instead of a live NATS server.
 *
 * WHY:
 * The MCP surface must be testable in CI without external infrastructure.
 * This fake transport gives us publish + subscribe semantics that are good
 * enough to verify the higher-level OpenSIN runtime contracts.
 * ==============================================================================
 */

import { NeuralBusConnectionOptions, NeuralBusTransport } from '../src/types';

/**
 * Tiny async queue so test subscribers can await future publishes.
 */
class AsyncMessageQueue implements AsyncIterable<string> {
  private readonly items: string[] = [];
  private readonly resolvers: Array<(result: IteratorResult<string>) => void> = [];
  private closed = false;

  push(value: string): void {
    if (this.closed) {
      return;
    }

    const resolver = this.resolvers.shift();

    if (resolver) {
      resolver({ value, done: false });
      return;
    }

    this.items.push(value);
  }

  close(): void {
    this.closed = true;

    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as string, done: false });
        }

        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise<IteratorResult<string>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

/**
 * Memory transport that mirrors published strings to every same-topic queue.
 */
export class FakeNeuralBusTransport implements NeuralBusTransport {
  private readonly queues = new Map<string, Set<AsyncMessageQueue>>();
  private connected = false;
  public lastConnectOptions?: NeuralBusConnectionOptions;

  async connect(options: NeuralBusConnectionOptions): Promise<void> {
    this.connected = true;
    this.lastConnectOptions = options;
  }

  async publish(topic: string, encodedEnvelope: string): Promise<void> {
    if (!this.connected) {
      throw new Error('Fake transport is not connected.');
    }

    const topicQueues = this.queues.get(topic);

    if (!topicQueues) {
      return;
    }

    for (const queue of topicQueues) {
      queue.push(encodedEnvelope);
    }
  }

  subscribe(topic: string): AsyncIterable<string> {
    if (!this.connected) {
      throw new Error('Fake transport is not connected.');
    }

    const queue = new AsyncMessageQueue();
    const topicQueues = this.queues.get(topic) ?? new Set<AsyncMessageQueue>();
    topicQueues.add(queue);
    this.queues.set(topic, topicQueues);

    return queue;
  }

  async close(): Promise<void> {
    for (const topicQueues of this.queues.values()) {
      for (const queue of topicQueues) {
        queue.close();
      }
    }

    this.queues.clear();
    this.connected = false;
  }
}
