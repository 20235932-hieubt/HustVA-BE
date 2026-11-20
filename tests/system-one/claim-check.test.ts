import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildClaimQuestions,
  buildClaimState,
} from '../../src/system-one/claim-check.js';
import {
  MAX_EVIDENCE_CHARS,
  selectEvidenceSentences,
  splitSentences,
} from '../../src/system-one/facts.js';

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
