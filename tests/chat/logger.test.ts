import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { AIMessage } from '@langchain/core/messages';
import { createLogger, logger, withTrace, type LogFields } from '../../src/observability/logger.js';
import { requestTrace } from '../../src/observability/http.js';
import { createChatRouter } from '../../src/chat/routes.js';
import { ChatService } from '../../src/chat/service.js';
import { MemoryStore } from './memory-store.js';
import { createChatAgent } from '../../src/agent/graph.js';
import { readChatConfig } from '../../src/agent/config.js';
import { StubKnowledge } from '../../src/knowledge/stub.js';

test('logger only serializes allowlisted operational metadata, never arbitrary payloads', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  const secret = 'mongodb+srv://private:password@host/private?api_key=private';
  log.info('test.metadata', {
    requestId: randomUUID(),
    traceId: secret,
    tool: secret,
    status: secret,
    route: secret,
    errorCode: secret,
    durationMs: 12.4,
    tokens: Number.NaN,
    body: { message: secret },
    authorization: secret,
    error: new Error(secret),
  } as LogFields);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(secret));
  const record = JSON.parse(lines[0]);
  assert.equal(record.tool, 'unknown');
  assert.equal(record.durationMs, 12);
  for (const key of [
    'traceId',
    'status',
    'route',
    'errorCode',
    'tokens',
    'body',
    'authorization',
    'error',
  ])
    assert.equal(record[key], undefined);
});

test('async trace scopes stay isolated across interleaved turns', async () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'info', write: (line) => lines.push(line) });
  const first = randomUUID();
  const second = randomUUID();
  await Promise.all([
    withTrace({ requestId: first }, async () => {
      await Promise.resolve();
      log.info('test.first');
    }),
    withTrace({ requestId: second }, async () => {
      await Promise.resolve();
      log.info('test.second');
    }),
  ]);
  log.info('test.outside');
  const records = lines.map((line) => JSON.parse(line));
  assert.equal(records.find((record) => record.event === 'test.first').requestId, first);
  assert.equal(records.find((record) => record.event === 'test.second').requestId, second);
  assert.equal(records.find((record) => record.event === 'test.outside').requestId, undefined);
});

test('levels filter logs and unavailable log sinks never fail the request', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'warn', write: (line) => lines.push(line) });
  log.debug('test.debug');
  log.info('test.info');
  log.warn('test.warn');
  log.error('test.error');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).level),
    ['warn', 'error'],
  );
  createLogger({ level: 'silent', write: () => assert.fail('silent must not write') }).error(
    'test.silent',
  );
  assert.doesNotThrow(() =>
    createLogger({
      level: 'info',
      write: () => {
        throw new Error('broken sink');
      },
    }).info('test.sink'),
  );
});

test('HTTP trace follows model/tools/persistence and replay without leaking chat or provider errors', async (t) => {
  const lines: string[] = [];
  const sink = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  for (const level of ['debug', 'info', 'warn', 'error'] as const)
    t.mock.method(logger, level, sink[level]);
  const secret = 'private-canary-mongodb+srv://user:password@host/db';
  let calls = 0;
  const agent = createChatAgent(
    {
      async invoke() {
        calls++;
        if (calls > 2) throw new Error(secret);
        return new AIMessage({
          content: secret,
          tool_calls:
            calls === 1
              ? [{ id: 'search', name: 'search_knowledge', args: { query: secret } }]
              : [
                  {
                    id: 'final',
                    name: 'submit_answer',
                    args: {
                      status: 'answered',
                      claims: [{ text: secret, evidenceIds: ['fake'] }],
                      missingFields: [],
                    },
                  },
                ],
        });
      },
    },
    new StubKnowledge(),
    readChatConfig({}),
  );
  const service = new ChatService(new MemoryStore(), agent);
  const app = express();
  app.use(requestTrace);
  app.use(express.json());
  app.use(
    '/chat',
    createChatRouter(async () => service),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat`;
  const created = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const session = (await created.json()) as { conversationId: string; token: string };
  const url = `${base}/conversations/${session.conversationId}/messages?private=${encodeURIComponent(secret)}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.token}`,
    'X-Trace-Id': secret,
  };
  const requestId = randomUUID();
  const body = JSON.stringify({
    requestId,
    message: 'Em muốn hỏi học bổng, email abc.private@example.com',
  });
  const response = await fetch(url, { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  const result = (await response.json()) as { runId: string };
  const traceId = response.headers.get('x-trace-id');
  assert.match(traceId!, /^[0-9a-f-]{36}$/u);
  const records = () => lines.map((line) => JSON.parse(line));
  const trace = records().filter((record) => record.traceId === traceId);
  for (const event of [
    'agent.model.started',
    'agent.tool.completed',
    'guardrail.draft.validated',
    'chat.turn.completed',
  ]) {
    const record = trace.find((record) => record.event === event);
    assert.ok(record, event);
    assert.equal(record.requestId, requestId);
    assert.equal(record.runId, result.runId);
    assert.equal(record.conversationId, session.conversationId);
  }
  assert.equal(trace.filter((record) => record.event === 'http.request.started').length, 1);
  assert.equal(trace.filter((record) => record.event === 'http.request.completed').length, 1);
  const replay = await fetch(url, { method: 'POST', headers, body });
  assert.equal(replay.status, 200);
  const replayBody = (await replay.json()) as { runId: string; replayed: boolean };
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.runId, result.runId);
  assert.notEqual(replay.headers.get('x-trace-id'), traceId);
  const replayTrace = records().filter(
    (record) => record.traceId === replay.headers.get('x-trace-id'),
  );
  assert.ok(replayTrace.some((record) => record.event === 'chat.turn.replayed'));
  assert.ok(!replayTrace.some((record) => record.event === 'agent.model.started'));
  const failed = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ requestId: randomUUID(), message: 'Thủ tục học bổng khác?' }),
  });
  assert.equal(failed.status, 503);
  await failed.text();
  assert.ok(records().some((record) => record.event === 'agent.model.failed'));
  assert.ok(records().some((record) => record.event === 'chat.turn.failed'));
  for (const sensitive of [
    secret,
    session.token,
    'abc.private@example.com',
    'Em muốn hỏi học bổng',
  ])
    assert.ok(!lines.join('').includes(sensitive), 'sensitive data must not reach logs');
});
