// Run chat turns with System One OFF, then ON, and compare.
//   pnpm tsx evals/demo-system-one.ts [--sites=a,f,b] [--stt=114,2]
//     [--gap-ms=8000] [--out-dir=<dir> --run=<n>] [--dry-run]
// Uses the real ChatService with an in-memory store (no HTTP, no Mongo).
// Needs GEMINI_API_KEY, embedding service 8001 + local vectors and the
// SYSTEM_ONE_* provider settings in .env (SYSTEM_ONE_MODE is ignored).
// --gap-ms pauses before every turn (Gemini free-tier quota is per minute).
// --out-dir: rows go to <dir>/run-<n>.jsonl as each STT finishes (rerunning
// the same command skips STTs already there) and the report to
// <dir>/run-<n>.md once all are done. Without it: evals/runs/demo-*.md.
// --dry-run lists the cases (and STTs already done) without calling any API.
// Console: STT and numbers only. Reports with questions stay in evals/runs/.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { readChatConfig } from '../src/agent/config.js';
import { createChatAgent } from '../src/agent/graph.js';
import { createGeminiModel, type AgentModel } from '../src/agent/model.js';
import { ChatError } from '../src/chat/contracts.js';
import { ChatService } from '../src/chat/service.js';
import { CrawlStore } from '../src/crawler/store.js';
import { EmbeddingService } from '../src/embedding/index.js';
import { RagKnowledge } from '../src/knowledge/rag.js';
import { createClaimChecker } from '../src/system-one/claim-check.js';
import { readSystemOneConfig } from '../src/system-one/config.js';
import { memorySink } from '../src/system-one/sink.js';
import { createSystemOneTurn } from '../src/system-one/turn.js';
import { getToolManager } from '../src/tools/runtime.js';
import {
  createRoutingModel,
  createToolSelector,
} from '../src/tools/selector.js';
import { buildCases, SUPPORTED_SITES } from './demo/cases.js';
import { MemoryConversationStore } from './demo/memory-store.js';
import {
  consoleReport,
  markdownReport,
  type DemoRow,
  type RunOutcome,
} from './demo/report.js';
import { parseRows, rowLine, type StoredRow } from './demo/rows.js';
import { questionsByStt } from './probe/csv.js';

// Production logs would interleave with the table; DEMO_LOG_LEVEL overrides.
process.env.LOG_LEVEL = process.env.DEMO_LOG_LEVEL ?? 'silent';

const CSV = 'evals/cau-hoi-kiem-thu.csv';
const SITE_TAG: Record<string, string> = {
  input_gate: 'a',
  tool_skip: 'f',
  claim_check: 'b',
};

function arg(name: string): string | undefined {
  return process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

const sites = (arg('sites') ?? SUPPORTED_SITES.join(','))
  .split(',')
  .filter(Boolean);
const unsupported = sites.filter(
  (site) => !(SUPPORTED_SITES as readonly string[]).includes(site),
);
if (unsupported.length) {
  console.error(`Vị trí chưa làm: ${unsupported.join(', ')}`);
  process.exit(1);
}
const onlyStt = arg('stt')?.split(',').map(Number);
const gapMs = Number(arg('gap-ms') ?? 0);
const dryRun = process.argv.includes('--dry-run');
const outDir = arg('out-dir');
const runNo = Number(arg('run') ?? 1);
if (!Number.isInteger(gapMs) || gapMs < 0) {
  console.error('--gap-ms phải là số nguyên ≥ 0');
  process.exit(1);
}
if (!Number.isInteger(runNo) || runNo < 1) {
  console.error('--run phải là số nguyên ≥ 1');
  process.exit(1);
}
const cases = buildCases(sites, onlyStt);
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const rowsFile = outDir && path.join(outDir, `run-${runNo}.jsonl`);
const reportFile = outDir
  ? path.join(outDir, `run-${runNo}.md`)
  : `evals/runs/demo-${stamp}.md`;
// Resume: rows already on disk are kept; the file is rewritten without any
// truncated line before new rows are appended.
const doneRows: StoredRow[] = rowsFile
  ? parseRows(await readFile(rowsFile, 'utf8').catch(() => ''))
  : [];
const done = new Set(doneRows.map((row) => row.stt));
const pending = cases.filter((item) => !done.has(item.stt));

if (dryRun) {
  console.log(
    `[dry-run] vị trí ${sites.join(',')} · lượt ${runNo} · gap ${gapMs} ms`,
  );
  for (const item of cases)
    console.log(
      `  STT ${item.stt} · ${item.group}${done.has(item.stt) ? ' · đã có, bỏ qua' : ''}`,
    );
  console.log(
    `  ${cases.length} câu, còn chạy ${pending.length} → ${reportFile}`,
  );
  process.exit(0);
}

const config = readChatConfig();
const calls = { selector: 0, agent: 0 };
const counted = (model: AgentModel, key: keyof typeof calls): AgentModel => ({
  invoke: (messages, signal, options) => {
    calls[key] += 1;
    return model.invoke(messages, signal, options);
  },
});
const knowledge = new RagKnowledge(
  new EmbeddingService(new CrawlStore(), undefined, () => undefined).pipeline,
);
const agentModel = counted(createGeminiModel(config), 'agent');
const selector = createToolSelector(
  counted(createRoutingModel(config), 'selector'),
);
const tools = getToolManager();
const service = (
  systemOne?: ReturnType<typeof createSystemOneTurn>,
  claimChecker?: ReturnType<typeof createClaimChecker>,
) =>
  new ChatService(
    new MemoryConversationStore(),
    createChatAgent(agentModel, knowledge, config, claimChecker),
    config.timeoutMs,
    tools,
    selector,
    undefined,
    undefined,
    undefined,
    false,
    systemOne,
  );

const systemOneConfig = readSystemOneConfig(
  {
    ...process.env,
    SYSTEM_ONE_MODE: 'on',
    SYSTEM_ONE_INPUT_GATE: String(sites.includes('a')),
    SYSTEM_ONE_TOOL_SKIP: String(sites.includes('f')),
    SYSTEM_ONE_CLARIFY: 'false',
    SYSTEM_ONE_CLAIM_CHECK: String(sites.includes('b')),
    SYSTEM_ONE_UNIT_HINT: 'false',
    SYSTEM_ONE_RELEVANCE: 'false',
  },
  { warn: (event, fields) => console.error(event, JSON.stringify(fields)) },
);
// An invalid SYSTEM_ONE_* config reads as mode off (fail-open).
if (systemOneConfig.mode === 'off') {
  console.error('Cấu hình SYSTEM_ONE_* không hợp lệ (xem log ở trên).');
  process.exit(1);
}
const sink = memorySink();
const offService = service();
const onService = service(
  createSystemOneTurn(systemOneConfig, { sink }),
  createClaimChecker(systemOneConfig, { sink }),
);

async function runOnce(chat: ChatService, message: string) {
  if (gapMs > 0) await sleep(gapMs);
  calls.selector = 0;
  calls.agent = 0;
  const { conversationId, token } = await chat.create();
  const started = performance.now();
  let status = 'error';
  let reasonCode = 'ERROR';
  try {
    const result = await chat.message(conversationId, token, {
      requestId: randomUUID(),
      message,
    });
    status = result.status;
    reasonCode = result.reasonCode;
  } catch (error) {
    if (error instanceof ChatError) reasonCode = error.code;
  }
  const outcome: RunOutcome = {
    status,
    reasonCode,
    selectorCalls: calls.selector,
    agentCalls: calls.agent,
    ms: performance.now() - started,
  };
  return outcome;
}

const byStt = questionsByStt(await readFile(CSV, 'utf8'));
const questionOf = (stt: number) => {
  const question = byStt.get(stt);
  if (!question) throw new Error(`Không có STT ${stt} trong CSV`);
  return question;
};
if (rowsFile) {
  await mkdir(path.dirname(rowsFile), { recursive: true });
  await writeFile(rowsFile, doneRows.map(rowLine).join(''));
}
const newRows: StoredRow[] = [];
for (const [index, item] of pending.entries()) {
  const question = questionOf(item.stt);
  const off = await runOnce(offService, question);
  const before = sink.records.length;
  const on = await runOnce(onService, question);
  const records = sink.records.slice(before);
  const acted = (site: string) =>
    records.some((r) => r.site === site && r.action === 'acted');
  const preRoute = records.filter((r) => r.site !== 'claim_check');
  const claims = records.filter((r) => r.site === 'claim_check');
  const latency = preRoute.find((r) => r.latencyMs !== undefined)?.latencyMs;
  const row: StoredRow = {
    ...item,
    off,
    on,
    systemOne: records.length
      ? [
          ...preRoute.map(
            (r) =>
              `${SITE_TAG[r.site] ?? r.site}:${r.label ?? '—'} ${r.probability?.toFixed(2) ?? '—'} ${r.action}`,
          ),
          ...(latency === undefined ? [] : [`${Math.round(latency)} ms`]),
          ...(claims.length
            ? [
                `b:${claims
                  .map(
                    (r) =>
                      `${r.label === 'ho_tro' ? (r.probability?.toFixed(2) ?? '—') : r.label} ${r.action}`,
                  )
                  .join(', ')}`,
              ]
            : []),
        ].join(' · ')
      : sites.some((site) => site === 'a' || site === 'f')
        ? '— (checkInput đã xử lý)'
        : '— (agent chưa ra draft)',
    gateActed: acted('input_gate'),
    toolSkipped: acted('tool_skip'),
    claimsChecked: claims.length,
    claimsDropped: claims.filter((r) => r.action === 'acted').length,
  };
  newRows.push(row);
  if (rowsFile) await appendFile(rowsFile, rowLine(row));
  console.error(`STT ${item.stt} xong (${index + 1}/${pending.length})`);
}

// Case order, whatever order the rows were written in across resumes.
const stored = [...doneRows, ...newRows];
const rows: DemoRow[] = cases.flatMap((item) => {
  const row = stored.find((candidate) => candidate.stt === item.stt);
  return row ? [{ ...row, question: questionOf(item.stt) }] : [];
});
const resumed = doneRows.length
  ? ` · tiếp tục: ${doneRows.length} câu có từ trước`
  : '';
const header = `provider=${systemOneConfig.provider} model=${systemOneConfig.model ?? 'laya'} · vị trí: ${sites.join(',')} · lượt ${runNo} · gap ${gapMs} ms · ${new Date().toISOString()}${resumed}`;
console.log(`${header}\n\n${consoleReport(rows)}`);
await mkdir(path.dirname(reportFile), { recursive: true });
await writeFile(reportFile, markdownReport(rows, header));
console.log(`\nĐã lưu ${reportFile}`);
