// Probe System One question builders on labelled Vietnamese questions.
//   pnpm tsx evals/probe-system-one.ts [--replay=evals/runs/probe-*.json]
// Calls only the System One provider (no Gemini, no Mongo). Questions go
// through a PrivacySession first. Output has STT and numbers only.
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  buildClaimQuestions,
  buildClaimState,
} from '../src/system-one/claim-check.js';
import {
  createSystemOneClient,
  type SystemOneAnswer,
} from '../src/system-one/client.js';
import { readSystemOneConfig } from '../src/system-one/config.js';
import {
  buildPreRouteQuestions,
  buildPreRouteState,
} from '../src/system-one/pre-route.js';
import {
  PrivacySession,
  currentPrivacy,
  withPrivacy,
} from '../src/privacy/session.js';
import type { LogFields } from '../src/observability/logger.js';
import { analyze } from './probe/analyze.js';
import type { ClaimRow, Labels, ProbeRaw, Sample } from './probe/types.js';

const CSV = 'evals/cau-hoi-kiem-thu.csv';
const LABELS = 'evals/data/probe-labels.json';
const CLAIMS = 'evals/data/probe-claims.jsonl';
const ALL_SITES = { inputGate: true, toolSkip: true, clarify: true };

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^﻿/u, '');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

const pseudonymize = (text: string) => {
  const session = new PrivacySession();
  try {
    return withPrivacy(session, () => currentPrivacy().pseudonymize(text));
  } finally {
    session.dispose();
  }
};

function toSample(
  id: number,
  decision: Awaited<
    ReturnType<ReturnType<typeof createSystemOneClient>['decide']>
  >,
): Sample {
  if (!decision) return { id, failed: true };
  const answers: Record<string, SystemOneAnswer> = decision.answers;
  return {
    id,
    answers,
    latencyMs: decision.latencyMs,
    inputTokens: decision.inputTokens,
    truncated: decision.truncated,
  };
}

async function collect(labels: Labels, claims: ClaimRow[]): Promise<ProbeRaw> {
  const log = {
    info: () => undefined,
    warn: (event: string, fields?: LogFields) =>
      console.log(`  ! ${event}`, JSON.stringify(fields)),
  };
  const mode = process.env.SYSTEM_ONE_MODE?.trim() || 'off';
  const config = readSystemOneConfig(
    { ...process.env, SYSTEM_ONE_MODE: mode === 'off' ? 'shadow' : mode },
    log,
  );
  if (config.mode === 'off')
    throw new Error('Cấu hình SYSTEM_ONE_* không hợp lệ');
  const client = createSystemOneClient(config, { log });
  const signal = new AbortController().signal;
  const rows = parseCsv(await readFile(CSV, 'utf8'));
  const byStt = new Map(rows.slice(1).map((row) => [Number(row[0]), row[1]]));
  const stts = [
    ...new Set(
      [
        ...Object.keys(labels.a),
        ...Object.keys(labels.f),
        ...Object.keys(labels.c),
      ].map(Number),
    ),
  ];
  const pre: Sample[] = [];
  for (const stt of stts) {
    const text = byStt.get(stt);
    if (!text) throw new Error(`Không có STT ${stt} trong CSV`);
    const message = pseudonymize(text);
    const questions = buildPreRouteQuestions(ALL_SITES, message);
    pre.push(
      toSample(
        stt,
        await client.decide(buildPreRouteState(message), questions, signal),
      ),
    );
  }
  const claim: Sample[] = [];
  for (const [index, row] of claims.entries()) {
    const state = buildClaimState(pseudonymize(row.claim), {
      text: row.evidence,
      location: row.evidenceTitle,
    });
    claim.push(
      toSample(
        index,
        await client.decide(state, buildClaimQuestions(), signal),
      ),
    );
  }
  return {
    provider: config.provider,
    model: config.model ?? 'laya',
    pre,
    claim,
  };
}

const replay = process.argv
  .find((arg) => arg.startsWith('--replay='))
  ?.slice(9);
const labels = JSON.parse(await readFile(LABELS, 'utf8')) as Labels;
const claims = (await readFile(CLAIMS, 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as ClaimRow);
let raw: ProbeRaw;
if (replay) raw = JSON.parse(await readFile(replay, 'utf8')) as ProbeRaw;
else {
  raw = await collect(labels, claims);
  await mkdir('evals/runs', { recursive: true });
  const file = `evals/runs/probe-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`;
  await writeFile(file, JSON.stringify(raw));
  console.log(`Đã lưu ${file}`);
}
analyze(raw, labels, claims);
