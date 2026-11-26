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
  /** The group expects the input gate (a) to let the turn through. */
  mustPass: boolean;
  /** A tool question: tool skip (f) must leave the selector in place. */
  mustKeepSelector: boolean;
  off: RunOutcome;
  on: RunOutcome;
  systemOne: string;
  gateActed: boolean;
  toolSkipped: boolean;
  /** Site b: claims sent through the check, and claims it dropped. */
  claimsChecked: number;
  claimsDropped: number;
}

const gemini = (run: RunOutcome) => run.selectorCalls + run.agentCalls;
const cell = (run: RunOutcome) =>
  `${run.status}/${run.reasonCode} · ${gemini(run)} (${run.selectorCalls}+${run.agentCalls}) · ${Math.round(run.ms)} ms`;
const wronglyStopped = (row: DemoRow) => row.mustPass && row.gateActed;
const wronglySkipped = (row: DemoRow) =>
  row.mustKeepSelector && row.toolSkipped;
const warned = (row: DemoRow) => wronglyStopped(row) || wronglySkipped(row);
const list = (rows: DemoRow[]) =>
  `${rows.length} (STT ${rows.map((row) => row.stt).join(', ') || '—'})`;

export function percentile(values: number[], p: number): number {
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
      `${row.stt}${warned(row) ? ' ⚠' : ''}`,
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
  const selectorOff = sum((row) => row.off.selectorCalls);
  const selectorOn = sum((row) => row.on.selectorCalls);
  const answered = (pick: (row: DemoRow) => RunOutcome) =>
    rows.filter((row) => pick(row).status === 'answered').length;
  return [
    `- Câu: ${rows.length}; cổng (a) hành động: ${rows.filter((row) => row.gateActed).length}; bỏ qua bộ chọn tool (f): ${list(rows.filter((row) => row.toolSkipped))}`,
    `- Gemini OFF: ${sum((row) => gemini(row.off))} (chọn tool ${selectorOff}, agent ${sum((row) => row.off.agentCalls)})`,
    `- Gemini ON:  ${sum((row) => gemini(row.on))} (chọn tool ${selectorOn}, agent ${sum((row) => row.on.agentCalls)})`,
    `- Lần gọi bộ chọn tool tiết kiệm: ${selectorOff - selectorOn}`,
    `- Độ trễ OFF p50/p95: ${Math.round(percentile(offMs, 50))} / ${Math.round(percentile(offMs, 95))} ms`,
    `- Độ trễ ON  p50/p95: ${Math.round(percentile(onMs, 50))} / ${Math.round(percentile(onMs, 95))} ms`,
    `- Đổi status: ${list(changed)}`,
    `- ⚠ câu phải đi tiếp bị cổng chặn: ${list(rows.filter(wronglyStopped))}`,
    `- ⚠ câu cần tool bị bỏ qua bộ chọn: ${list(rows.filter(wronglySkipped))}`,
    `- Kiểm claim (b): đã kiểm ${sum((row) => row.claimsChecked)} claim, lược ${sum((row) => row.claimsDropped)}; câu có claim bị lược: ${list(rows.filter((row) => row.claimsDropped > 0))}`,
    `- Hết claim → CLAIMS_UNSUPPORTED: ${list(rows.filter((row) => row.on.reasonCode === 'CLAIMS_UNSUPPORTED'))}`,
    `- answered OFF/ON: ${answered((row) => row.off)} / ${answered((row) => row.on)}`,
  ].join('\n');
}

export function consoleReport(rows: DemoRow[]): string {
  return `${table(rows, false)}\n\n${summary(rows)}`;
}

export function markdownReport(rows: DemoRow[], header: string): string {
  return `# Demo System One\n\n${header}\n\n${table(rows, true)}\n\n## Tổng kết\n\n${summary(rows)}\n`;
}
