import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { readChatConfig } from '../../src/agent/config.js';
import { createChatAgent } from '../../src/agent/graph.js';
import type { AgentModel } from '../../src/agent/model.js';
import type { Draft } from '../../src/chat/contracts.js';
import { fallback, validateDraft } from '../../src/guardrails/policy.js';
import type { Evidence, KnowledgePort } from '../../src/knowledge/stub.js';
import { PrivacySession, withPrivacy } from '../../src/privacy/session.js';
import {
  buildClaimQuestions,
  buildClaimState,
  CLAIM_SUPPORT_MIN,
  CLAIMS_DROPPED_WARNING,
  CLAIMS_UNSUPPORTED,
  createClaimChecker,
  FACT_MISMATCH_LABEL,
  type ClaimCheckerDeps,
} from '../../src/system-one/claim-check.js';
import type { SystemOneClient } from '../../src/system-one/client.js';
import { readSystemOneConfig } from '../../src/system-one/config.js';
import {
  MAX_EVIDENCE_CHARS,
  missingFacts,
  selectEvidenceSentences,
  splitSentences,
} from '../../src/system-one/facts.js';
import { memorySink } from '../../src/system-one/sink.js';

describe('claim question builder', () => {
  test('asks one noul support question', () => {
    const questions = buildClaimQuestions();
    assert.deepEqual(Object.keys(questions), ['ho_tro']);
    assert.equal(questions.ho_tro.type, 'noul');
  });

  test('short evidence is passed through unchanged', () => {
    const state = buildClaimState('khẳng định', { text: 'Đoạn ngắn.' });
    assert.deepEqual(state, { claim: 'khẳng định', evidence: 'Đoạn ngắn.' });
  });

  test('location is prefixed to the evidence', () => {
    const state = buildClaimState('c', {
      text: 'Nội dung.',
      location: 'Điều 5',
    });
    assert.equal(state.evidence, 'Điều 5\nNội dung.');
  });
});

describe('evidence sentence selection', () => {
  const filler = Array.from(
    { length: 60 },
    (_, i) => `Câu đệm số ${i} không liên quan gì tới đề bài.`,
  );
  const target = 'Học bổng được công bố chậm nhất vào tuần học thứ 10.';
  const text = [...filler.slice(0, 30), target, ...filler.slice(30)].join(' ');

  test('keeps the sentence that overlaps the claim and respects the cap', () => {
    const picked = selectEvidenceSentences(
      'Học bổng công bố chậm nhất tuần học thứ 10',
      text,
      200,
    );
    assert.ok(picked.length <= 200);
    assert.ok(picked.includes(target));
  });

  test('keeps original sentence order', () => {
    const picked = selectEvidenceSentences('Câu đệm số 3 và số 1', text, 400);
    const order = picked.split('\n').map((line) => text.indexOf(line));
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
    );
  });

  test('default cap is MAX_EVIDENCE_CHARS and short text is untouched', () => {
    assert.equal(selectEvidenceSentences('x', 'ngắn'), 'ngắn');
    assert.ok(
      selectEvidenceSentences('x', filler.join(' ').repeat(3)).length <=
        MAX_EVIDENCE_CHARS,
    );
  });

  test('splits on sentence punctuation and newlines', () => {
    assert.deepEqual(splitSentences('Một. Hai\nBa'), ['Một.', 'Hai', 'Ba']);
  });
});

describe('missingFacts (code check)', () => {
  const ok = (claim: string, evidence: string) =>
    assert.deepEqual(missingFacts(claim, evidence), [], claim);

  test('number formats match: decimal comma, leading zero, %, thousands', () => {
    ok('Điểm từ 3.2 trở lên', 'điểm trung bình từ 3,2 trở lên');
    ok('Cần 03 tín chỉ', 'cần 3 tín chỉ');
    ok('Giảm 70% học phí', 'giảm 70 % học phí');
    ok('Mức 1.500.000 đồng', 'mức 1500000 đồng');
    ok('Học kỳ 20231', 'học kỳ 2023.1');
  });

  test('small numbers match their Vietnamese words in the evidence', () => {
    ok('Tối đa 3 học kỳ', 'tối đa ba học kỳ');
    ok('Không quá 10 ngày', 'không quá mười ngày');
  });

  test('a claim without hard facts passes the code check', () => {
    ok('Sinh viên nộp hồ sơ tại văn phòng', 'Nội dung khác hẳn');
  });

  test('different numbers and dates are reported', () => {
    assert.deepEqual(missingFacts('Điểm từ 3,5', 'điểm từ 3,2'), ['3,5']);
    assert.deepEqual(
      missingFacts('Hạn ngày 16/03/2025', 'hạn ngày 15/03/2025'),
      ['16'],
    );
    assert.deepEqual(missingFacts('Năm học 2025-2026', 'năm học 2024-2025'), [
      '2026',
    ]);
  });

  test('course codes and cohorts must appear in the evidence', () => {
    ok('Học phần IT3080', 'học phần IT 3080');
    ok('Áp dụng cho K68', 'áp dụng cho khóa 68');
    assert.deepEqual(missingFacts('Học phần IT3090', 'học phần IT3080'), [
      'IT3090',
    ]);
    assert.deepEqual(missingFacts('Áp dụng cho K69', 'áp dụng cho K68'), [
      'K69',
    ]);
  });

  test('privacy tokens and masks are not facts', () => {
    const token = `[[PII_EMAIL_${'0123456789abcdef'.repeat(2)}]]`;
    ok(`Liên hệ ${token}`, 'liên hệ phòng đào tạo');
    ok('Số [thông tin đã ẩn]', 'không có số');
  });
});

// --- review() -------------------------------------------------------------

const E1: Evidence = {
  id: 'e1',
  text: 'Sinh viên có điểm trung bình từ 3,2 trở lên được xét học bổng loại giỏi.',
  isMock: false,
  title: 'Quy định học bổng',
  location: 'Điều 5',
  url: 'https://ctsv.hust.edu.vn/hoc-bong',
  quality: 'accepted',
};
const E2: Evidence = {
  id: 'e2',
  text: 'Hạn nộp hồ sơ là ngày 15/03/2025.',
  isMock: false,
  title: 'Thông báo hồ sơ',
  quality: 'accepted',
};
const E3: Evidence = {
  id: 'e3',
  text: 'Học phần IT3080 có ba tín chỉ.',
  isMock: false,
  title: 'Chương trình đào tạo',
  quality: 'needs_review',
};
const GRANTED: Record<string, Evidence> = { e1: E1, e2: E2, e3: E3 };
const C1 = {
  text: 'Điểm trung bình từ 3.2 trở lên được xét học bổng loại giỏi.',
  evidenceIds: ['e1'],
};
const C2 = { text: 'Hạn nộp hồ sơ là ngày 15/3/2025.', evidenceIds: ['e2'] };
const C3 = { text: 'Học phần IT3080 có 3 tín chỉ.', evidenceIds: ['e3'] };
const answered = (...claims: Draft['claims']): Draft => ({
  status: 'answered',
  claims,
  missingFields: [],
});

/** Answers P(true) per claim: the first key contained in the claim wins. */
function fakeClient(
  probabilities: Record<string, number | null | 'truncated'> = {},
) {
  const states: Record<string, string>[] = [];
  const client: SystemOneClient = {
    async decide(state) {
      states.push(state);
      const key = Object.keys(probabilities).find((k) =>
        state.claim.includes(k),
      );
      const value = key === undefined ? 0.95 : probabilities[key];
      if (value === null) return null;
      return {
        answers: {
          ho_tro: {
            type: 'noul',
            probability: value === 'truncated' ? 0.01 : value,
          },
        },
        latencyMs: 9,
        truncated: value === 'truncated',
      };
    },
  };
  return { client, states };
}

const silent = { info: () => undefined, warn: () => undefined };
const signal = new AbortController().signal;
const systemOne = (env: NodeJS.ProcessEnv) =>
  readSystemOneConfig(
    { SYSTEM_ONE_PROVIDER: 'laya', ...env },
    { warn: () => undefined },
  );
const ON = systemOne({ SYSTEM_ONE_MODE: 'on', SYSTEM_ONE_CLAIM_CHECK: 'true' });
const SHADOW = systemOne({
  SYSTEM_ONE_MODE: 'shadow',
  SYSTEM_ONE_CLAIM_CHECK: 'true',
});

function checker(deps: ClaimCheckerDeps, config = ON) {
  const made = createClaimChecker(config, { log: silent, ...deps });
  assert.ok(made);
  return made;
}

describe('createClaimChecker', () => {
  test('flag off → undefined, client never called', () => {
    const { client, states } = fakeClient();
    for (const env of [
      {},
      { SYSTEM_ONE_MODE: 'off', SYSTEM_ONE_CLAIM_CHECK: 'true' },
      { SYSTEM_ONE_MODE: 'on' },
      { SYSTEM_ONE_MODE: 'on', SYSTEM_ONE_INPUT_GATE: 'true' },
    ])
      assert.equal(createClaimChecker(systemOne(env), { client }), undefined);
    assert.equal(states.length, 0);
  });
});

describe('review (site b)', () => {
  test('all claims supported → exactly validateDraft', async () => {
    const privacy = new PrivacySession();
    const draft = answered(C1, C2, C3);
    const { client, states } = fakeClient();
    const result = await checker({ client }).review(
      draft,
      GRANTED,
      privacy,
      signal,
    );
    assert.deepEqual(result, validateDraft(draft, GRANTED, privacy));
    assert.equal(states.length, 3);
    assert.deepEqual(states[1], {
      claim: C2.text,
      evidence: E2.text,
    });
    assert.equal(states[0].evidence, `Điều 5\n${E1.text}`);
  });

  test('fact mismatch → dropped without calling the model', async () => {
    const privacy = new PrivacySession();
    const wrong = { ...C2, text: 'Hạn nộp hồ sơ là ngày 20/3/2025.' };
    const { client, states } = fakeClient();
    const sink = memorySink();
    const result = await checker({ client, sink }).review(
      answered(C1, wrong),
      GRANTED,
      privacy,
      signal,
    );
    assert.equal(states.length, 1);
    assert.equal(states[0].claim, C1.text);
    assert.equal(result.reasonCode, 'GROUNDED');
    assert.ok(!result.answer.includes('20/3'));
    const mismatch = sink.records.find((r) => r.label === FACT_MISMATCH_LABEL);
    assert.equal(mismatch?.action, 'acted');
    assert.equal(mismatch?.answers, null);
  });

  test('dropping the middle claim renumbers sources from [1]', async () => {
    const privacy = new PrivacySession();
    const { client } = fakeClient({ 'Hạn nộp': 0.1 });
    const result = await checker({ client }).review(
      answered(C1, C2, C3),
      GRANTED,
      privacy,
      signal,
    );
    const expected = validateDraft(answered(C1, C3), GRANTED, privacy);
    assert.equal(result.status, 'answered');
    assert.equal(result.reasonCode, 'GROUNDED');
    assert.equal(result.answer, expected.answer);
    assert.match(result.answer, /tín chỉ\. \[2\]/u);
    assert.ok(!result.answer.includes('[3]'));
    assert.match(result.answer, /\[2\] Chương trình đào tạo/u);
    assert.deepEqual(
      result.citations.map((c) => c.evidenceId),
      ['e1', 'e3'],
    );
    // PDF warning from validateDraft first, then the claim-check warning.
    assert.deepEqual(result.warnings, [
      ...expected.warnings,
      CLAIMS_DROPPED_WARNING,
    ]);
    assert.equal(result.warnings.length, 2);
  });

  test('threshold: P = 0.30 keeps, P < 0.30 drops', async () => {
    const privacy = new PrivacySession();
    const { client } = fakeClient({
      'Điểm trung bình': CLAIM_SUPPORT_MIN,
      'Hạn nộp': 0.29,
    });
    const result = await checker({ client }).review(
      answered(C1, C2),
      GRANTED,
      privacy,
      signal,
    );
    assert.deepEqual(
      result.citations.map((c) => c.evidenceId),
      ['e1'],
    );
  });

  test('every claim dropped → CLAIMS_UNSUPPORTED', async () => {
    const privacy = new PrivacySession();
    const { client } = fakeClient({ Điểm: 0.05, Hạn: 0.05 });
    const result = await checker({ client }).review(
      answered(C1, C2),
      GRANTED,
      privacy,
      signal,
    );
    assert.equal(result.status, 'insufficient_evidence');
    assert.equal(result.reasonCode, CLAIMS_UNSUPPORTED);
    assert.equal(result.answer, fallback('insufficient_evidence').answer);
    assert.deepEqual(result.citations, []);
    assert.deepEqual(result.warnings, []);
  });

  test('null or truncated answers keep the claim', async () => {
    const privacy = new PrivacySession();
    const draft = answered(C1, C2);
    const { client } = fakeClient({ Điểm: null, Hạn: 'truncated' });
    const sink = memorySink();
    const result = await checker({ client, sink }).review(
      draft,
      GRANTED,
      privacy,
      signal,
    );
    assert.deepEqual(result, validateDraft(draft, GRANTED, privacy));
    assert.deepEqual(sink.records.map((r) => r.action).sort(), [
      'failed',
      'low_confidence',
    ]);
  });

  test('client throwing (contract broken) → old result, warn log', async () => {
    const privacy = new PrivacySession();
    const draft = answered(C1);
    const warns: string[] = [];
    const result = await checker({
      client: {
        decide: async () => {
          throw new Error('boom');
        },
      },
      log: { info: () => undefined, warn: (event) => warns.push(event) },
    }).review(draft, GRANTED, privacy, signal);
    assert.deepEqual(result, validateDraft(draft, GRANTED, privacy));
    assert.deepEqual(warns, ['guardrail.claims.check_failed']);
  });

  test('ungranted or mock evidence → CLAIM_UNGROUNDED, unchecked', async () => {
    const privacy = new PrivacySession();
    const { client, states } = fakeClient({ Điểm: 0.01 });
    const review = checker({ client });
    const ungranted = await review.review(
      answered(C1, { ...C2, evidenceIds: ['e9'] }),
      GRANTED,
      privacy,
      signal,
    );
    const mock = await review.review(
      answered(C1),
      { e1: { ...E1, isMock: true } },
      privacy,
      signal,
    );
    assert.equal(ungranted.reasonCode, 'CLAIM_UNGROUNDED');
    assert.equal(mock.reasonCode, 'CLAIM_UNGROUNDED');
    assert.equal(states.length, 0);
  });

  test('unknown PII token or secret → privacy code, never laundered', async () => {
    const privacy = new PrivacySession();
    const foreign = `[[PII_EMAIL_${'ab'.repeat(16)}]]`;
    // The client would drop the offending claims: the draft must still fail.
    const { client, states } = fakeClient({ 'Liên hệ': 0.01, OTP: 0.01 });
    const review = checker({ client });
    const inClaim = await review.review(
      answered(C1, { ...C2, text: `Liên hệ ${foreign}` }),
      GRANTED,
      privacy,
      signal,
    );
    const inRefs = await review.review(
      { ...answered(C1), entityRefs: [foreign] },
      GRANTED,
      privacy,
      signal,
    );
    const secret = await review.review(
      answered(C1, { ...C2, text: 'Mã OTP là 123456' }),
      GRANTED,
      privacy,
      signal,
    );
    assert.equal(inClaim.reasonCode, 'PRIVACY_REFERENCE_INVALID');
    assert.equal(inRefs.reasonCode, 'PRIVACY_REFERENCE_INVALID');
    assert.equal(secret.reasonCode, 'PRIVACY_CONTENT_INVALID');
    assert.equal(states.length, 0);
  });

  test('owned token: sent as token, kept in entityRefs after drop', async () => {
    const privacy = new PrivacySession();
    const masked = privacy.pseudonymize('Liên hệ a.b@example.com');
    const token = masked.match(/\[\[PII_EMAIL_[a-f0-9]{32}\]\]/u)?.[0];
    assert.ok(token);
    privacy.seal();
    const claim = { text: `Gửi hồ sơ qua ${token}.`, evidenceIds: ['e2'] };
    const { client, states } = fakeClient({ 'Gửi hồ sơ': 0.02 });
    const result = await checker({ client }).review(
      { ...answered(C1, claim), entityRefs: [token] },
      GRANTED,
      privacy,
      signal,
    );
    assert.equal(result.reasonCode, 'GROUNDED');
    assert.ok(!result.answer.includes(token));
    assert.ok(states.some((s) => s.claim.includes(token)));
    assert.ok(states.every((s) => !s.claim.includes('a.b@example.com')));
  });

  test('non-answered draft → validateDraft, unchecked', async () => {
    const privacy = new PrivacySession();
    const draft: Draft = {
      status: 'needs_clarification',
      claims: [],
      missingFields: ['cohort'],
    };
    const { client, states } = fakeClient();
    const result = await checker({ client }).review(
      draft,
      GRANTED,
      privacy,
      signal,
    );
    assert.deepEqual(result, validateDraft(draft, GRANTED, privacy));
    assert.equal(states.length, 0);
  });

  test('shadow → same result as off, sink and log say shadow', async () => {
    const privacy = new PrivacySession();
    const draft = answered(C1, C2);
    const { client } = fakeClient({ 'Hạn nộp': 0.01 });
    const sink = memorySink();
    const logs: unknown[] = [];
    let clock = 100;
    const result = await checker(
      {
        client,
        sink,
        now: () => (clock += 20),
        log: {
          info: (event, fields) => logs.push({ event, ...fields }),
          warn: () => undefined,
        },
      },
      SHADOW,
    ).review(draft, GRANTED, privacy, signal);
    assert.deepEqual(result, validateDraft(draft, GRANTED, privacy));
    assert.deepEqual(
      sink.records.map((r) => r.action),
      ['passed', 'shadow'],
    );
    // Numbers and labels only: no claim or evidence text in the logger.
    assert.deepEqual(logs, [
      {
        event: 'guardrail.claims.checked',
        systemOneSite: 'claim_check',
        systemOneAction: 'shadow',
        claimsChecked: 2,
        claimsDropped: 1,
        durationMs: 20,
      },
    ]);
  });
});

// --- graph wiring ---------------------------------------------------------

describe('graph.ts site b wiring', () => {
  const knowledge: KnowledgePort = {
    search: async () => ({
      status: 'results',
      evidence: [E1, E2, E3],
      warnings: [],
    }),
    read: async () => ({ status: 'empty', evidence: [], warnings: [] }),
  };
  const scripted = (draft: Draft): AgentModel => {
    let step = 0;
    return {
      async invoke() {
        step += 1;
        return new AIMessage({
          content: '',
          tool_calls: [
            step === 1
              ? {
                  id: 'call-1',
                  name: 'search_knowledge',
                  args: { query: 'học bổng loại giỏi' },
                }
              : { id: 'call-2', name: 'submit_answer', args: draft },
          ],
        });
      },
    };
  };
  const input = {
    message: 'Điều kiện học bổng loại giỏi là gì?',
    context: {},
    history: [],
  };
  const run = (
    checkerOrUndefined: ReturnType<typeof createClaimChecker>,
    draft: Draft,
  ) =>
    withPrivacy(new PrivacySession(), () =>
      createChatAgent(
        scripted(draft),
        knowledge,
        readChatConfig({}),
        checkerOrUndefined,
      )(input, signal),
    );

  test('checker supporting every claim → same ChatResult as no checker', async () => {
    const draft = answered(C1, C2, C3);
    const { client, states } = fakeClient();
    const off = await run(undefined, draft);
    const on = await run(checker({ client }), draft);
    assert.equal(off.reasonCode, 'GROUNDED');
    assert.deepEqual(on, off);
    assert.equal(states.length, 3);
  });

  test('checker drops an unsupported claim inside the graph', async () => {
    const { client } = fakeClient({ 'Hạn nộp': 0.05 });
    const result = await run(checker({ client }), answered(C1, C2));
    assert.equal(result.reasonCode, 'GROUNDED');
    assert.deepEqual(
      result.citations.map((c) => c.evidenceId),
      ['e1'],
    );
    assert.deepEqual(result.warnings, [CLAIMS_DROPPED_WARNING]);
  });
});
