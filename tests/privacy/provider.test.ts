import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AIMessage,
  ChatMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { systemPrompt } from '../../src/agent/prompts.js';
import { ChatError } from '../../src/chat/contracts.js';
import {
  providerMessages,
  publicToolResult,
} from '../../src/privacy/provider.js';
import { PrivacySession, withPrivacy } from '../../src/privacy/session.js';

function withSession<T>(work: (privacy: PrivacySession) => T): T {
  const privacy = new PrivacySession();
  try {
    return withPrivacy(privacy, () => work(privacy));
  } finally {
    privacy.dispose();
  }
}

function rejectsWith(code: string) {
  return (error: unknown) => error instanceof ChatError && error.code === code;
}

const question = new HumanMessage(
  JSON.stringify({ message: 'Điều kiện học bổng là gì?', context: {} }),
);

// Shape returned by Gemini 3 when it calls a tool: the function call part
// carries an opaque thought signature next to the parsed tool_calls.
function geminiToolCall(
  name = 'search_knowledge',
  args: Record<string, unknown> = { query: 'học bổng', limit: 3 },
) {
  return new AIMessage({
    content: [
      {
        type: 'functionCall',
        functionCall: { name, args },
        thoughtSignature: 'c2lnbmF0dXJl',
      },
    ],
    tool_calls: [{ id: 'call-1', name, args, type: 'tool_call' }],
  });
}

function evidenceResult() {
  return {
    status: 'results',
    evidence: [
      {
        id: 'ev-1',
        text: 'Sinh viên đạt GPA từ 3,2 được xét học bổng.',
        isMock: false,
        quality: 'accepted',
      },
    ],
  };
}

describe('providerMessages', () => {
  test('accepts a tool-call AIMessage whose content is an array of parts', () => {
    const output = withSession(() =>
      providerMessages([question, geminiToolCall()]),
    );

    assert.equal(output.length, 3);
    assert.ok(output[0] instanceof SystemMessage);
    assert.equal(output[0].content, systemPrompt);
    const call = output[2] as AIMessage;
    assert.ok(call instanceof AIMessage);
    assert.equal(call.content, '');
    assert.deepEqual(
      call.tool_calls?.map(({ id, name, args }) => ({ id, name, args })),
      [
        {
          id: 'tool-1',
          name: 'search_knowledge',
          args: { query: 'học bổng', limit: 3 },
        },
      ],
    );
  });

  test('does not forward the thought signature or any array part', () => {
    const output = withSession(() =>
      providerMessages([question, geminiToolCall()]),
    );

    assert.doesNotMatch(JSON.stringify(output), /thoughtSignature|c2lnbmF0/u);
  });

  test('rebuilds the tool payload from publicToolResult after an array-content call', () => {
    const { output, expected } = withSession(() => {
      const registered = publicToolResult(evidenceResult(), true);
      const tool = new ToolMessage({
        tool_call_id: 'call-1',
        content: JSON.stringify({ ...registered, extra: 'raw tool field' }),
      });
      return {
        output: providerMessages([question, geminiToolCall(), tool]),
        expected: JSON.stringify(publicToolResult(registered)),
      };
    });

    const result = output[3] as ToolMessage;
    assert.ok(result instanceof ToolMessage);
    assert.equal(result.tool_call_id, 'tool-1');
    assert.equal(result.content, expected);
    assert.doesNotMatch(String(result.content), /raw tool field/u);
  });

  test('rejects a HumanMessage whose content is not a string', () => {
    const human = new HumanMessage({
      content: [{ type: 'text', text: 'Điều kiện học bổng?' }],
    });

    assert.throws(
      () => withSession(() => providerMessages([human])),
      rejectsWith('PRIVACY_CONTENT_UNSUPPORTED'),
    );
  });

  test('rejects an AIMessage without tool_calls whose content is not a string', () => {
    const answer = new AIMessage({
      content: [{ type: 'text', text: 'Câu trả lời cũ.' }],
    });

    assert.throws(
      () => withSession(() => providerMessages([question, answer])),
      rejectsWith('PRIVACY_CONTENT_UNSUPPORTED'),
    );
  });

  test('rejects an AIMessage with an empty tool_calls list and array content', () => {
    const answer = new AIMessage({
      content: [{ type: 'text', text: 'Câu trả lời cũ.' }],
      tool_calls: [],
    });

    assert.throws(
      () => withSession(() => providerMessages([question, answer])),
      rejectsWith('PRIVACY_CONTENT_UNSUPPORTED'),
    );
  });

  test('still rejects an unknown tool even when content is an array', () => {
    assert.throws(
      () =>
        withSession(() =>
          providerMessages([question, geminiToolCall('run_shell', {})]),
        ),
      rejectsWith('PRIVACY_TOOL_UNSUPPORTED'),
    );
  });

  test('still rejects a tool result without a matching call', () => {
    const orphan = new ToolMessage({
      tool_call_id: 'call-unknown',
      content: JSON.stringify(evidenceResult()),
    });

    assert.throws(
      () =>
        withSession(() =>
          providerMessages([question, geminiToolCall(), orphan]),
        ),
      rejectsWith('PRIVACY_TOOL_UNPAIRED'),
    );
  });

  test('still rejects an unsupported message role', () => {
    const other = new ChatMessage({ content: 'x', role: 'critic' });

    assert.throws(
      () => withSession(() => providerMessages([question, other])),
      rejectsWith('PRIVACY_ROLE_UNSUPPORTED'),
    );
  });

  test('drops tool payloads whose evidence was not registered this turn', () => {
    const output = withSession(() => {
      const tool = new ToolMessage({
        tool_call_id: 'call-1',
        content: JSON.stringify(evidenceResult()),
      });
      return providerMessages([question, geminiToolCall(), tool]);
    });

    assert.deepEqual(JSON.parse(String(output[3].content)), {
      status: 'empty',
      evidence: [],
      warnings: [],
    });
  });

  test('rejects a tool message with non-string content', () => {
    assert.throws(
      () =>
        withSession(() => {
          publicToolResult(evidenceResult(), true);
          const tool = new ToolMessage({
            tool_call_id: 'call-1',
            content: [{ type: 'text', text: JSON.stringify(evidenceResult()) }],
          });
          return providerMessages([question, geminiToolCall(), tool]);
        }),
      { code: 'PRIVACY_CONTENT_UNSUPPORTED' },
    );
  });

  test('keeps string-content answers and pseudonymizes them', () => {
    const answer = new AIMessage('Liên hệ a.b@hust.edu.vn để được hỗ trợ.');
    const { output, token } = withSession((privacy) => {
      const token = privacy.pseudonymize('a.b@hust.edu.vn');
      return { output: providerMessages([question, answer]), token };
    });

    assert.match(token, /^\[\[PII_EMAIL_[a-f0-9]{32}\]\]$/u);
    assert.equal(output.length, 3);
    assert.equal(output[2].content, `Liên hệ ${token} để được hỗ trợ.`);
  });

  test('hides PII first seen after the session is sealed', () => {
    const answer = new AIMessage('Liên hệ a.b@hust.edu.vn để được hỗ trợ.');
    const output: BaseMessage[] = withSession(() =>
      providerMessages([question, answer]),
    );

    assert.equal(
      output[2].content,
      'Liên hệ [thông tin đã ẩn] để được hỗ trợ.',
    );
  });
});
