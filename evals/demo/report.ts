// Formatting for evals/demo-system-one.ts. Console output carries STT and
// numbers only; question text goes to the git-ignored evals/runs/ report.

export interface RunOutcome {
  status: string;
  reasonCode: string;
  selectorCalls: number;
  agentCalls: number;
  ms: number;
}
export interface DemoRow {
  stt: number;
  group: string;
  question: string;
  /** The group expects System One to let the turn through. */
  mustPass: boolean;
  off: RunOutcome;
  on: RunOutcome;
  systemOne: string;
  gateActed: boolean;
}

const gemini = (run: RunOutcome) => run.selectorCalls + run.agentCalls;
const cell = (run: RunOutcome) =>
  `${run.status}/${run.reasonCode} · ${gemini(run)} (${run.selectorCalls}+${run.agentCalls}) · ${Math.round(run.ms)} ms`;
const wronglyStopped = (row: DemoRow) => row.mustPass && row.gateActed;

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function table(rows: DemoRow[], withQuestion: boolean): string {
  const head = [
    'STT',
    'nhóm',
    ...(withQuestion ? ['câu hỏi'] : []),
    'OFF status/reason · Gemini (chọn tool+agent) · ms',
    'ON status/reason · Gemini (chọn tool+agent) · ms',
    'System One',
  ];
  const lines = rows.map((row) =>
    [
      `${row.stt}${wronglyStopped(row) ? ' ⚠' : ''}`,
      row.group,
      ...(withQuestion ? [row.question.replace(/\|/gu, '\\|')] : []),
      cell(row.off),
      cell(row.on),
      row.systemOne,
    ].join(' | '),
  );
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...lines.map((line) => `| ${line} |`),
  ].join('\n');
}

function summary(rows: DemoRow[]): string {
  const sum = (pick: (row: DemoRow) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);
  const ms = (pick: (row: DemoRow) => RunOutcome) =>
    rows.map((row) => pick(row).ms);
  const offMs = ms((row) => row.off);
  const onMs = ms((row) => row.on);
  const changed = rows.filter((row) => row.off.status !== row.on.status);
  const warned = rows.filter(wronglyStopped);
  return [
    `- Câu: ${rows.length}; cổng hành động: ${rows.filter((row) => row.gateActed).length}`,
    `- Gemini OFF: ${sum((row) => gemini(row.off))} (chọn tool ${sum((row) => row.off.selectorCalls)}, agent ${sum((row) => row.off.agentCalls)})`,
    `- Gemini ON:  ${sum((row) => gemini(row.on))} (chọn tool ${sum((row) => row.on.selectorCalls)}, agent ${sum((row) => row.on.agentCalls)})`,
    `- Độ trễ OFF p50/p95: ${Math.round(percentile(offMs, 50))} / ${Math.round(percentile(offMs, 95))} ms`,
    `- Độ trễ ON  p50/p95: ${Math.round(percentile(onMs, 50))} / ${Math.round(percentile(onMs, 95))} ms`,
    `- Đổi status: ${changed.length} (STT ${changed.map((row) => row.stt).join(', ') || '—'})`,
    `- ⚠ câu phải đi tiếp bị cổng chặn: ${warned.length} (STT ${warned.map((row) => row.stt).join(', ') || '—'})`,
  ].join('\n');
}

export function consoleReport(rows: DemoRow[]): string {
  return `${table(rows, false)}\n\n${summary(rows)}`;
}

export function markdownReport(rows: DemoRow[], header: string): string {
  return `# Demo System One\n\n${header}\n\n${table(rows, true)}\n\n## Tổng kết\n\n${summary(rows)}\n`;
}
