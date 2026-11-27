import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildCases } from '../../evals/demo/cases.js';
import type { RunOutcome } from '../../evals/demo/report.js';
import { parseRows, rowLine, type StoredRow } from '../../evals/demo/rows.js';
import {
  geminiFailed,
  perStt,
  summarize,
  summaryMarkdown,
} from '../../evals/demo/summary.js';

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    status: 'answered',
    reasonCode: 'GROUNDED',
    selectorCalls: 1,
    agentCalls: 2,
    ms: 1000,
    ...over,
  };
}
function row(over: Partial<StoredRow> = {}): StoredRow {
  return {
    stt: 14,
    group: 'f-bỏ chọn tool',
    mustPass: true,
    mustKeepSelector: false,
    off: outcome(),
    on: outcome({ selectorCalls: 0 }),
    systemOne: 'a:academic 0.95 passed',
    gateActed: false,
    toolSkipped: true,
    claimsChecked: 0,
    claimsDropped: 0,
    ...over,
  };
}
const UNAVAILABLE = outcome({
  status: 'error',
  reasonCode: 'GEMINI_UNAVAILABLE',
  ms: 400,
});
const TIMEOUT = outcome({
  status: 'error',
  reasonCode: 'CHAT_TIMEOUT',
  ms: 30_000,
});

describe('buildCases', () => {
  test('29 STT across a, f, b; shared STTs run once with joined groups', () => {
    // 34 entries in demo-plan mục 4 (c, d struck out); f and b share 5.
    const cases = buildCases(['a', 'f', 'b']);
    assert.equal(cases.length, 29);
    assert.equal(new Set(cases.map((item) => item.stt)).size, 29);
    const shared = cases.find((item) => item.stt === 22);
    assert.equal(shared?.group, 'f-bỏ chọn tool+b-có số liệu');
    assert.equal(shared?.mustPass, true);
    const tool = cases.find((item) => item.stt === 34);
    assert.equal(tool?.mustKeepSelector, true);
    const blocked = cases.find((item) => item.stt === 114);
    assert.equal(blocked?.mustPass, false);
  });

  test('filters by site and by --stt', () => {
    assert.deepEqual(
      buildCases(['b']).map((item) => item.stt),
      [14, 16, 20, 22, 23, 75],
    );
    assert.deepEqual(
      buildCases(['a', 'f', 'b'], [2, 20]).map((item) => item.stt),
      [2, 20],
    );
  });
});

describe('demo rows JSONL', () => {
  test('round-trips rows and skips blank, malformed and truncated lines', () => {
    const first = row();
    const second = row({ stt: 16 });
    const text = `${rowLine(first)}\nnot json\n${JSON.stringify({ stt: 1 })}\n${rowLine(second)}${rowLine(row({ stt: 20 })).slice(0, 40)}`;
    assert.deepEqual(parseRows(text), [first, second]);
    assert.deepEqual(parseRows(''), []);
  });

  test('a stored row carries no question text', () => {
    const withQuestion = { ...row(), question: 'câu hỏi bí mật' };
    assert.doesNotMatch(rowLine(withQuestion), /câu hỏi bí mật/u);
  });
});

describe('summarize', () => {
  test('GEMINI_UNAVAILABLE and CHAT_TIMEOUT count as Gemini failures', () => {
    assert.equal(geminiFailed(UNAVAILABLE), true);
    assert.equal(geminiFailed(TIMEOUT), true);
    assert.equal(geminiFailed(outcome({ reasonCode: 'MODEL_BUDGET' })), false);
    assert.equal(
      geminiFailed(outcome({ reasonCode: 'HUST_SELECTION_INVALID' })),
      false,
    );
  });

  test('pairs with a Gemini failure on either side leave the comparison', () => {
    const summary = summarize([
      {
        run: 1,
        rows: [
          row(),
          row({ stt: 16, off: UNAVAILABLE }),
          row({ stt: 20, on: TIMEOUT }),
        ],
      },
      { run: 2, rows: [row({ on: outcome({ selectorCalls: 0, ms: 3000 }) })] },
    ]);
    assert.equal(summary.pairs, 4);
    assert.equal(summary.comparable, 2);
    assert.equal(summary.lost.pairs, 2);
    assert.deepEqual(summary.lost.off, { GEMINI_UNAVAILABLE: 1 });
    assert.deepEqual(summary.lost.on, { CHAT_TIMEOUT: 1 });
    assert.deepEqual(summary.runs, [
      { run: 1, pairs: 3, comparable: 1 },
      { run: 2, pairs: 1, comparable: 1 },
    ]);
    // Comparable only: 2 pairs × (1 + 2) OFF, 2 × (0 + 2) ON.
    assert.deepEqual(summary.gemini.off, { selector: 2, agent: 4 });
    assert.deepEqual(summary.gemini.on, { selector: 0, agent: 4 });
    // Every pair: lost turns still spent calls.
    assert.deepEqual(summary.geminiAll.off, { selector: 4, agent: 8 });
    assert.deepEqual(summary.latency.off, { p50: 1000, p95: 1000 });
    assert.deepEqual(summary.latency.on, { p50: 1000, p95: 3000 });
    assert.deepEqual(summary.answered, { off: 2, on: 2 });
    assert.deepEqual(summary.answeredAll, { off: 3, on: 3 });
  });

  test('a status change caused by a Gemini failure is not a change', () => {
    const summary = summarize([
      {
        run: 1,
        rows: [
          row({ stt: 22, off: UNAVAILABLE }),
          row({
            stt: 75,
            on: outcome({
              status: 'insufficient_evidence',
              reasonCode: 'CLAIMS_UNSUPPORTED',
            }),
            claimsChecked: 2,
            claimsDropped: 2,
          }),
        ],
      },
    ]);
    assert.deepEqual(
      summary.statusChanged.map(({ row: item }) => item.stt),
      [75],
    );
    assert.deepEqual(
      summary.claimsUnsupported.map(({ row: item }) => item.stt),
      [75],
    );
    assert.equal(summary.claimsChecked, 2);
    assert.equal(summary.claimsDropped, 2);
  });

  test('gate and tool-skip warnings count every pair, lost ones included', () => {
    const summary = summarize([
      {
        run: 1,
        rows: [
          row({ stt: 2, gateActed: true, toolSkipped: false, on: TIMEOUT }),
          row({
            stt: 34,
            mustKeepSelector: true,
            toolSkipped: true,
            off: UNAVAILABLE,
          }),
          row({ stt: 114, mustPass: false, gateActed: true }),
        ],
      },
    ]);
    assert.deepEqual(
      summary.wronglyStopped.map(({ row: item }) => item.stt),
      [2],
    );
    assert.deepEqual(
      summary.wronglySkipped.map(({ row: item }) => item.stt),
      [34],
    );
    assert.equal(summary.gateActed, 2);
    assert.equal(summary.toolSkipped, 2);
  });

  test('no runs gives zeros, not NaN', () => {
    const summary = summarize([]);
    assert.equal(summary.pairs, 0);
    assert.deepEqual(summary.latency.off, { p50: 0, p95: 0 });
  });
});

describe('perStt', () => {
  test('merges runs per STT; means use comparable pairs only', () => {
    const lines = perStt([
      { run: 1, rows: [row(), row({ stt: 16, off: UNAVAILABLE })] },
      {
        run: 2,
        rows: [
          row({ on: outcome({ selectorCalls: 0, agentCalls: 4, ms: 5000 }) }),
          row({ stt: 16, on: UNAVAILABLE }),
        ],
      },
    ]);
    assert.deepEqual(
      lines.map((line) => line.stt),
      [14, 16],
    );
    const [fourteen, sixteen] = lines;
    assert.equal(fourteen.pairs, 2);
    assert.equal(fourteen.comparable, 2);
    assert.equal(fourteen.geminiOff, 3);
    assert.equal(fourteen.geminiOn, 3);
    assert.equal(fourteen.msOn, 1000);
    assert.equal(fourteen.toolSkipped, 2);
    assert.deepEqual(fourteen.on, { 'answered/GROUNDED': 2 });
    assert.equal(sixteen.comparable, 0);
    assert.equal(sixteen.geminiOff, null);
    assert.equal(sixteen.msOff, null);
    assert.deepEqual(sixteen.off, {
      'error/GEMINI_UNAVAILABLE': 1,
      'answered/GROUNDED': 1,
    });
  });

  test('flags an STT when any run stopped or skipped it wrongly', () => {
    const [line] = perStt([
      { run: 1, rows: [row({ stt: 2 })] },
      { run: 2, rows: [row({ stt: 2, gateActed: true })] },
    ]);
    assert.equal(line.warned, true);
    assert.equal(line.gateActed, 1);
  });
});

describe('summaryMarkdown', () => {
  test('reports lost turns apart and lists STT/run pairs', () => {
    const text = summaryMarkdown(
      [
        {
          run: 1,
          rows: [
            row({ stt: 2, gateActed: true }),
            row({ stt: 16, off: UNAVAILABLE }),
          ],
        },
      ],
      'header',
    );
    assert.match(text, /\*\*mất vì Gemini: 1\*\*/u);
    assert.match(text, /OFF: GEMINI_UNAVAILABLE ×1; ON: 0/u);
    assert.match(
      text,
      /⚠ câu phải đi tiếp bị cổng chặn: 1 \(STT\/lượt: 2\/1\)/u,
    );
    assert.match(text, /\| 2 ⚠ \|/u);
    assert.match(text, /\| 16 \| f-bỏ chọn tool \| 0\/1 \|/u);
  });
});
