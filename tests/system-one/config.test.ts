import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LogFields } from '../../src/observability/logger.js';
import {
  hasActiveSite,
  isSiteActive,
  readSystemOneConfig,
} from '../../src/system-one/config.js';

const ALL_SITES_ON = {
  SYSTEM_ONE_INPUT_GATE: 'true',
  SYSTEM_ONE_TOOL_SKIP: 'true',
  SYSTEM_ONE_CLARIFY: 'true',
  SYSTEM_ONE_CLAIM_CHECK: 'true',
  SYSTEM_ONE_UNIT_HINT: 'true',
  SYSTEM_ONE_RELEVANCE: 'true',
};

function capture() {
  const events: { event: string; fields?: LogFields }[] = [];
  return {
    events,
    log: {
      warn: (event: string, fields?: LogFields) => {
        events.push({ event, fields });
      },
    },
  };
}

function read(env: NodeJS.ProcessEnv) {
  const { events, log } = capture();
  return { config: readSystemOneConfig(env, log), events };
}

describe('readSystemOneConfig', () => {
  test('is off with every site disabled when nothing is set', () => {
    const { config, events } = read({});

    assert.equal(config.mode, 'off');
    assert.equal(hasActiveSite(config), false);
    assert.deepEqual(Object.values(config.sites), [
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    assert.equal(events.length, 0);
  });

  test('MODE=off ignores site flags and every other value', () => {
    const { config, events } = read({
      SYSTEM_ONE_MODE: 'off',
      ...ALL_SITES_ON,
      SYSTEM_ONE_PROVIDER: 'not-a-provider',
      SYSTEM_ONE_TIMEOUT_MS: 'abc',
    });

    assert.equal(config.mode, 'off');
    assert.equal(hasActiveSite(config), false);
    assert.equal(isSiteActive(config, 'inputGate'), false);
    assert.equal(events.length, 0);
  });

  test('reads laya defaults in shadow mode and enables only flags equal to "true"', () => {
    const { config } = read({
      SYSTEM_ONE_MODE: 'shadow',
      SYSTEM_ONE_INPUT_GATE: 'true',
      SYSTEM_ONE_TOOL_SKIP: 'TRUE',
      SYSTEM_ONE_CLARIFY: '1',
      SYSTEM_ONE_CLAIM_CHECK: ' true ',
    });

    assert.equal(config.mode, 'shadow');
    assert.equal(config.provider, 'laya');
    assert.equal(config.url, 'http://127.0.0.1:8002');
    assert.equal(config.timeoutMs, 1500);
    assert.equal(config.apiKey, undefined);
    assert.equal(isSiteActive(config, 'inputGate'), true);
    assert.equal(isSiteActive(config, 'toolSkip'), false);
    assert.equal(isSiteActive(config, 'clarify'), false);
    assert.equal(isSiteActive(config, 'claimCheck'), true);
    assert.equal(hasActiveSite(config), true);
  });

  test('on mode without any site flag has no active site', () => {
    const { config } = read({ SYSTEM_ONE_MODE: 'on' });

    assert.equal(config.mode, 'on');
    assert.equal(hasActiveSite(config), false);
  });

  test('strips trailing slashes and accepts a custom timeout', () => {
    const { config } = read({
      SYSTEM_ONE_MODE: 'on',
      SYSTEM_ONE_URL: 'http://localhost:9000//',
      SYSTEM_ONE_TIMEOUT_MS: '800',
    });

    assert.equal(config.url, 'http://localhost:9000');
    assert.equal(config.timeoutMs, 800);
  });

  test('jev defaults to the TypeSafe URL and jev-latest with a key', () => {
    const { config } = read({
      SYSTEM_ONE_MODE: 'on',
      SYSTEM_ONE_PROVIDER: 'jev',
      SYSTEM_ONE_API_KEY: 'k',
    });

    assert.equal(config.provider, 'jev');
    assert.equal(config.url, 'https://api.typesafe.ai');
    assert.equal(config.model, 'jev-latest');
    assert.equal(config.apiKey, 'k');
  });

  test('clef needs an explicit https URL and defaults to clef-flash', () => {
    const { config } = read({
      SYSTEM_ONE_MODE: 'on',
      SYSTEM_ONE_PROVIDER: 'clef',
      SYSTEM_ONE_API_KEY: 'k',
      SYSTEM_ONE_URL: 'https://api.cloudflare.com/client/v4/x',
    });

    assert.equal(config.provider, 'clef');
    assert.equal(config.model, 'clef-flash');
  });

  const invalid: [string, NodeJS.ProcessEnv][] = [
    ['unknown mode', { SYSTEM_ONE_MODE: 'yes' }],
    ['unknown provider', { SYSTEM_ONE_PROVIDER: 'gpt' }],
    ['timeout below 100', { SYSTEM_ONE_TIMEOUT_MS: '50' }],
    ['timeout above 5000', { SYSTEM_ONE_TIMEOUT_MS: '9000' }],
    ['non-integer timeout', { SYSTEM_ONE_TIMEOUT_MS: '1.5' }],
    ['malformed URL', { SYSTEM_ONE_URL: 'not a url' }],
    ['non-http URL', { SYSTEM_ONE_URL: 'file:///etc/passwd' }],
    ['jev without key', { SYSTEM_ONE_PROVIDER: 'jev' }],
    [
      'jev over plain http',
      {
        SYSTEM_ONE_PROVIDER: 'jev',
        SYSTEM_ONE_API_KEY: 'k',
        SYSTEM_ONE_URL: 'http://api.typesafe.ai',
      },
    ],
    [
      'clef without URL',
      { SYSTEM_ONE_PROVIDER: 'clef', SYSTEM_ONE_API_KEY: 'k' },
    ],
  ];
  for (const [name, env] of invalid)
    test(`${name} turns everything off, logs only a code and does not throw`, () => {
      const { config, events } = read({
        SYSTEM_ONE_MODE: 'on',
        ...ALL_SITES_ON,
        ...env,
      });

      assert.equal(config.mode, 'off');
      assert.equal(hasActiveSite(config), false);
      assert.deepEqual(events, [
        {
          event: 'system_one.config.invalid',
          fields: { errorCode: 'SYSTEM_ONE_CONFIG_INVALID' },
        },
      ]);
    });

  test('the invalid-config log never carries the API key', () => {
    const { events } = read({
      SYSTEM_ONE_MODE: 'on',
      SYSTEM_ONE_PROVIDER: 'jev',
      SYSTEM_ONE_API_KEY: 'secret-key-123',
      SYSTEM_ONE_URL: 'http://plain.example',
    });

    assert.equal(events.length, 1);
    assert.equal(JSON.stringify(events).includes('secret-key-123'), false);
  });
});
