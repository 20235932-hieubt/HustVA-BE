// Run chat turns with System One OFF, then ON, and compare.
//   pnpm tsx evals/demo-system-one.ts [--sites=a] [--stt=114,2] [--gap-ms=8000]
// Uses the real ChatService with an in-memory store (no HTTP, no Mongo).
// Needs GEMINI_API_KEY, embedding service 8001 + local vectors and the
// SYSTEM_ONE_* provider settings in .env (SYSTEM_ONE_MODE is ignored).
// --gap-ms pauses before every turn (Gemini free-tier quota is per minute).
// Console: STT and numbers only. Full report: evals/runs/demo-*.md.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { readSystemOneConfig } from '../src/system-one/config.js';
import { memorySink } from '../src/system-one/sink.js';
import { createSystemOneTurn } from '../src/system-one/turn.js';
import { getToolManager } from '../src/tools/runtime.js';
import {
  createRoutingModel,
  createToolSelector,
} from '../src/tools/selector.js';
import { MemoryConversationStore } from './demo/memory-store.js';
import {
  consoleReport,
  markdownReport,
  type DemoRow,
  type RunOutcome,
} from './demo/report.js';
import { questionsByStt } from './probe/csv.js';

// Production logs would interleave with the table; DEMO_LOG_LEVEL overrides.
process.env.LOG_LEVEL = process.env.DEMO_LOG_LEVEL ?? 'silent';

const CSV = 'evals/cau-hoi-kiem-thu.csv';
const SUPPORTED_SITES = ['a'];
// demo-plan mục 4. Only site a exists so far (step 3).
const GROUPS = [
  {
    site: 'a',
    name: 'a-chặn',
    mustPass: false,
    stts: [114, 116, 118, 119, 99, 105, 137, 1, 96, 125, 126],
  },
  { site: 'a', name: 'a-đi tiếp', mustPass: true, stts: [2, 127, 135] },
];

function arg(name: string): string | undefined {
  return process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

const sites = (arg('sites') ?? 'a').split(',').filter(Boolean);
const unsupported = sites.filter((site) => !SUPPORTED_SITES.includes(site));
if (unsupported.length) {
  console.error(`Vị trí chưa làm: ${unsupported.join(', ')}`);
  process.exit(1);
}
const onlyStt = arg('stt')?.split(',').map(Number);
const gapMs = Number(arg('gap-ms') ?? 0);
const cases = GROUPS.filter((group) => sites.includes(group.site)).flatMap(
  (group) =>
    group.stts
      .filter((stt) => !onlyStt || onlyStt.includes(stt))
      .map((stt) => ({ stt, group: group.name, mustPass: group.mustPass })),
);

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
const agent = createChatAgent(
  counted(createGeminiModel(config), 'agent'),
  knowledge,
  config,
);
const selector = createToolSelector(
  counted(createRoutingModel(config), 'selector'),
);
const tools = getToolManager();
const service = (systemOne?: ReturnType<typeof createSystemOneTurn>) =>
  new ChatService(
    new MemoryConversationStore(),
    agent,
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
    SYSTEM_ONE_TOOL_SKIP: 'false',
    SYSTEM_ONE_CLARIFY: 'false',
    SYSTEM_ONE_CLAIM_CHECK: 'false',
    SYSTEM_ONE_UNIT_HINT: 'false',
    SYSTEM_ONE_RELEVANCE: 'false',
  },
  { warn: (event, fields) => console.error(event, JSON.stringify(fields)) },
);
const sink = memorySink();
const onTurn = createSystemOneTurn(systemOneConfig, { sink });
if (!onTurn) {
  console.error('Cấu hình SYSTEM_ONE_* không hợp lệ (xem log ở trên).');
  process.exit(1);
}
const offService = service();
const onService = service(onTurn);

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
const rows: DemoRow[] = [];
for (const item of cases) {
  const question = byStt.get(item.stt);
  if (!question) throw new Error(`Không có STT ${item.stt} trong CSV`);
  const off = await runOnce(offService, question);
  const before = sink.records.length;
  const on = await runOnce(onService, question);
  const record = sink.records.slice(before).at(-1);
  rows.push({
    ...item,
    question,
    off,
    on,
    systemOne: record
      ? `a:${record.label ?? '—'} ${record.probability?.toFixed(2) ?? '—'} ${record.action}${record.latencyMs === undefined ? '' : ` ${Math.round(record.latencyMs)} ms`}`
      : '— (checkInput đã xử lý)',
    gateActed: record?.action === 'acted',
  });
  console.error(`STT ${item.stt} xong`);
}

const header = `provider=${systemOneConfig.provider} model=${systemOneConfig.model ?? 'laya'} · vị trí: ${sites.join(',')} · ${new Date().toISOString()}`;
console.log(`${header}\n\n${consoleReport(rows)}`);
await mkdir('evals/runs', { recursive: true });
const file = `evals/runs/demo-${new Date().toISOString().replace(/[:.]/gu, '-')}.md`;
await writeFile(file, markdownReport(rows, header));
console.log(`\nĐã lưu ${file}`);
