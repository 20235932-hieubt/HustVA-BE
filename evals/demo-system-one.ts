// Run chat turns with System One OFF, then ON, and compare.
//   pnpm tsx evals/demo-system-one.ts [--sites=a,f,b] [--stt=114,2]
//     [--gap-ms=8000]
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
import { createClaimChecker } from '../src/system-one/claim-check.js';
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
const SUPPORTED_SITES = ['a', 'f', 'b'];
// demo-plan mục 4. mustPass: the gate must let the turn through;
// mustKeepSelector: a tool question, site f must not skip the selector.
const GROUPS = [
  {
    site: 'a',
    name: 'a-chặn',
    mustPass: false,
    mustKeepSelector: false,
    stts: [114, 116, 118, 119, 99, 105, 137, 1, 96, 125, 126],
  },
  {
    site: 'a',
    name: 'a-đi tiếp',
    mustPass: true,
    mustKeepSelector: false,
    stts: [2, 127, 135],
  },
  {
    site: 'f',
    name: 'f-bỏ chọn tool',
    mustPass: true,
    mustKeepSelector: false,
    // 14, 16, 22 from mục 4 plus the other step-2 probe document questions.
    stts: [14, 16, 22, 23, 37, 41, 75, 92, 17, 29],
  },
  {
    site: 'f',
    name: 'f-giữ chọn tool',
    mustPass: true,
    mustKeepSelector: true,
    stts: [34, 68, 132, 58],
  },
  {
    site: 'b',
    name: 'b-có số liệu',
    mustPass: true,
    mustKeepSelector: false,
    stts: [14, 16, 20, 22, 23, 75],
  },
];
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
const unsupported = sites.filter((site) => !SUPPORTED_SITES.includes(site));
if (unsupported.length) {
  console.error(`Vị trí chưa làm: ${unsupported.join(', ')}`);
  process.exit(1);
}
const onlyStt = arg('stt')?.split(',').map(Number);
const gapMs = Number(arg('gap-ms') ?? 0);
interface DemoCase {
  stt: number;
  group: string;
  mustPass: boolean;
  mustKeepSelector: boolean;
}
// An STT in several groups (f and b share 14, 16, 22, 23, 75) runs once.
const byCase = new Map<number, DemoCase>();
for (const group of GROUPS.filter((item) => sites.includes(item.site)))
  for (const stt of group.stts.filter((n) => !onlyStt || onlyStt.includes(n))) {
    const seen = byCase.get(stt);
    byCase.set(stt, {
      stt,
      group: seen ? `${seen.group}+${group.name}` : group.name,
      mustPass: (seen?.mustPass ?? false) || group.mustPass,
      mustKeepSelector:
        (seen?.mustKeepSelector ?? false) || group.mustKeepSelector,
    });
  }
const cases = [...byCase.values()];

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
const rows: DemoRow[] = [];
for (const item of cases) {
  const question = byStt.get(item.stt);
  if (!question) throw new Error(`Không có STT ${item.stt} trong CSV`);
  const off = await runOnce(offService, question);
  const before = sink.records.length;
  const on = await runOnce(onService, question);
  const records = sink.records.slice(before);
  const acted = (site: string) =>
    records.some((r) => r.site === site && r.action === 'acted');
  const preRoute = records.filter((r) => r.site !== 'claim_check');
  const claims = records.filter((r) => r.site === 'claim_check');
  const latency = preRoute.find((r) => r.latencyMs !== undefined)?.latencyMs;
  rows.push({
    ...item,
    question,
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
  });
  console.error(`STT ${item.stt} xong`);
}

const header = `provider=${systemOneConfig.provider} model=${systemOneConfig.model ?? 'laya'} · vị trí: ${sites.join(',')} · ${new Date().toISOString()}`;
console.log(`${header}\n\n${consoleReport(rows)}`);
await mkdir('evals/runs', { recursive: true });
const file = `evals/runs/demo-${new Date().toISOString().replace(/[:.]/gu, '-')}.md`;
await writeFile(file, markdownReport(rows, header));
console.log(`\nĐã lưu ${file}`);
