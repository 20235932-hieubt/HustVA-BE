import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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
