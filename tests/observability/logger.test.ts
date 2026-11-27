import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createLogger,
  type LogFields,
} from '../../src/observability/logger.js';

function logOnce(fields: LogFields) {
  const lines: string[] = [];
  createLogger({ level: 'info', write: (line) => lines.push(line) }).info(
    'system_one.test',
    fields,
  );
  const { timestamp, level, event, ...rest } = JSON.parse(lines[0]);
  assert.ok(timestamp);
  assert.equal(level, 'info');
  assert.equal(event, 'system_one.test');
  return rest;
}

describe('logger — System One fields', () => {
  test('keeps whitelisted System One fields and rounds numbers', () => {
    assert.deepEqual(
      logOnce({
        systemOneSite: 'input_gate',
        systemOneLabel: 'out_of_scope',
        systemOneAction: 'low_confidence',
        systemOneProbPct: 91.4,
        claimsChecked: 4,
        claimsDropped: 1,
        chunksDropped: 0,
      }),
      {
        systemOneSite: 'input_gate',
        systemOneLabel: 'out_of_scope',
        systemOneAction: 'low_confidence',
        systemOneProbPct: 91,
        claimsChecked: 4,
        claimsDropped: 1,
        chunksDropped: 0,
      },
    );
  });

  test('drops values outside the whitelist', () => {
    assert.deepEqual(
      logOnce({
        systemOneSite: 'somewhere_else',
        systemOneLabel: 'Em hỏi học bổng',
        systemOneAction: 'blocked_everything',
        systemOneProbPct: 140,
        claimsDropped: -1,
      }),
      {},
    );
  });

  test('drops a label that is not a short snake_case id', () => {
    assert.deepEqual(logOnce({ systemOneLabel: 'a'.repeat(41) }), {});
    assert.deepEqual(logOnce({ systemOneLabel: 'Academic' }), {});
  });
});
