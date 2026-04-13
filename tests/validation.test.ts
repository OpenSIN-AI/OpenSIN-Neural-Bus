/**
 * ==============================================================================
 * OpenSIN Neural Bus - Validation Tests
 * ==============================================================================
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventEnvelope, validateEventEnvelope } from '../src/validation';

test('createEventEnvelope normalizes a valid publish input', () => {
  const envelope = createEventEnvelope({
    topic: 'fleet.goal',
    source: 'SIN-Test-Agent',
    payload: { objective: 'sync-capability-context', success: true },
    metadata: { environment: 'test' },
  });

  assert.equal(envelope.topic, 'fleet.goal');
  assert.equal(envelope.source, 'SIN-Test-Agent');
  assert.equal(envelope.metadata?.environment, 'test');
  assert.ok(envelope.eventId.length > 0);
  assert.ok(!Number.isNaN(Date.parse(envelope.timestamp)));
});

test('validateEventEnvelope rejects malformed envelopes', () => {
  assert.throws(
    () =>
      validateEventEnvelope({
        eventId: 'evt-1',
        topic: '',
        source: 'SIN-Test-Agent',
        timestamp: 'not-a-date',
        payload: undefined,
      }),
    /topic must not be empty|timestamp must be an ISO timestamp|payload must be JSON serializable/,
  );
});
