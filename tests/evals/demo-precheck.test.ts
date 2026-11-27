import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  checkLine,
  networkChecks,
  staticChecks,
} from '../../evals/demo/precheck.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const GEMINI_KEY = 'gemini-secret-key';
const CLEF_TOKEN = 'clef-secret-token';
const ENV: NodeJS.ProcessEnv = {
  GEMINI_API_KEY: GEMINI_KEY,
  GEMINI_MODEL: 'gemini-test',
  CHAT_MAX_TURN_TOKENS: '24000',
  SYSTEM_ONE_PROVIDER: 'clef',
  SYSTEM_ONE_CLEF_ACCOUNT_ID: ACCOUNT,
  SYSTEM_ONE_CLEF_API_TOKEN: CLEF_TOKEN,
};

const failed = (env: NodeJS.ProcessEnv) =>
  staticChecks(env)
    .filter((check) => !check.ok)
    .map((check) => check.name);

describe('staticChecks', () => {
  test('a complete .env passes every check', () => {
    assert.deepEqual(failed(ENV), []);
  });

  test('missing key, model, Clef settings or a low token budget fail', () => {
    assert.deepEqual(failed({ ...ENV, GEMINI_API_KEY: ' ' }), [
      'GEMINI_API_KEY',
    ]);
    assert.deepEqual(failed({ ...ENV, GEMINI_MODEL: undefined }), [
      'GEMINI_MODEL',
    ]);
    assert.deepEqual(failed({ ...ENV, CHAT_MAX_TURN_TOKENS: '12000' }), [
      'CHAT_MAX_TURN_TOKENS ≥ 24000',
    ]);
    assert.deepEqual(failed({ ...ENV, SYSTEM_ONE_PROVIDER: 'laya' }), [
      'SYSTEM_ONE_PROVIDER=clef',
    ]);
    assert.deepEqual(failed({ ...ENV, SYSTEM_ONE_CLEF_API_TOKEN: '' }), [
      'SYSTEM_ONE_CLEF_*',
    ]);
  });

  test('unset token budget uses the code default 24 000', () => {
    const check = staticChecks({ ...ENV, CHAT_MAX_TURN_TOKENS: undefined })[2];
    assert.equal(check.ok, true);
    assert.match(check.detail, /24000 \(mặc định code\)/u);
  });

  test('output never contains secret values', () => {
    const text = staticChecks(ENV).map(checkLine).join('\n');
    assert.doesNotMatch(text, new RegExp(`${GEMINI_KEY}|${CLEF_TOKEN}`));
    assert.doesNotMatch(text, new RegExp(ACCOUNT));
  });
});

describe('networkChecks', () => {
  function fakeFetch(statuses: Record<string, number | Error>) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = (async (input: string | URL | Request, init) => {
      const url = String(input);
      calls.push({ url, init });
      const key = Object.keys(statuses).find((part) => url.includes(part));
      const value = key ? statuses[key] : 404;
      if (value instanceof Error) throw value;
      return new Response('{}', { status: value });
    }) as typeof fetch;
    return { fetcher, calls };
  }

  test('prints HTTP codes; 2xx ok, 5xx warns, 4xx stops', async () => {
    const { fetcher, calls } = fakeFetch({
      '/info': 200,
      generativelanguage: 503,
      cloudflare: 401,
    });
    const checks = await networkChecks(ENV, fetcher);
    assert.deepEqual(
      checks.map((check) => [check.ok, check.fatal, check.detail]),
      [
        [true, false, 'HTTP 200'],
        [false, false, 'HTTP 503'],
        [false, true, 'HTTP 401'],
      ],
    );
    assert.equal(calls[0].url, 'http://127.0.0.1:8001/info');
    assert.match(calls[1].url, /models\/gemini-test:generateContent$/u);
    assert.match(String(calls[1].init?.body), /"ping"/u);
    assert.match(String(calls[2].init?.body), /"clef-flash"/u);
    const text = checks.map(checkLine).join('\n');
    assert.doesNotMatch(text, new RegExp(`${GEMINI_KEY}|${CLEF_TOKEN}`));
    assert.doesNotMatch(text, new RegExp(ACCOUNT));
  });

  test('embedding down or network error stops, without the message', async () => {
    const { fetcher } = fakeFetch({
      '/info': new TypeError(`fetch failed ${ACCOUNT}`),
      generativelanguage: 200,
      cloudflare: 200,
    });
    const checks = await networkChecks(
      { ...ENV, EMBEDDING_SERVICE_URL: 'http://127.0.0.1:9/' },
      fetcher,
    );
    assert.equal(checks[0].name, 'embedding http://127.0.0.1:9');
    assert.equal(checks[0].fatal, true);
    assert.equal(checks[0].detail, 'TypeError');
    assert.equal(checks[1].ok, true);
    assert.equal(checks[2].ok, true);
  });
});
