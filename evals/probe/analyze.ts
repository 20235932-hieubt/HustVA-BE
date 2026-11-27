import {
  ATTACK_QUESTION_ID,
  CLARIFY_QUESTION_IDS,
  GATE_QUESTION_ID,
  LOOKUP_QUESTION_ID,
  POLICY_QUESTION_ID,
  type ClarifyField,
} from '../../src/system-one/pre-route.js';
import { SUPPORT_QUESTION_ID } from '../../src/system-one/claim-check.js';
import type { ClaimRow, Labels, ProbeRaw, Sample } from './types.js';

// Starting thresholds from demo-plan mục 3 (decision rules arrive in step 3).
const CAP_SWEEP = [0.1, 0.2, 0.3];
const ATTACK_NOUL = 0.8;
const PERSONAL_POLICY_CAP = 0.3;
const OUT_OF_SCOPE_EXTRA = 0.05;
const GATE_SWEEP = [0.5, 0.6, 0.7, 0.8, 0.9];
const SKIP_SWEEP = [0.7, 0.8, 0.9, 0.95];
const CLARIFY_SWEEP = [0.5, 0.7, 0.85, 0.95];
const DROP_SWEEP = [0.05, 0.1, 0.2, 0.3, 0.5];

const choice = (sample: Sample, id: string) => {
  const answer = sample.answers?.[id];
  return answer?.type === 'choice' ? answer : undefined;
};
const noul = (sample: Sample, id: string) => {
  const answer = sample.answers?.[id];
  return answer?.type === 'noul' ? answer.probability : undefined;
};
const prob = (sample: Sample, id: string, label: string) =>
  choice(sample, id)?.probabilities[label] ?? 0;

function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
function latencyLine(name: string, samples: Sample[]) {
  const ok = samples.filter((s) => !s.failed);
  const ms = ok.map((s) => s.latencyMs ?? 0);
  const tokens = ok.flatMap((s) =>
    s.inputTokens === undefined ? [] : [s.inputTokens],
  );
  const mean = tokens.length
    ? tokens.reduce((a, b) => a + b, 0) / tokens.length
    : NaN;
  console.log(
    `${name}: ${ok.length}/${samples.length} ok, p50 ${percentile(ms, 0.5).toFixed(0)} ms, ` +
      `p95 ${percentile(ms, 0.95).toFixed(0)} ms, max ${Math.max(...ms).toFixed(0)} ms, ` +
      `truncated ${ok.filter((s) => s.truncated).length}, input_tokens TB ${mean.toFixed(0)}`,
  );
}

/** Gate action at threshold `t`; 'pass' means go on to the old flow. */
export function gateAction(sample: Sample, t: number, cap: number): string {
  const gate = choice(sample, GATE_QUESTION_ID);
  if (!gate || prob(sample, GATE_QUESTION_ID, 'academic') > cap) return 'pass';
  const p = (label: string) => prob(sample, GATE_QUESTION_ID, label);
  if (
    p('attack') >= t &&
    (noul(sample, ATTACK_QUESTION_ID) ?? 0) >= ATTACK_NOUL
  )
    return 'attack';
  if (p('privacy_violation') >= t) return 'privacy_violation';
  if (p('misconduct') >= t) return 'misconduct';
  if (
    p('personal_data') >= t &&
    (noul(sample, POLICY_QUESTION_ID) ?? 1) < PERSONAL_POLICY_CAP
  )
    return 'personal_data';
  if (p('out_of_scope') >= Math.min(1, t + OUT_OF_SCOPE_EXTRA))
    return 'out_of_scope';
  if (p('social') >= t) return 'social';
  if (p('meta_bot') >= t) return 'meta_bot';
  return 'pass';
}
const SAME_TEMPLATE: Record<string, string> = { meta_bot: 'social' };

function analyzeGate(pre: Map<number, Sample>, labels: Labels) {
  const entries = Object.entries(labels.a);
  console.log('\n== a: cổng đầu vào ==');
  const acc = entries.filter(([stt]) => !pre.get(Number(stt))?.failed);
  console.log(`P(nhãn đúng) có 29 câu: ${acc.length} câu có trả lời`);
  for (const cap of CAP_SWEEP)
    for (const t of GATE_SWEEP) {
      let academicBlocked = 0;
      let handled = 0;
      let wrongLabel = 0;
      const blockedStt: string[] = [];
      for (const [stt, expected] of acc) {
        const action = gateAction(pre.get(Number(stt))!, t, cap);
        if (expected === 'academic') {
          if (action !== 'pass') {
            academicBlocked += 1;
            blockedStt.push(stt);
          }
        } else if (action === expected) handled += 1;
        else if (
          action !== 'pass' &&
          SAME_TEMPLATE[action] !== SAME_TEMPLATE[expected]
        )
          wrongLabel += 1;
      }
      const nonAcademic = acc.filter(([, e]) => e !== 'academic').length;
      console.log(
        `P(academic) ≤ ${cap}, ngưỡng ${t}: academic bị chặn ${academicBlocked}/10 [${blockedStt}]; ` +
          `xử lý đúng ${handled}/${nonAcademic}; sai nhãn ${wrongLabel}`,
      );
    }
}

function analyzeLookup(pre: Map<number, Sample>, labels: Labels) {
  console.log('\n== f: bỏ qua bộ chọn tool ==');
  const entries = Object.entries(labels.f).filter(
    ([stt]) => !pre.get(Number(stt))?.failed,
  );
  const tool = entries.filter(([, l]) => l !== 'tai_lieu');
  const docs = entries.filter(([, l]) => l === 'tai_lieu');
  const top = (stt: string) =>
    choice(pre.get(Number(stt))!, LOOKUP_QUESTION_ID)?.choice;
  const exact = entries.filter(([stt, l]) => top(stt) === l).length;
  console.log(`nhãn top-1 đúng: ${exact}/${entries.length}`);
  for (const t of SKIP_SWEEP) {
    const skipped = (stt: string) =>
      prob(pre.get(Number(stt))!, LOOKUP_QUESTION_ID, 'tai_lieu') >= t;
    const bad = tool.filter(([stt]) => skipped(stt)).map(([stt]) => stt);
    console.log(
      `ngưỡng ${t}: câu cần tool bị bỏ qua ${bad.length}/${tool.length} [${bad}]; ` +
        `câu tra tài liệu bỏ qua ${docs.filter(([stt]) => skipped(stt)).length}/${docs.length}`,
    );
  }
}

function analyzeClarify(pre: Map<number, Sample>, labels: Labels) {
  console.log('\n== c: hỏi lại khi thiếu thông tin (bỏ qua cổng a, f) ==');
  const entries = Object.entries(labels.c).filter(
    ([stt]) => !pre.get(Number(stt))?.failed,
  );
  for (const t of CLARIFY_SWEEP) {
    let caught = 0;
    let needed = 0;
    let falseAsk = 0;
    let noNeed = 0;
    for (const [stt, expected] of entries) {
      const sample = pre.get(Number(stt))!;
      const flagged = (
        Object.keys(CLARIFY_QUESTION_IDS) as ClarifyField[]
      ).filter(
        (field) => (noul(sample, CLARIFY_QUESTION_IDS[field]) ?? 0) >= t,
      );
      if (expected.length) {
        needed += 1;
        if (expected.every((f) => flagged.includes(f as ClarifyField)))
          caught += 1;
      } else {
        noNeed += 1;
        if (flagged.length) falseAsk += 1;
      }
    }
    console.log(
      `ngưỡng ${t}: bắt đúng ${caught}/${needed}; hỏi lại sai ${falseAsk}/${noNeed}`,
    );
  }
}

function analyzeClaims(raw: ProbeRaw, claims: ClaimRow[]) {
  console.log('\n== b: kiểm tra claim ==');
  const rows = claims.map((row, index) => ({ row, sample: raw.claim[index] }));
  const ok = rows.filter((r) => r.sample && !r.sample.failed);
  const p = (r: (typeof ok)[number]) =>
    noul(r.sample, SUPPORT_QUESTION_ID) ?? 1;
  for (const t of DROP_SWEEP) {
    const dropped = (kind: (c: ClaimRow) => boolean) =>
      ok.filter((r) => kind(r.row) && p(r) < t);
    const total = (kind: (c: ClaimRow) => boolean) =>
      ok.filter((r) => kind(r.row)).length;
    const good = dropped((c) => c.supported);
    const num = dropped((c) => c.falseKind === 'number');
    const mean = dropped((c) => c.falseKind === 'meaning');
    console.log(
      `bỏ khi P < ${t}: claim đúng bị bỏ ${good.length}/${total((c) => c.supported)} ` +
        `[STT ${good.map((r) => r.row.stt)}]; sai số bị bỏ ${num.length}/${total((c) => c.falseKind === 'number')}; ` +
        `sai nghĩa bị bỏ ${mean.length}/${total((c) => c.falseKind === 'meaning')}`,
    );
  }
}

export function analyze(
  raw: ProbeRaw,
  labels: Labels,
  claims: ClaimRow[],
): void {
  console.log(`provider=${raw.provider} model=${raw.model}`);
  const pre = new Map(raw.pre.map((s) => [s.id, s]));
  latencyLine('a+c+f (7 câu hỏi/request)', raw.pre);
  latencyLine('b (1 claim/request)', raw.claim);
  analyzeGate(pre, labels);
  analyzeLookup(pre, labels);
  analyzeClarify(pre, labels);
  analyzeClaims(raw, claims);
}
