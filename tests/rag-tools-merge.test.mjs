import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createChatAgent } from '../dist/agent/graph.js';
import { RagKnowledge } from '../dist/knowledge/rag.js';
import { validateDraft } from '../dist/guardrails/policy.js';
import { PrivacySession, withPrivacy } from '../dist/privacy/session.js';
import {
  providerMessages,
  publicToolResult,
} from '../dist/privacy/provider.js';

process.env.LOG_LEVEL = 'silent';
for (const key of [
  'GEMINI_API_KEY',
  'HUST_API_TOKEN',
  'HUST_AUTHORIZATION_TOKEN',
  'TOOL_MANAGEMENT_TOKEN',
])
  delete process.env[key];

const config = {
  timeoutMs: 30000,
  maxToolRounds: 3,
  maxToolCalls: 6,
  maxModelCalls: 4,
  maxTurnTokens: 50000,
  maxOutputTokens: 1000,
};
const signal = () => new AbortController().signal;
const call = (name, args, id) =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id }] });
const passage = {
  id: 'passage-1',
  text: 'Sinh viên nộp hồ sơ trước ngày 15/10.',
  isMock: false,
  title: 'Quy định học bổng',
  url: 'https://ctsv.hust.edu.vn/quy-dinh',
  documentId: 'document-1',
  versionId: 'version-1',
  location: 'Điều 2, trang 1',
  quality: 'needs_review',
};

async function privateTurn(work) {
  const privacy = new PrivacySession();
  try {
    return await withPrivacy(privacy, () => work(privacy));
  } finally {
    privacy.dispose();
  }
}

test('merged RAG keeps question meaning, cohort filtering, section reads and cited answers through provider boundary', async () => {
  const chunk = {
    id: passage.id,
    index: 0,
    kind: 'text',
    headings: ['Điều 2'],
    pageStart: 1,
    pageEnd: 1,
    text: passage.text,
    embedText: passage.text,
    payload: { ...passage, sourceId: 'ctsv', cohorts: ['K69'] },
  };
  let searches = 0;
  let reads = 0;
  const knowledge = new RagKnowledge(
    {
      async search(query, limit, filter) {
        searches++;
        assert.equal(query, 'hạn nộp hồ sơ học bổng');
        assert.equal(filter.cohort, 'K69');
        assert.equal(filter.sourceId, 'ctsv');
        assert.equal(limit, 9);
        return [{ score: 0.9, chunk }];
      },
      async chunks(id) {
        reads++;
        assert.equal(id, 'document-1');
        return [chunk];
      },
    },
    { minScore: 0.45, outputBudget: 7600 },
  );
  let round = 0;
  const model = {
    async invoke(messages, _signal, options) {
      const sent = providerMessages(messages);
      const question = sent.find((message) => message.getType() === 'human');
      assert.match(question.content, /hạn nộp hồ sơ học bổng/);
      const tools = sent.filter((message) => message.getType() === 'tool');
      if (round > 0) {
        const result = JSON.parse(tools.at(-1).content);
        assert.equal(result.status, 'results');
        assert.equal(result.evidence[0].id, passage.id);
        assert.match(result.evidence[0].text, /15\/10/);
      }
      round++;
      if (round === 1)
        return call(
          'search_knowledge',
          { query: 'hạn nộp hồ sơ học bổng', sourceId: 'ctsv', limit: 3 },
          'search-1',
        );
      if (round === 2)
        return call(
          'read_document_section',
          { evidenceId: passage.id },
          'read-1',
        );
      assert.equal(options.final, false);
      const readCall = sent
        .filter((message) => message.getType() === 'ai')
        .at(-1);
      assert.equal(readCall.tool_calls[0].args.evidenceId, passage.id);
      return call(
        'submit_answer',
        {
          status: 'answered',
          claims: [
            { text: 'Hạn nộp hồ sơ là ngày 15/10.', evidenceIds: [passage.id] },
          ],
          missingFields: [],
        },
        'answer-1',
      );
    },
  };
  const result = await privateTurn(() =>
    createChatAgent(
      model,
      knowledge,
      config,
    )(
      {
        message: 'hạn nộp hồ sơ học bổng là khi nào?',
        context: { cohort: 'K69' },
        history: [],
      },
      signal(),
    ),
  );
  assert.equal(searches, 1);
  assert.equal(reads, 1);
  assert.equal(result.status, 'answered');
  assert.equal(result.retrievalMode, 'rag');
  assert.match(result.answer, /15\/10.*\[1\]/);
  assert.equal(result.citations[0].evidenceId, passage.id);
  assert.ok(result.warnings.length > 0);
});

test('provider rejects unregistered, modified, mock and credential-bearing evidence', async () => {
  await privateTurn(() => {
    assert.equal(
      publicToolResult({ status: 'results', evidence: [passage] }).evidence
        .length,
      0,
    );
    assert.equal(
      publicToolResult(
        { status: 'results', evidence: [{ ...passage, isMock: true }] },
        true,
      ).evidence.length,
      0,
    );
    assert.equal(
      publicToolResult(
        {
          status: 'results',
          evidence: [{ ...passage, text: 'password=FAKE_TEST_VALUE' }],
        },
        true,
      ).evidence.length,
      0,
    );
    const registered = publicToolResult(
      { status: 'results', evidence: [passage] },
      true,
    );
    const messages = providerMessages([
      new HumanMessage('học bổng'),
      call('search_knowledge', { query: 'học bổng' }, 'search'),
      new ToolMessage({
        tool_call_id: 'search',
        content: JSON.stringify(registered),
      }),
    ]);
    assert.equal(JSON.parse(messages.at(-1).content).evidence.length, 1);
    assert.equal(
      publicToolResult({
        status: 'results',
        evidence: [{ ...registered.evidence[0], text: 'Nội dung bị thay đổi' }],
      }).evidence.length,
      0,
    );
  });
  await privateTurn(() =>
    assert.equal(
      publicToolResult({ status: 'results', evidence: [passage] }).evidence
        .length,
      0,
    ),
  );
});

test('grounding and privacy gates both apply to the final RAG answer', async () => {
  await privateTurn((privacy) => {
    const draft = {
      status: 'answered',
      claims: [{ text: 'Hạn nộp là 15/10.', evidenceIds: [passage.id] }],
      missingFields: [],
    };
    assert.equal(
      validateDraft(draft, {}, privacy).reasonCode,
      'CLAIM_UNGROUNDED',
    );
    assert.equal(
      validateDraft(draft, { [passage.id]: passage }, privacy).reasonCode,
      'GROUNDED',
    );
    assert.equal(
      validateDraft(
        {
          ...draft,
          entityRefs: ['[[PII_NAME_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]]'],
        },
        { [passage.id]: passage },
        privacy,
      ).reasonCode,
      'PRIVACY_REFERENCE_INVALID',
    );
  });
});

test('RAG refuses arbitrary section ids and still forces final submission at model budget', async () => {
  let round = 0;
  const model = {
    async invoke(messages, _signal, options) {
      round++;
      if (round === 1)
        return call(
          'read_document_section',
          { evidenceId: 'foreign-id' },
          'foreign',
        );
      assert.equal(options.final, true);
      const output = JSON.parse(messages.at(-2).content);
      assert.equal(output.status, 'not_granted');
      return call(
        'submit_answer',
        { status: 'insufficient_evidence', claims: [], missingFields: [] },
        'answer',
      );
    },
  };
  const knowledge = {
    search() {
      throw new Error('must not search');
    },
    read() {
      throw new Error('must not read');
    },
  };
  const result = await privateTurn(() =>
    createChatAgent(model, knowledge, { ...config, maxModelCalls: 2 })(
      { message: 'quy định học bổng', context: {}, history: [] },
      signal(),
    ),
  );
  assert.equal(result.status, 'insufficient_evidence');
  assert.equal(round, 2);
});
