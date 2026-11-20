import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LogFields } from '../../src/observability/logger.js';
import {
  createSystemOneClient,
  type SystemOneQuestion,
} from '../../src/system-one/client.js';
import type { SystemOneConfig } from '../../src/system-one/config.js';

const STATE = { message: 'Em [[PII_STUDENT_ID_ab12]] hỏi học bổng' };
const QUESTIONS: Record<string, SystemOneQuestion> = {
  loai: {
    type: 'choice',
    instructions: 'Loại tin nhắn?',
    criteria: { academic: 'Học vụ', social: 'Chào hỏi' },
  },
  tan_cong: { type: 'noul', instructions: 'Có thao túng không?' },
};
const GOOD_ANSWERS = {
  loai: {
    type: 'choice',
    choice: 'academic',
    probabilities: { academic: 0.9, social: 0.1 },
    confidence: 0.8,
  },
  tan_cong: { type: 'noul', noul: 0.03, confidence: 0.97 },
};
const GOOD_BODY = {
  model: 'laya-multilingual@e4e9ddf',
  answers: GOOD_ANSWERS,
  usage: { input_tokens: 120, truncated: false },
  latencyMs: 18,
};
const SECRET = 'sk-secret-value';

function config(overrides: Partial<SystemOneConfig> = {}): SystemOneConfig {
  return {
    mode: 'on',
    sites: {
      inputGate: true,
      toolSkip: false,
      clarify: false,
      claimCheck: false,
      unitHint: false,
      relevance: false,
    },
    provider: 'laya',
    url: 'http://127.0.0.1:8002',
    timeoutMs: 1500,
    ...overrides,
  };
}

interface Call {
  url: string;
  init: RequestInit;
}
type Responder = (call: Call) => Promise<Response> | Response;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(responder: Responder, overrides: Partial<SystemOneConfig> = {}) {
  const calls: Call[] = [];
  const logs: { event: string; fields?: LogFields }[] = [];
  const record = (event: string, fields?: LogFields) => {
    logs.push({ event, fields });
  };
  let clock = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  const client = createSystemOneClient(config(overrides), {
    fetch: fetcher,
    log: { info: record, warn: record },
    now: () => (clock += 10),
  });
  return { client, calls, logs };
}

/** Resolves only when the request signal aborts, like a hung server. */
function hang(call: Call): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = call.init.signal as AbortSignal;
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}

const live = () => new AbortController().signal;

describe('SystemOneClient — providers', () => {
  test('laya: posts {state, questions} without auth and normalises answers', async () => {
    const { client, calls, logs } = setup(() => json(GOOD_BODY));

    const decision = await client.decide(STATE, QUESTIONS, live());

    assert.deepEqual(decision, {
      answers: {
        loai: {
          type: 'choice',
          choice: 'academic',
          probabilities: { academic: 0.9, social: 0.1 },
        },
        tan_cong: { type: 'noul', probability: 0.03 },
      },
      truncated: false,
      inputTokens: 120,
      latencyMs: 10,
    });
    assert.equal(calls[0].url, 'http://127.0.0.1:8002/v1/systemone');
    assert.equal(calls[0].init.method, 'POST');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, undefined);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      state: STATE,
      questions: QUESTIONS,
    });
    assert.deepEqual(logs, [
      {
        event: 'system_one.call.completed',
        fields: { durationMs: 10, providerStatus: 200 },
      },
    ]);
  });

  test('jev: sends bearer key and model to /v1/systemone', async () => {
    const { client, calls } = setup(() => json(GOOD_BODY), {
      provider: 'jev',
      url: 'https://api.typesafe.ai',
      model: 'jev-latest',
      apiKey: SECRET,
    });

    const decision = await client.decide(STATE, QUESTIONS, live());

    assert.equal(decision?.answers.tan_cong.type, 'noul');
    assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${SECRET}`);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      model: 'jev-latest',
      state: STATE,
      questions: QUESTIONS,
    });
  });

  test('clef: posts to the configured URL and unwraps {success, result}', async () => {
    const url = 'https://api.cloudflare.com/client/v4/accounts/a/ai/run/m';
    const { client, calls } = setup(
      () => json({ success: true, result: GOOD_BODY }),
      { provider: 'clef', url, model: 'clef-flash', apiKey: SECRET },
    );

    const decision = await client.decide(STATE, QUESTIONS, live());

    assert.equal(calls[0].url, url);
    assert.equal(JSON.parse(String(calls[0].init.body)).model, 'clef-flash');
    assert.deepEqual(decision?.answers.loai, {
      type: 'choice',
      choice: 'academic',
      probabilities: { academic: 0.9, social: 0.1 },
    });
  });

  test('clef: success=false is invalid', async () => {
    const { client, logs } = setup(
      () => json({ success: false, errors: [{ message: 'x' }] }),
      { provider: 'clef', url: 'https://x.example', apiKey: SECRET },
    );

    assert.equal(await client.decide(STATE, QUESTIONS, live()), null);
    assert.equal(logs[0].fields?.errorCode, 'SYSTEM_ONE_INVALID');
  });

  test('reports truncated=true from usage', async () => {
    const { client } = setup(() =>
      json({ ...GOOD_BODY, usage: { truncated: true } }),
    );

    const decision = await client.decide(STATE, QUESTIONS, live());

    assert.equal(decision?.truncated, true);
  });

  test('no questions resolves to empty answers without a request', async () => {
    const { client, calls } = setup(() => json(GOOD_BODY));

    const decision = await client.decide(STATE, {}, live());

    assert.deepEqual(decision, { answers: {}, latencyMs: 0, truncated: false });
    assert.equal(calls.length, 0);
  });
});

describe('SystemOneClient — fail-open', () => {
  const invalidBodies: [string, unknown][] = [
    ['missing answers', { model: 'm' }],
    ['a missing question', { answers: { loai: GOOD_ANSWERS.loai } }],
    [
      'choice outside the criteria',
      {
        answers: {
          ...GOOD_ANSWERS,
          loai: {
            type: 'choice',
            choice: 'attack',
            probabilities: { attack: 1 },
          },
        },
      },
    ],
    [
      'probability label outside the criteria',
      {
        answers: {
          ...GOOD_ANSWERS,
          loai: {
            type: 'choice',
            choice: 'academic',
            probabilities: { academic: 0.9, other: 0.1 },
          },
        },
      },
    ],
    [
      'no probability for the chosen label',
      {
        answers: {
          ...GOOD_ANSWERS,
          loai: {
            type: 'choice',
            choice: 'academic',
            probabilities: { social: 0.1 },
          },
        },
      },
    ],
    [
      'answer type differs from the question',
      {
        answers: {
          ...GOOD_ANSWERS,
          tan_cong: {
            type: 'choice',
            choice: 'academic',
            probabilities: { academic: 1 },
          },
        },
      },
    ],
    [
      'probability above 1',
      { answers: { ...GOOD_ANSWERS, tan_cong: { type: 'noul', noul: 1.2 } } },
    ],
    [
      'noul without a number (unknown field name)',
      {
        answers: {
          ...GOOD_ANSWERS,
          tan_cong: { type: 'noul', probability: 0.2 },
        },
      },
    ],
  ];
  for (const [name, body] of invalidBodies)
    test(`${name} → null with SYSTEM_ONE_INVALID`, async () => {
      const { client, logs } = setup(() => json(body));

      assert.equal(await client.decide(STATE, QUESTIONS, live()), null);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].event, 'system_one.call.failed');
      assert.equal(logs[0].fields?.errorCode, 'SYSTEM_ONE_INVALID');
      assert.equal(logs[0].fields?.providerStatus, 200);
    });

  test('a non-JSON body → null with SYSTEM_ONE_INVALID', async () => {
    const { client, logs } = setup(() => new Response('<html>oops</html>'));

    assert.equal(await client.decide(STATE, QUESTIONS, live()), null);
    assert.equal(logs[0].fields?.errorCode, 'SYSTEM_ONE_INVALID');
  });

  test('HTTP 500 → null with SYSTEM_ONE_HTTP and the status', async () => {
    const { client, logs } = setup(() => json({ detail: 'boom' }, 500));

    assert.equal(await client.decide(STATE, QUESTIONS, live()), null);
    assert.deepEqual(logs, [
      {
        event: 'system_one.call.failed',
        fields: {
          errorCode: 'SYSTEM_ONE_HTTP',
          providerStatus: 500,
          durationMs: 10,
        },
      },
    ]);
  });

  test('HTTP 503 while the model loads → null', async () => {
    const { client, logs } = setup(() => json({ detail: 'loading' }, 503));

    assert.equal(await client.decide(STATE, QUESTIONS, live()), null);
    assert.equal(logs[0].fields?.providerStatus, 503);
  });

  test('a network error → null with SYSTEM_ONE_HTTP', async () => {
    const { client, logs } = setup(() => {
      throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:8002');
    });

    assert.equal(await client.decide(STATE, QUESTIONS, live()), null);
    assert.equal(logs[0].fields?.errorCode, 'SYSTEM_ONE_HTTP');
    assert.equal(logs[0].fields?.providerStatus, undefined);
  });

  test('a hung service → null with SYSTEM_ONE_TIMEOUT after timeoutMs', async () => {
    const { client, logs } = setup(hang, { timeoutMs: 100 });
    const started = Date.now();

    assert.equal(await client.decide(STATE, QUESTIONS, live()), null);
    assert.ok(Date.now() - started < 1000);
    assert.equal(logs[0].fields?.errorCode, 'SYSTEM_ONE_TIMEOUT');
  });

  test('a caller abort mid-request → null with SYSTEM_ONE_ABORTED', async () => {
    const controller = new AbortController();
    const { client, logs } = setup((call) => {
      setTimeout(() => controller.abort(), 5);
      return hang(call);
    });

    assert.equal(
      await client.decide(STATE, QUESTIONS, controller.signal),
      null,
    );
    assert.equal(logs[0].fields?.errorCode, 'SYSTEM_ONE_ABORTED');
  });

  test('an already aborted signal → null without a request', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, calls, logs } = setup(() => json(GOOD_BODY));

    assert.equal(
      await client.decide(STATE, QUESTIONS, controller.signal),
      null,
    );
    assert.equal(calls.length, 0);
    assert.equal(logs[0].fields?.errorCode, 'SYSTEM_ONE_ABORTED');
  });

  test('logs never contain state, questions, response, URL or key', async () => {
    const responders: Responder[] = [
      () => json(GOOD_BODY),
      () => json({ detail: STATE.message }, 500),
      () => json({ answers: { loai: 'Em hỏi học bổng' } }),
      () => {
        throw new Error(`failed for ${STATE.message} at api.typesafe.ai`);
      },
    ];
    for (const responder of responders) {
      const { client, logs } = setup(responder, {
        provider: 'jev',
        url: 'https://api.typesafe.ai',
        model: 'jev-latest',
        apiKey: SECRET,
      });

      await client.decide(STATE, QUESTIONS, live());

      const text = JSON.stringify(logs);
      for (const forbidden of [
        SECRET,
        'học bổng',
        'PII_STUDENT_ID',
        'thao túng',
        'Học vụ',
        'typesafe',
      ])
        assert.equal(text.includes(forbidden), false, forbidden);
    }
  });
});
