import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  attackReply,
  otherStudentReply,
  socialReply,
} from '../../src/guardrails/policy.js';
import type { SystemOneClient } from '../../src/system-one/client.js';
import { readSystemOneConfig } from '../../src/system-one/config.js';
import { ACADEMIC_CAP, decideGate } from '../../src/system-one/gate.js';
import type { SystemOneAnswer } from '../../src/system-one/response.js';
import { memorySink } from '../../src/system-one/sink.js';
import { createSystemOneTurn } from '../../src/system-one/turn.js';
import { toolCatalog } from '../../src/tools/catalog.js';
import {
  buildKnownContext,
  buildPreRouteQuestions,
  buildPreRouteState,
  clarifyFieldsToAsk,
  LOOKUP_TOOL_IDS,
} from '../../src/system-one/pre-route.js';

const ALL = { inputGate: true, toolSkip: true, clarify: true };

describe('pre-route question builders', () => {
  test('returns no questions when every site is off', () => {
    const none = { inputGate: false, toolSkip: false, clarify: false };
    assert.deepEqual(buildPreRouteQuestions(none, 'x'), {});
  });

  test('gate asks one choice and two noul questions', () => {
    const questions = buildPreRouteQuestions(
      { ...ALL, toolSkip: false, clarify: false },
      'x',
    );
    assert.deepEqual(Object.keys(questions), [
      'loai_cau_hoi',
      'tan_cong',
      'hoi_quy_dinh',
    ]);
    const gate = questions.loai_cau_hoi;
    assert.equal(gate.type, 'choice');
    if (gate.type === 'choice')
      assert.ok('misconduct' in gate.criteria && 'meta_bot' in gate.criteria);
  });

  test('lookup labels cover exactly the tools in the catalog', () => {
    assert.deepEqual(
      Object.values(LOOKUP_TOOL_IDS).sort(),
      toolCatalog.map((tool) => tool.id).sort(),
    );
  });

  test('all sites fit in one request under the 8-question service cap', () => {
    const questions = buildPreRouteQuestions(ALL, 'x');
    assert.ok(Object.keys(questions).length <= 8);
  });

  test('clarify skips fields stated in the message or context', () => {
    assert.deepEqual(clarifyFieldsToAsk('học phí', {}), [
      'cohort',
      'program',
      'academic_year',
    ]);
    assert.deepEqual(clarifyFieldsToAsk('học phí K67 năm 2024-2025'), [
      'program',
    ]);
    assert.deepEqual(clarifyFieldsToAsk('lịch kỳ 20241 khóa 67'), ['program']);
    assert.deepEqual(
      clarifyFieldsToAsk('x', {
        cohort: 'K67',
        program: 'CNTT',
        academicYear: '2024-2025',
      }),
      [],
    );
  });

  test('state carries known context only when present', () => {
    assert.deepEqual(buildPreRouteState('m'), { message: 'm' });
    assert.deepEqual(buildPreRouteState('m', { cohort: 'K67' }), {
      message: 'm',
      known_context: 'khóa: K67',
    });
    assert.equal(buildKnownContext({}), '');
  });
});

type Answers = Record<string, SystemOneAnswer>;
function gateAnswers(
  label: string,
  p: number,
  extra: { academic?: number; attack?: number; policy?: number } = {},
): Answers {
  const probabilities: Record<string, number> = {
    academic: extra.academic ?? 0.05,
  };
  probabilities[label] = p;
  return {
    loai_cau_hoi: { type: 'choice', choice: label, probabilities },
    tan_cong: { type: 'noul', probability: extra.attack ?? 0.1 },
    hoi_quy_dinh: { type: 'noul', probability: extra.policy ?? 0.1 },
  };
}

describe('input gate decision (site a)', () => {
  const cases: [string, Answers, string, string, boolean, boolean][] = [
    [
      'attack',
      gateAnswers('attack', 0.7, { attack: 0.9 }),
      'blocked',
      'SEC-01',
      false,
      false,
    ],
    [
      'privacy_violation',
      gateAnswers('privacy_violation', 0.6),
      'blocked',
      'PRIV-03',
      true,
      false,
    ],
    [
      'personal_data',
      gateAnswers('personal_data', 0.8),
      'requires_authentication',
      'REQUIRES_AUTHENTICATION',
      true,
      true,
    ],
    [
      'out_of_scope',
      gateAnswers('out_of_scope', 0.65),
      'out_of_scope',
      'OUT_OF_SCOPE',
      true,
      true,
    ],
    [
      'misconduct',
      gateAnswers('misconduct', 0.6),
      'blocked',
      'BLOCKED',
      true,
      false,
    ],
    ['social', gateAnswers('social', 0.9), 'answered', 'SOCIAL', true, true],
    [
      'meta_bot',
      gateAnswers('meta_bot', 0.9),
      'answered',
      'SOCIAL',
      true,
      true,
    ],
  ];
  for (const [
    label,
    answers,
    status,
    reasonCode,
    retainUser,
    retainInContext,
  ] of cases)
    test(`${label} above threshold → canned ${reasonCode}`, () => {
      const action = decideGate(answers)?.action;
      assert.ok(action);
      assert.equal(action.result.status, status);
      assert.equal(action.result.reasonCode, reasonCode);
      assert.equal(action.retainUser, retainUser);
      assert.equal(action.retainInContext, retainInContext);
    });

  test('reuses the exact checkInput replies (no new reasonCode)', () => {
    const attack = decideGate(gateAnswers('attack', 0.9, { attack: 0.9 }));
    assert.deepEqual(attack?.action?.result, attackReply());
    const social = decideGate(gateAnswers('social', 0.9));
    assert.deepEqual(social?.action?.result, socialReply());
    const other = decideGate(gateAnswers('privacy_violation', 0.9));
    assert.deepEqual(other?.action?.result, otherStudentReply());
  });

  test('goes on below each threshold', () => {
    const below: Answers[] = [
      gateAnswers('attack', 0.9, { attack: 0.79 }),
      gateAnswers('attack', 0.59, { attack: 0.95 }),
      gateAnswers('privacy_violation', 0.59),
      gateAnswers('personal_data', 0.9, { policy: 0.3 }),
      gateAnswers('out_of_scope', 0.64),
      gateAnswers('misconduct', 0.59),
      gateAnswers('social', 0.59),
    ];
    for (const answers of below) {
      const decision = decideGate(answers);
      assert.ok(decision);
      assert.equal(decision.action, undefined);
    }
  });

  test('P(academic) above the cap always goes on', () => {
    const decision = decideGate(
      gateAnswers('out_of_scope', 0.75, { academic: ACADEMIC_CAP + 0.01 }),
    );
    assert.equal(decision?.label, 'out_of_scope');
    assert.equal(decision?.action, undefined);
  });

  test('academic never acts', () => {
    const decision = decideGate(gateAnswers('academic', 0.99));
    assert.deepEqual(decision, { label: 'academic', probability: 0.99 });
  });

  test('missing or malformed answers → null', () => {
    assert.equal(decideGate({}), null);
    const { tan_cong: _drop, ...partial } = gateAnswers('social', 0.9);
    void _drop;
    assert.equal(decideGate(partial), null);
    assert.equal(decideGate(gateAnswers('unknown_label', 0.9)), null);
  });
});

function fakeClient(answers: Answers | null) {
  const calls: Record<string, string>[] = [];
  const client: SystemOneClient = {
    async decide(state) {
      calls.push(state);
      return answers && { answers, latencyMs: 12, truncated: false };
    },
  };
  return { client, calls };
}
const silent = { info: () => undefined };
const signal = new AbortController().signal;

function systemOne(env: NodeJS.ProcessEnv) {
  return readSystemOneConfig(
    { SYSTEM_ONE_PROVIDER: 'laya', ...env },
    { warn: () => undefined },
  );
}
const ON = systemOne({ SYSTEM_ONE_MODE: 'on', SYSTEM_ONE_INPUT_GATE: 'true' });

describe('beforeRouting (site a)', () => {
  test('flag off → no turn object, client never built or called', () => {
    const { client, calls } = fakeClient(gateAnswers('social', 0.9));
    for (const env of [
      {},
      { SYSTEM_ONE_MODE: 'off', SYSTEM_ONE_INPUT_GATE: 'true' },
      { SYSTEM_ONE_MODE: 'on' },
      { SYSTEM_ONE_MODE: 'on', SYSTEM_ONE_INPUT_GATE: 'TRUE' },
    ])
      assert.equal(createSystemOneTurn(systemOne(env), { client }), undefined);
    assert.equal(calls.length, 0);
  });

  test('on + confident label → action, sink and log carry no text', async () => {
    const { client, calls } = fakeClient(gateAnswers('out_of_scope', 0.8));
    const sink = memorySink();
    const logs: unknown[] = [];
    const turn = createSystemOneTurn(ON, {
      client,
      sink,
      log: { info: (event, fields) => logs.push({ event, ...fields }) },
    });
    const outcome = await turn?.beforeRouting({ message: 'm' }, signal);
    assert.equal(outcome?.result.reasonCode, 'OUT_OF_SCOPE');
    assert.deepEqual(calls, [{ message: 'm' }]);
    assert.equal(sink.records[0].action, 'acted');
    assert.equal(sink.records[0].label, 'out_of_scope');
    assert.deepEqual(logs[0], {
      event: 'system_one.gate.decided',
      systemOneSite: 'input_gate',
      systemOneLabel: 'out_of_scope',
      systemOneProbPct: 80,
      systemOneAction: 'acted',
    });
    assert.ok(!JSON.stringify(logs).includes('"m"'));
  });

  test('shadow → records the would-be action, changes nothing', async () => {
    const { client } = fakeClient(gateAnswers('social', 0.9));
    const sink = memorySink();
    const shadow = systemOne({
      SYSTEM_ONE_MODE: 'shadow',
      SYSTEM_ONE_INPUT_GATE: 'true',
    });
    const turn = createSystemOneTurn(shadow, { client, sink, log: silent });
    assert.equal(
      await turn?.beforeRouting({ message: 'm' }, signal),
      undefined,
    );
    assert.equal(sink.records[0].action, 'shadow');
    assert.equal(sink.records[0].mode, 'shadow');
  });

  test('client failure (null) → old path, recorded as failed', async () => {
    const { client } = fakeClient(null);
    const sink = memorySink();
    const turn = createSystemOneTurn(ON, { client, sink, log: silent });
    assert.equal(
      await turn?.beforeRouting({ message: 'm' }, signal),
      undefined,
    );
    assert.equal(sink.records[0].action, 'failed');
  });

  test('below threshold / academic → old path', async () => {
    for (const [answers, action] of [
      [gateAnswers('out_of_scope', 0.5), 'low_confidence'],
      [gateAnswers('academic', 0.9), 'passed'],
    ] as const) {
      const sink = memorySink();
      const turn = createSystemOneTurn(ON, {
        client: fakeClient(answers).client,
        sink,
        log: silent,
      });
      assert.equal(
        await turn?.beforeRouting({ message: 'm' }, signal),
        undefined,
      );
      assert.equal(sink.records[0].action, action);
    }
  });

  test('reply to a clarification question is not classified', async () => {
    const { client, calls } = fakeClient(gateAnswers('out_of_scope', 0.9));
    const sink = memorySink();
    const turn = createSystemOneTurn(ON, { client, sink, log: silent });
    const outcome = await turn?.beforeRouting(
      { message: 'K67', previousStatus: 'needs_clarification' },
      signal,
    );
    assert.equal(outcome, undefined);
    assert.equal(calls.length, 0);
    assert.equal(sink.records[0].action, 'skipped');
  });
});
