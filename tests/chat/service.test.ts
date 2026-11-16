import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ChatError, reply } from '../../src/chat/contracts.js';
import { ChatService } from '../../src/chat/service.js';
import { MemoryStore } from './memory-store.js';

const body = (message = 'Học bổng?', context = {}) => ({
  requestId: randomUUID(),
  message,
  context,
});
const runner = async () => reply('insufficient_evidence', 'Chưa có dữ liệu', 'KB-03');

test('conversation capability is hashed and another token cannot read or call the model', async () => {
  let calls = 0;
  const store = new MemoryStore();
  const service = new ChatService(store, async () => {
    calls++;
    return runner();
  });
  const session = await service.create();
  assert.notEqual(store.conversations.get(session.conversationId)!.tokenHash, session.token);
  await assert.rejects(
    service.history(session.conversationId, 'wrong', 20, 0),
    (error) => error instanceof ChatError && error.status === 404,
  );
  await assert.rejects(
    service.message(session.conversationId, 'wrong', body()),
    (error) => error instanceof ChatError && error.status === 404,
  );
  assert.equal(calls, 0);
});

test('duplicate requestId replays once and rejects different content without another model call', async () => {
  let calls = 0;
  const service = new ChatService(new MemoryStore(), async () => {
    calls++;
    return runner();
  });
  const session = await service.create();
  const request = body();
  const first = await service.message(session.conversationId, session.token, request);
  const again = await service.message(session.conversationId, session.token, request);
  assert.equal(first.runId, again.runId);
  assert.equal(again.replayed, true);
  await assert.rejects(
    service.message(session.conversationId, session.token, { ...request, message: 'Thư viện?' }),
    /nội dung khác/u,
  );
  assert.equal(calls, 1);
});

test('history is redacted, context is updated and secret-bearing turns do not enter model memory', async () => {
  const inputs: {
    message: string;
    context: { cohort?: string };
    history: { user: string; answer: string }[];
  }[] = [];
  const store = new MemoryStore();
  const service = new ChatService(store, async (input) => {
    inputs.push(input);
    return runner();
  });
  const s = await service.create();
  await service.message(
    s.conversationId,
    s.token,
    body('MSSV 20201234, hỏi học bổng', { cohort: 'K69' }),
  );
  await service.message(s.conversationId, s.token, body('OTP là 123456'));
  await service.message(
    s.conversationId,
    s.token,
    body('Còn chương trình khác?', { cohort: 'K70' }),
  );
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].context.cohort, 'K70');
  assert.equal(inputs[1].history.length, 1);
  const history = JSON.stringify(await service.history(s.conversationId, s.token, 20, 0));
  assert.ok(!history.includes('123456') && !history.includes('20201234'));
  assert.ok(!JSON.stringify(inputs).includes('OTP'));
});

test('concurrent turns and deletion cannot bypass the conversation lease', async () => {
  let unblock!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const service = new ChatService(new MemoryStore(), async () => {
    entered();
    await gate;
    return runner();
  });
  const s = await service.create();
  const first = service.message(s.conversationId, s.token, body());
  await started;
  try {
    await assert.rejects(service.message(s.conversationId, s.token, body()), /đang xử lý/u);
    await assert.rejects(service.remove(s.conversationId, s.token), /đang xử lý/u);
  } finally {
    unblock();
    await first;
  }
  await service.remove(s.conversationId, s.token);
  await assert.rejects(service.history(s.conversationId, s.token, 20, 0), /Không tìm thấy/u);
});

test('an uncooperative model is timed out, marked failed and cannot persist a late answer', async () => {
  let finish!: (value: Awaited<ReturnType<typeof runner>>) => void;
  const store = new MemoryStore();
  const service = new ChatService(
    store,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    30,
  );
  const s = await service.create();
  const request = body();
  await assert.rejects(
    service.message(s.conversationId, s.token, request),
    (error) => error instanceof ChatError && error.status === 504,
  );
  finish(await runner());
  await new Promise((resolve) => setImmediate(resolve));
  const record = await service.request(s.conversationId, s.token, request.requestId);
  assert.equal(record.status, 'failed');
  assert.equal(record.result, null);
  assert.equal(store.conversations.get(s.conversationId)!.lease, undefined);
});

test('provider/storage error details and secrets are never exposed or retained', async () => {
  const service = new ChatService(new MemoryStore(), async () => {
    throw new Error('API secret=do-not-expose');
  });
  const s = await service.create();
  await assert.rejects(
    service.message(s.conversationId, s.token, body()),
    (error) => error instanceof ChatError && !error.message.includes('do-not-expose'),
  );
  assert.ok(
    !JSON.stringify(await service.history(s.conversationId, s.token, 20, 0)).includes(
      'do-not-expose',
    ),
  );
});

test('expired sessions are denied even before background TTL deletion', async () => {
  const store = new MemoryStore();
  const service = new ChatService(store, runner);
  const s = await service.create();
  store.conversations.get(s.conversationId)!.expiresAt = new Date(0);
  await assert.rejects(service.message(s.conversationId, s.token, body()), /Không tìm thấy/u);
});
