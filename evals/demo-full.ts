// Full System One demo (sites a, f, b): checks, N runs, one summary.
//   pnpm demo:full [--runs=2] [--gap-ms=20000] [--resume=<dir>] [--dry-run]
// Each invocation gets evals/runs/full-<timestamp>/ (git-ignored):
//   precheck.txt   env checks + HTTP status of one "ping" to Gemini and Clef
//   params.json    runs and gap of this directory
//   run-<n>.jsonl  one row per STT, written as it finishes (no question text)
//   run-<n>.md     report of run n with questions (written when run n ends)
//   run-<n>.log    child output, DEMO_LOG_LEVEL=info (whitelisted logger)
//   summary.md     all runs merged, Gemini-failed turns set aside
// Interrupted? Rerun with --resume=<dir>: finished runs are skipped and an
// unfinished run continues after its last finished STT.
// --dry-run: env checks and the plan only, no network call, writes nothing.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildCases, SUPPORTED_SITES } from './demo/cases.js';
import {
  checkLine,
  networkChecks,
  staticChecks,
  type Check,
} from './demo/precheck.js';
import { parseRows } from './demo/rows.js';
import { summaryMarkdown, type RunRows } from './demo/summary.js';

const DEFAULT_RUNS = 2;
const DEFAULT_GAP_MS = 20_000;
/** Rough chat time per turn on top of the gap (demo p50 2–5 s). */
const TURN_ESTIMATE_MS = 5_000;
const CHILD = 'evals/demo-system-one.ts';
const SITES = SUPPORTED_SITES.join(',');

function arg(name: string): string | undefined {
  return process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
function positiveInt(name: string, raw: string, min: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min)
    fail(`--${name} phải là số nguyên ≥ ${min}`);
  return value;
}
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

const params = z.object({
  runs: z.number().int().min(1),
  gapMs: z.number().int().min(0),
});
const resume = arg('resume');
const dryRun = process.argv.includes('--dry-run');
const dir =
  resume ??
  path.join(
    'evals/runs',
    `full-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
  );
if (resume && !(await exists(resume)))
  fail(`Không có thư mục ${resume} để chạy tiếp.`);
const paramsFile = path.join(dir, 'params.json');
const saved = resume
  ? params.safeParse(
      JSON.parse(await readFile(paramsFile, 'utf8').catch(() => 'null')),
    ).data
  : undefined;
const rawRuns = arg('runs');
const rawGap = arg('gap-ms');
const runs = rawRuns
  ? positiveInt('runs', rawRuns, 1)
  : (saved?.runs ?? DEFAULT_RUNS);
const gapMs = rawGap
  ? positiveInt('gap-ms', rawGap, 0)
  : (saved?.gapMs ?? DEFAULT_GAP_MS);
const cases = buildCases([...SUPPORTED_SITES]);
const runNumbers = Array.from({ length: runs }, (_, index) => index + 1);
const file = (run: number, ext: string) => path.join(dir, `run-${run}.${ext}`);

interface RunState {
  run: number;
  finished: boolean;
  rows: number;
}
async function runState(run: number): Promise<RunState> {
  const text = await readFile(file(run, 'jsonl'), 'utf8').catch(() => '');
  return {
    run,
    finished: await exists(file(run, 'md')),
    rows: parseRows(text).length,
  };
}
const describe = (state: RunState) =>
  state.finished
    ? 'đã xong, bỏ qua'
    : state.rows
      ? `chạy tiếp (đã có ${state.rows}/${cases.length} câu)`
      : 'chạy mới';

function estimateMinutes(pendingPairs: number): string {
  const perTurn = gapMs + TURN_ESTIMATE_MS;
  const typical = Math.round((pendingPairs * 2 * perTurn) / 60_000);
  const worst = Math.round((pendingPairs * 2 * (gapMs + 30_000)) / 60_000);
  return `~${typical} phút (tối đa ~${worst} phút nếu lượt nào cũng chờ 30 s)`;
}
const childArgs = (run: number) => [
  '--import',
  'tsx',
  CHILD,
  `--sites=${SITES}`,
  `--gap-ms=${gapMs}`,
  `--out-dir=${dir}`,
  `--run=${run}`,
];
const resumeCommand = `pnpm demo:full --resume=${dir}`;

async function summarize() {
  const merged: RunRows[] = [];
  for (const run of runNumbers) {
    const text = await readFile(file(run, 'jsonl'), 'utf8').catch(() => '');
    const rows = parseRows(text);
    if (rows.length) merged.push({ run, rows });
  }
  const states = await Promise.all(runNumbers.map(runState));
  const unfinished = states.filter((state) => !state.finished);
  const header = [
    `Thư mục: ${dir} · vị trí: ${SITES} · ${runs} lượt × ${cases.length} câu · gap ${gapMs} ms · ${new Date().toISOString()}`,
    unfinished.length
      ? `Lượt chưa xong: ${unfinished.map((state) => `${state.run} (${state.rows}/${cases.length} câu)`).join(', ')}`
      : 'Mọi lượt đã xong.',
  ].join('\n\n');
  const markdown = summaryMarkdown(merged, header);
  await writeFile(path.join(dir, 'summary.md'), markdown);
  const overview = markdown.split('\n## Theo STT')[0];
  console.log(`\n${overview}\nĐã lưu ${path.join(dir, 'summary.md')}`);
}

function runChild(run: number): Promise<number | null> {
  const log = createWriteStream(file(run, 'log'), { flags: 'a' });
  const child = spawn(process.execPath, childArgs(run), {
    env: { ...process.env, DEMO_LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Logger JSON goes to stdout (log file only); progress and errors on
  // stderr also reach the terminal.
  child.stdout.pipe(log, { end: false });
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    log.write(chunk);
  });
  return new Promise((resolve) => {
    child.on('close', (code) => log.end(() => resolve(code)));
  });
}

// Ctrl+C reaches the child too; wait for it, then print how to resume.
let interrupted = false;
let childRunning = false;
process.on('SIGINT', () => {
  interrupted = true;
  if (childRunning) return;
  console.error(`\nĐã dừng. Chạy tiếp: ${resumeCommand}`);
  process.exit(130);
});

const states = await Promise.all(runNumbers.map(runState));
const pending = states.filter((state) => !state.finished);
const pendingPairs = pending.reduce(
  (total, state) => total + cases.length - state.rows,
  0,
);

if (dryRun) {
  console.log(`[dry-run] không gọi API, không ghi file.`);
  console.log(`Thư mục: ${dir}${resume ? ' (chạy tiếp)' : ' (tạo mới)'}`);
  console.log(`Lượt: ${runs} · gap ${gapMs} ms · vị trí ${SITES}`);
  console.log('\nKiểm trước (chỉ env; mạng bỏ qua ở dry-run):');
  for (const check of staticChecks(process.env))
    console.log(`  ${checkLine(check)}`);
  console.log(
    `  · bỏ qua: embedding /info, 1 ping Gemini, 1 ping Clef (in mã HTTP)`,
  );
  console.log(`\n${cases.length} câu mỗi lượt (OFF rồi ON):`);
  for (const item of cases) console.log(`  STT ${item.stt} · ${item.group}`);
  console.log('\nLượt:');
  for (const state of states)
    console.log(`  lượt ${state.run}: ${describe(state)}`);
  console.log(
    `\nCòn ${pendingPairs} cặp OFF/ON = ${pendingPairs * 2} lượt chat · ${estimateMinutes(pendingPairs)}`,
  );
  console.log(`Lệnh con: node ${childArgs(1).join(' ')} (thay --run)`);
  process.exit(0);
}

await mkdir(dir, { recursive: true });
if (!pending.length) {
  console.log(`Mọi lượt trong ${dir} đã xong: chỉ tổng hợp lại.`);
  await summarize();
  process.exit(0);
}

const checks: Check[] = staticChecks(process.env);
if (checks.every((check) => check.ok || !check.fatal))
  checks.push(...(await networkChecks(process.env)));
const lines = checks.map(checkLine);
console.log(`Kiểm trước:\n${lines.map((line) => `  ${line}`).join('\n')}`);
await appendFile(
  path.join(dir, 'precheck.txt'),
  `${new Date().toISOString()}\n${lines.join('\n')}\n\n`,
);
if (checks.some((check) => !check.ok && check.fatal))
  fail(
    `\nDừng: sửa mục ✖ ở trên rồi chạy lại (${resume ? resumeCommand : 'pnpm demo:full'}).`,
  );
if (!saved)
  await writeFile(paramsFile, `${JSON.stringify({ runs, gapMs }, null, 2)}\n`);

console.log(
  `\nThư mục: ${dir}\n${pending.length} lượt cần chạy, ${pendingPairs} cặp OFF/ON · ${estimateMinutes(pendingPairs)}`,
);
for (const state of pending) {
  console.log(`\n=== Lượt ${state.run}/${runs}: ${describe(state)} ===`);
  childRunning = true;
  const code = await runChild(state.run);
  childRunning = false;
  if (interrupted || code !== 0) {
    console.error(
      `\nLượt ${state.run} dừng (${interrupted ? 'Ctrl+C' : `mã thoát ${code}`}); xem ${file(state.run, 'log')}.`,
    );
    console.error(`Chạy tiếp: ${resumeCommand}`);
    process.exit(interrupted ? 130 : 1);
  }
}
await summarize();
console.log(`\nGửi lại cho Claude: "Bước 9b, kết quả ở ${dir}/"`);
