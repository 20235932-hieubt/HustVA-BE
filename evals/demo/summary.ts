// Merge several demo runs (evals/demo-full.ts) into one summary. Pure: rows
// in, numbers and markdown out. Numbers and STT only, never question text.
import { percentile, type RunOutcome } from './report.js';
import type { StoredRow } from './rows.js';

/** Turns lost to Gemini (provider error or the 30 s turn timeout). A pair
 *  with either side lost is left out of the OFF/ON comparison. */
export const GEMINI_FAILURES: readonly string[] = [
  'GEMINI_UNAVAILABLE',
  'CHAT_TIMEOUT',
];

export interface RunRows {
  run: number;
  rows: StoredRow[];
}
interface Pair {
  run: number;
  row: StoredRow;
}
interface Calls {
  selector: number;
  agent: number;
}
interface Latency {
  p50: number;
  p95: number;
}
interface OffOn<T> {
  off: T;
  on: T;
}

export interface Summary {
  runs: { run: number; pairs: number; comparable: number }[];
  pairs: number;
  comparable: number;
  /** Lost turns by reasonCode; `pairs` counts pairs with either side lost. */
  lost: OffOn<Record<string, number>> & { pairs: number };
  /** Comparable pairs only. */
  gemini: OffOn<Calls>;
  /** Every pair, lost turns included (their calls still hit the quota). */
  geminiAll: OffOn<Calls>;
  latency: OffOn<Latency>;
  statusChanged: Pair[];
  answered: OffOn<number>;
  answeredAll: OffOn<number>;
  /** Pre-routing decisions happen before Gemini: every pair counts. */
  gateActed: number;
  toolSkipped: number;
  wronglyStopped: Pair[];
  wronglySkipped: Pair[];
  claimsChecked: number;
  claimsDropped: number;
  claimsDroppedPairs: Pair[];
  claimsUnsupported: Pair[];
}

export const geminiFailed = (run: RunOutcome): boolean =>
  GEMINI_FAILURES.includes(run.reasonCode);
const isComparable = ({ row }: Pair) =>
  !geminiFailed(row.off) && !geminiFailed(row.on);
const callsOf = (runs: RunOutcome[]): Calls => ({
  selector: runs.reduce((total, run) => total + run.selectorCalls, 0),
  agent: runs.reduce((total, run) => total + run.agentCalls, 0),
});
const latencyOf = (runs: RunOutcome[]): Latency => {
  const ms = runs.map((run) => run.ms);
  return { p50: percentile(ms, 50), p95: percentile(ms, 95) };
};
const answeredIn = (runs: RunOutcome[]) =>
  runs.filter((run) => run.status === 'answered').length;
const countBy = (values: string[]) =>
  values.reduce<Record<string, number>>(
    (counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }),
    {},
  );

const pairsOf = (runs: RunRows[]): Pair[] =>
  runs.flatMap(({ run, rows }) => rows.map((row) => ({ run, row })));

export function summarize(runs: RunRows[]): Summary {
  const all = pairsOf(runs);
  const comparable = all.filter(isComparable);
  const side = (pairs: Pair[], pick: 'off' | 'on') =>
    pairs.map(({ row }) => row[pick]);
  const lostOn = (pick: 'off' | 'on') =>
    countBy(
      side(all, pick)
        .filter(geminiFailed)
        .map((run) => run.reasonCode),
    );
  return {
    runs: runs.map(({ run, rows }) => ({
      run,
      pairs: rows.length,
      comparable: rows.filter((row) => isComparable({ run, row })).length,
    })),
    pairs: all.length,
    comparable: comparable.length,
    lost: {
      off: lostOn('off'),
      on: lostOn('on'),
      pairs: all.length - comparable.length,
    },
    gemini: {
      off: callsOf(side(comparable, 'off')),
      on: callsOf(side(comparable, 'on')),
    },
    geminiAll: { off: callsOf(side(all, 'off')), on: callsOf(side(all, 'on')) },
    latency: {
      off: latencyOf(side(comparable, 'off')),
      on: latencyOf(side(comparable, 'on')),
    },
    statusChanged: comparable.filter(
      ({ row }) => row.off.status !== row.on.status,
    ),
    answered: {
      off: answeredIn(side(comparable, 'off')),
      on: answeredIn(side(comparable, 'on')),
    },
    answeredAll: {
      off: answeredIn(side(all, 'off')),
      on: answeredIn(side(all, 'on')),
    },
    gateActed: all.filter(({ row }) => row.gateActed).length,
    toolSkipped: all.filter(({ row }) => row.toolSkipped).length,
    wronglyStopped: all.filter(({ row }) => row.mustPass && row.gateActed),
    wronglySkipped: all.filter(
      ({ row }) => row.mustKeepSelector && row.toolSkipped,
    ),
    claimsChecked: all.reduce((total, { row }) => total + row.claimsChecked, 0),
    claimsDropped: all.reduce((total, { row }) => total + row.claimsDropped, 0),
    claimsDroppedPairs: all.filter(({ row }) => row.claimsDropped > 0),
    claimsUnsupported: all.filter(
      ({ row }) => row.on.reasonCode === 'CLAIMS_UNSUPPORTED',
    ),
  };
}

export interface SttLine {
  stt: number;
  group: string;
  pairs: number;
  comparable: number;
  off: Record<string, number>;
  on: Record<string, number>;
  /** Mean Gemini calls per comparable pair; null when none. */
  geminiOff: number | null;
  geminiOn: number | null;
  msOff: number | null;
  msOn: number | null;
  gateActed: number;
  toolSkipped: number;
  claimsChecked: number;
  claimsDropped: number;
  warned: boolean;
}

/** One line per STT, in the order STTs first appear across runs. */
export function perStt(runs: RunRows[]): SttLine[] {
  const all = pairsOf(runs);
  const stts = [...new Set(all.map(({ row }) => row.stt))];
  return stts.map((stt) => {
    const pairs = all.filter(({ row }) => row.stt === stt);
    const comparable = pairs.filter(isComparable);
    const mean = (pick: 'off' | 'on') =>
      comparable.length
        ? comparable.reduce(
            (total, { row }) =>
              total + row[pick].selectorCalls + row[pick].agentCalls,
            0,
          ) / comparable.length
        : null;
    const median = (pick: 'off' | 'on') =>
      comparable.length
        ? percentile(
            comparable.map(({ row }) => row[pick].ms),
            50,
          )
        : null;
    const statuses = (pick: 'off' | 'on') =>
      countBy(
        pairs.map(({ row }) => `${row[pick].status}/${row[pick].reasonCode}`),
      );
    const count = (pick: (row: StoredRow) => boolean | number) =>
      pairs.reduce((total, { row }) => total + Number(pick(row)), 0);
    const first = pairs[0].row;
    return {
      stt,
      group: first.group,
      pairs: pairs.length,
      comparable: comparable.length,
      off: statuses('off'),
      on: statuses('on'),
      geminiOff: mean('off'),
      geminiOn: mean('on'),
      msOff: median('off'),
      msOn: median('on'),
      gateActed: count((row) => row.gateActed),
      toolSkipped: count((row) => row.toolSkipped),
      claimsChecked: count((row) => row.claimsChecked),
      claimsDropped: count((row) => row.claimsDropped),
      warned: pairs.some(
        ({ row }) =>
          (row.mustPass && row.gateActed) ||
          (row.mustKeepSelector && row.toolSkipped),
      ),
    };
  });
}

const pairList = (pairs: Pair[]) =>
  `${pairs.length}${pairs.length ? ` (STT/lượt: ${pairs.map(({ run, row }) => `${row.stt}/${run}`).join(', ')})` : ''}`;
const counts = (record: Record<string, number>) =>
  Object.entries(record)
    .map(([key, value]) => `${key} ×${value}`)
    .join(', ') || '0';
const calls = (value: Calls) =>
  `${value.selector + value.agent} (chọn tool ${value.selector}, agent ${value.agent})`;
const ms = (value: number | null) =>
  value === null ? '—' : String(Math.round(value));
const mean = (value: number | null) =>
  value === null ? '—' : value.toFixed(1);
const statusCell = (record: Record<string, number>) =>
  Object.entries(record)
    .map(([key, value]) => (value > 1 ? `${key} ×${value}` : key))
    .join(', ');

function overview(summary: Summary): string {
  const { gemini, geminiAll, latency, answered, answeredAll } = summary;
  return [
    `- Lượt: ${summary.runs.map((run) => `${run.run} (${run.comparable}/${run.pairs} cặp so sánh được)`).join(', ') || '—'}`,
    `- Cặp OFF/ON: ${summary.pairs}; so sánh được: ${summary.comparable}; **mất vì Gemini: ${summary.lost.pairs}**`,
    `- Lượt hỏng do Gemini — OFF: ${counts(summary.lost.off)}; ON: ${counts(summary.lost.on)}`,
    '',
    '**So sánh OFF/ON (chỉ cặp so sánh được)**',
    '',
    `- Gemini OFF: ${calls(gemini.off)}`,
    `- Gemini ON:  ${calls(gemini.on)}`,
    `- Lần gọi bộ chọn tool tiết kiệm: ${gemini.off.selector - gemini.on.selector}`,
    `- Độ trễ OFF p50/p95: ${ms(latency.off.p50)} / ${ms(latency.off.p95)} ms`,
    `- Độ trễ ON  p50/p95: ${ms(latency.on.p50)} / ${ms(latency.on.p95)} ms`,
    `- Đổi status: ${pairList(summary.statusChanged)}`,
    `- answered OFF/ON: ${answered.off} / ${answered.on}`,
    '',
    '**Mọi cặp (kể cả lượt hỏng)**',
    '',
    `- Gemini OFF: ${calls(geminiAll.off)}; ON: ${calls(geminiAll.on)}`,
    `- answered OFF/ON: ${answeredAll.off} / ${answeredAll.on}`,
    `- Cổng (a) hành động: ${summary.gateActed}; bỏ qua bộ chọn tool (f): ${summary.toolSkipped}`,
    `- ⚠ câu phải đi tiếp bị cổng chặn: ${pairList(summary.wronglyStopped)}`,
    `- ⚠ câu cần tool bị bỏ qua bộ chọn: ${pairList(summary.wronglySkipped)}`,
    `- Kiểm claim (b): đã kiểm ${summary.claimsChecked}, lược ${summary.claimsDropped}; cặp có claim bị lược: ${pairList(summary.claimsDroppedPairs)}`,
    `- Hết claim → CLAIMS_UNSUPPORTED: ${pairList(summary.claimsUnsupported)}`,
  ].join('\n');
}

function sttTable(lines: SttLine[]): string {
  const head = [
    'STT',
    'nhóm',
    'so sánh được/lượt',
    'OFF status/reason',
    'ON status/reason',
    'Gemini TB OFF → ON*',
    'ms trung vị OFF / ON*',
    'a hành động',
    'f bỏ qua',
    'claim kiểm/lược',
  ];
  const body = lines.map((line) =>
    [
      `${line.stt}${line.warned ? ' ⚠' : ''}`,
      line.group,
      `${line.comparable}/${line.pairs}`,
      statusCell(line.off),
      statusCell(line.on),
      `${mean(line.geminiOff)} → ${mean(line.geminiOn)}`,
      `${ms(line.msOff)} / ${ms(line.msOn)}`,
      `${line.gateActed}/${line.pairs}`,
      `${line.toolSkipped}/${line.pairs}`,
      `${line.claimsChecked}/${line.claimsDropped}`,
    ].join(' | '),
  );
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...body.map((line) => `| ${line} |`),
    '',
    '\\* chỉ tính cặp so sánh được (OFF và ON đều không hỏng do Gemini).',
  ].join('\n');
}

export function summaryMarkdown(runs: RunRows[], header: string): string {
  return [
    '# Demo System One — tổng hợp nhiều lượt',
    '',
    header,
    '',
    `Lượt hỏng do Gemini: reasonCode ${GEMINI_FAILURES.join(', ')} ở OFF hoặc ON.`,
    '',
    '## Tổng kết',
    '',
    overview(summarize(runs)),
    '',
    '## Theo STT',
    '',
    sttTable(perStt(runs)),
    '',
  ].join('\n');
}
