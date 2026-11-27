import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { LogFields } from '../../src/observability/logger.js';
import {
  jsonlSink,
  memorySink,
  noopSink,
  type DecisionRecord,
} from '../../src/system-one/sink.js';

const RECORD: DecisionRecord = {
  site: 'input_gate',
  mode: 'shadow',
  action: 'shadow',
  label: 'academic',
  probability: 0.91,
  state: { message: 'Em [[PII_STUDENT_ID_ab12]] hỏi học bổng' },
  answers: { tan_cong: { type: 'noul', probability: 0.03 } },
  latencyMs: 18,
};
const AT = new Date(2026, 10, 20, 9, 30);

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'system-one-sink-'));
}

describe('DecisionSink', () => {
  test('noopSink accepts records and does nothing', () => {
    assert.doesNotThrow(() => noopSink.write(RECORD));
  });

  test('memorySink keeps records in order with a timestamp', () => {
    const sink = memorySink(() => AT);

    sink.write(RECORD);
    sink.write({ ...RECORD, site: 'tool_skip' });

    assert.deepEqual(
      sink.records.map((r) => r.site),
      ['input_gate', 'tool_skip'],
    );
    assert.equal(sink.records[0].at, AT.toISOString());
  });

  test('jsonlSink appends one line per record to shadow-YYYYMMDD.jsonl', async () => {
    const dir = join(await tempDir(), 'runs');
    try {
      const sink = jsonlSink({ dir, now: () => AT });

      sink.write(RECORD);
      sink.write({ ...RECORD, action: 'low_confidence' });
      await sink.flush();

      const lines = (await readFile(join(dir, 'shadow-20261120.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(lines.length, 2);
      assert.deepEqual(lines[0], { ...RECORD, at: AT.toISOString() });
      assert.equal(lines[1].action, 'low_confidence');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('jsonlSink swallows write failures and logs only a code', async () => {
    const parent = await tempDir();
    // A file where the directory should be makes mkdir/append fail.
    const blocked = join(parent, 'not-a-dir');
    await writeFile(blocked, 'x');
    const logs: { event: string; fields?: LogFields }[] = [];
    try {
      const sink = jsonlSink({
        dir: blocked,
        now: () => AT,
        log: { warn: (event, fields) => logs.push({ event, fields }) },
      });

      assert.doesNotThrow(() => sink.write(RECORD));
      await sink.flush();

      assert.deepEqual(logs, [
        {
          event: 'system_one.sink.failed',
          fields: { errorCode: 'SYSTEM_ONE_SINK_WRITE' },
        },
      ]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
