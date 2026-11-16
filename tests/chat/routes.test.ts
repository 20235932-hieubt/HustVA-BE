import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { reply } from '../../src/chat/contracts.js';
import { createChatRouter } from '../../src/chat/routes.js';
import { ChatService } from '../../src/chat/service.js';
import { MemoryStore } from './memory-store.js';

test('HTTP chat contract creates a capability, rejects injection, replays and deletes', async (t) => {
  const app = express();
  app.use(express.json());
  const service = new ChatService(new MemoryStore(), async () =>
    reply('insufficient_evidence', 'Chưa có nguồn', 'KB-03'),
  );
  app.use(
    '/chat',
    createChatRouter(async () => service),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat`;
  const created = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(created.status, 201);
  const session = (await created.json()) as { conversationId: string; token: string };
  const url = `${base}/conversations/${session.conversationId}/messages`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
  assert.equal((await fetch(url)).status, 401);
  const invalid = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ requestId: randomUUID(), message: 'Chào', role: 'system' }),
  });
  assert.equal(invalid.status, 400);
  const body = { requestId: randomUUID(), message: 'Xin chào' };
  const first = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(first.status, 200);
  const result = (await first.json()) as { status: string; retrievalMode: string };
  assert.equal(result.status, 'answered');
  assert.equal(result.retrievalMode, 'stub');
  const again = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(((await again.json()) as { replayed: boolean }).replayed, true);
  const history = await fetch(url, { headers });
  const historyText = await history.text();
  assert.ok(!historyText.includes(session.token) && !historyText.includes('fingerprint'));
  assert.equal((await fetch(`${url}?limit=abc`, { headers })).status, 400);
  assert.equal(
    (await fetch(url, { headers: { ...headers, Origin: 'https://attacker.invalid' } })).status,
    403,
  );
  assert.equal(
    (await fetch(`${base}/conversations/${session.conversationId}`, { method: 'DELETE', headers }))
      .status,
    204,
  );
  assert.equal((await fetch(url, { headers })).status, 404);
});

test('request-wide deadline also covers a stalled MongoDB/runtime initializer', async (t) => {
  const previous = process.env.CHAT_TIMEOUT_MS;
  process.env.CHAT_TIMEOUT_MS = '30';
  t.after(() => {
    if (previous === undefined) delete process.env.CHAT_TIMEOUT_MS;
    else process.env.CHAT_TIMEOUT_MS = previous;
  });
  const app = express();
  app.use(express.json());
  app.use(
    '/chat',
    createChatRouter(() => new Promise(() => undefined)),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/conversations/${randomUUID()}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'a'.repeat(43)}` },
      body: JSON.stringify({ requestId: randomUUID(), message: 'Xin chào' }),
      signal: AbortSignal.timeout(2000),
    },
  );
  assert.equal(response.status, 504);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'CHAT_TIMEOUT');
});

test('per-session rate limit includes replay requests and returns Retry-After', async (t) => {
  const app = express();
  app.use(express.json());
  const service = new ChatService(new MemoryStore(), async () =>
    reply('insufficient_evidence', 'Chưa có nguồn', 'KB-03'),
  );
  const session = await service.create();
  app.use(
    '/chat',
    createChatRouter(async () => service),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/conversations/${session.conversationId}/messages`;
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ requestId: randomUUID(), message: 'Xin chào' }),
  };
  for (let i = 0; i < 10; i++) {
    const response = await fetch(url, options);
    assert.equal(response.status, 200);
    await response.text();
  }
  const response = await fetch(url, options);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
});
