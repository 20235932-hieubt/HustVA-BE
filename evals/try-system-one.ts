// Try the configured System One provider (laya or clef) on example cases.
//   pnpm tsx evals/try-system-one.ts [cases.json]
// Uses .env as is, except SYSTEM_ONE_MODE=off is treated as shadow so the
// provider is called. Example files must not contain real student data.
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import {
  createSystemOneClient,
  type SystemOneAnswer,
  type SystemOneQuestion,
} from '../src/system-one/client.js';
import { readSystemOneConfig } from '../src/system-one/config.js';
import type { LogFields } from '../src/observability/logger.js';

interface Case {
  name: string;
  state: Record<string, string>;
  questions?: Record<string, SystemOneQuestion>;
  expect?: Record<string, string>;
}
interface CasesFile {
  questions: Record<string, SystemOneQuestion>;
  cases: Case[];
}

const file = process.argv[2] ?? 'services/system-one/examples/cases.json';
const mode = process.env.SYSTEM_ONE_MODE?.trim() || 'off';
const log = {
  info: () => undefined,
  warn: (event: string, fields?: LogFields) =>
    console.log(`  ! ${event}`, JSON.stringify(fields)),
};
const config = readSystemOneConfig(
  { ...process.env, SYSTEM_ONE_MODE: mode === 'off' ? 'shadow' : mode },
  log,
);
if (config.mode === 'off') {
  console.log('Cấu hình SYSTEM_ONE_* không hợp lệ (xem log ở trên).');
  process.exit(1);
}
console.log(`provider=${config.provider} model=${config.model ?? 'laya'}`);
const client = createSystemOneClient(config, { log });
const data = JSON.parse(await readFile(file, 'utf8')) as CasesFile;

function show(answer: SystemOneAnswer) {
  return answer.type === 'noul'
    ? answer.probability.toFixed(2)
    : `${answer.choice} (${answer.probabilities[answer.choice].toFixed(2)})`;
}
function matches(answer: SystemOneAnswer, expected: string) {
  if (answer.type === 'choice') return answer.choice === expected;
  const bound = Number(expected.slice(1));
  return expected.startsWith('>')
    ? answer.probability > bound
    : answer.probability < bound;
}

let passed = 0;
let total = 0;
for (const item of data.cases) {
  const decision = await client.decide(
    item.state,
    item.questions ?? data.questions,
    new AbortController().signal,
  );
  if (!decision) {
    console.log(`\n[${item.name}] thất bại (fail-open → null)`);
    continue;
  }
  console.log(`\n[${item.name}] ${decision.latencyMs.toFixed(0)} ms`);
  for (const [id, answer] of Object.entries(decision.answers)) {
    const expected = item.expect?.[id];
    let mark = '';
    if (expected !== undefined) {
      const ok = matches(answer, expected);
      passed += Number(ok);
      total += 1;
      mark = `  ${ok ? 'OK ' : 'SAI'} (mong đợi ${expected})`;
    }
    console.log(`  ${id.padEnd(16)} ${show(answer)}${mark}`);
  }
}
if (total) console.log(`\nKhớp kỳ vọng: ${passed}/${total}`);
