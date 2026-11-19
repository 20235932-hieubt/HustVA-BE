import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { ToolManager } from '../dist/tools/manager.js';
import { toolCatalog } from '../dist/tools/catalog.js';
import { readToolConfig } from '../dist/tools/config.js';
import { createToolsRouter } from '../dist/tools/routes.js';

const json = (data) => Response.json(data);
async function fixture(
  t,
  fetcher = async () => json({ status: 200, data: [] }),
  extra = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hustva-tools-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = {
    partnerUrl: 'https://partner.invalid/base',
    partnerToken: 'test-query-token',
    partnerAuthorization: 'test-header-token',
    managementToken: 'test-management-token-32-characters-long',
    dataDir,
    ...extra,
  };
  return { config, manager: new ToolManager(config, fetcher) };
}

test('phase-one catalog contains exactly five shared Partner tools', async (t) => {
  const { manager } = await fixture(t);
  const list = await manager.list();
  assert.deepEqual(
    list.map((tool) => tool.id),
    [
      'get_semesters',
      'get_study_conditions',
      'get_advanced_programs',
      'search_teachers',
      'search_companies',
    ],
  );
  for (const tool of list) {
    assert.equal(tool.source, 'partner');
    assert.equal(tool.settings.enabled, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(!('studentId' in tool.inputSchema.properties));
  }
  assert.ok(!JSON.stringify(list).includes('test-query-token'));
});

test('all Partner adapters POST exact query parameters and an empty body', async (t) => {
  const examples = {
    get_semesters: {},
    get_study_conditions: {},
    get_advanced_programs: { programId: 'IT1' },
    search_teachers: { keyWord: 'Tên thử & dấu' },
    search_companies: { keyWord: 'Example & Co' },
  };
  let last;
  const { manager } = await fixture(t, async (url, options) => {
    last = { url: new URL(url), options };
    return json({ status: 200, data: [] });
  });
  for (const tool of toolCatalog.filter((item) => item.source === 'partner')) {
    const result = await manager.execute(tool.id, examples[tool.id]);
    assert.equal(result.status, 'empty', tool.id);
    assert.equal(last.url.pathname, `/base/${tool.endpoint}`);
    assert.equal(last.options.method, 'POST');
    assert.equal(last.options.body, undefined);
    assert.equal(last.options.redirect, 'error');
    assert.equal(last.options.headers.Authorization, 'test-header-token');
    assert.deepEqual(Object.fromEntries(last.url.searchParams), {
      token: 'test-query-token',
      ...examples[tool.id],
    });
  }
});

test('strict schemas reject empty keywords, missing program and undeclared arguments', async (t) => {
  let calls = 0;
  const { manager } = await fixture(t, async () => {
    calls++;
    return json({ data: [] });
  });
  for (const [id, args] of [
    ['search_companies', { keyWord: '   ' }],
    ['search_teachers', { keyWord: '' }],
    ['get_advanced_programs', {}],
    [
      'get_advanced_programs',
      { programId: 'IT1', url: 'https://other.invalid' },
    ],
    ['get_semesters', { unexpected: true }],
  ])
    assert.equal((await manager.execute(id, args)).status, 'invalid_arguments');
  assert.equal(calls, 0);
});

test('settings persist across restart and concurrent updates do not lose changes', async (t) => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return json({ data: [] });
  };
  const { manager, config } = await fixture(t, fetcher);
  await Promise.all([
    manager.update('get_study_conditions', { enabled: false }),
    manager.update('get_semesters', { timeoutMs: 2000, retries: 0 }),
  ]);
  const restarted = new ToolManager(config, fetcher);
  assert.equal(
    (await restarted.execute('get_study_conditions', {})).status,
    'disabled',
  );
  const list = await restarted.list();
  assert.equal(
    list.find((tool) => tool.id === 'get_semesters').settings.timeoutMs,
    2000,
  );
  assert.equal(calls, 0);
  assert.ok(!(await manager.update('unknown', { enabled: true })));
  await assert.rejects(
    manager.update('get_study_conditions', { timeoutMs: 999 }),
  );
});

test('HTTP-200 application errors retry and return sanitized failure', async (t) => {
  let calls = 0;
  const { manager } = await fixture(t, async () => {
    calls++;
    return json({ error: 'Connection reset by peer: private payload' });
  });
  const result = await manager.execute('get_study_conditions', {});
  assert.equal(calls, 2);
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'UPSTREAM_APPLICATION_ERROR');
  assert.ok(!JSON.stringify(result).includes('private payload'));
});

test('retries transient HTTP failure but rejects malformed JSON without retry', async (t) => {
  let calls = 0;
  const { manager } = await fixture(t, async () =>
    ++calls === 1
      ? new Response('unavailable', { status: 503 })
      : json({ data: null }),
  );
  assert.equal((await manager.execute('get_semesters', {})).status, 'empty');
  assert.equal(calls, 2);
  const { manager: broken } = await fixture(
    t,
    async () => new Response('<html>failure</html>'),
  );
  assert.equal(
    (await broken.execute('get_semesters', {})).errorCode,
    'UPSTREAM_INVALID_JSON',
  );
});

test('deadline and caller cancellation stop upstream work', async (t) => {
  // AbortSignal.timeout uses an unref'ed timer; this socket-free fake needs a live handle.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const fetcher = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  const { manager } = await fixture(t, fetcher);
  await manager.update('get_semesters', { timeoutMs: 1000 });
  assert.equal((await manager.execute('get_semesters', {})).status, 'timeout');
  const cancellation = new AbortController();
  const pending = manager.execute('get_semesters', {}, cancellation.signal);
  setTimeout(() => cancellation.abort(), 10);
  assert.equal((await pending).status, 'cancelled');
});

test('missing credentials return not_configured without network access', async (t) => {
  const { manager } = await fixture(
    t,
    () => {
      throw new Error('must not call');
    },
    { partnerToken: undefined },
  );
  assert.equal(
    (await manager.execute('get_semesters', {})).status,
    'not_configured',
  );
});

test('management router authenticates reads/writes, rejects origin and executes', async (t) => {
  const { manager, config } = await fixture(t);
  const app = express();
  app.use(express.json());
  app.use('/tools', createToolsRouter(config, manager));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/tools`;
  const headers = {
    Authorization: `Bearer ${config.managementToken}`,
    'Content-Type': 'application/json',
  };
  assert.equal((await fetch(base)).status, 401);
  assert.equal(
    (await fetch(base, { headers: { Authorization: 'Bearer wrong' } })).status,
    401,
  );
  assert.equal(
    (
      await fetch(base, {
        headers: { ...headers, Origin: 'https://untrusted.invalid' },
      })
    ).status,
    403,
  );
  const listed = await fetch(base, { headers });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.equal((await listed.json()).tools.length, 5);
  assert.equal(
    (
      await fetch(`${base}/get_semesters/execute`, {
        method: 'POST',
        headers,
        body: '{"arguments":{}}',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/get_semesters`, {
        method: 'PATCH',
        headers,
        body: '{"enabled":false}',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/get_semesters/execute`, {
        method: 'POST',
        headers,
        body: '{}',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await fetch(`${base}/get_semesters`, {
        method: 'PATCH',
        headers,
        body: '{"retries":99}',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${base}/get_semesters/execute`, {
        method: 'POST',
        headers: { Authorization: headers.Authorization },
        body: '{}',
      })
    ).status,
    415,
  );
  assert.equal((await fetch(`${base}/missing`, { headers })).status, 404);
  assert.equal(
    (
      await fetch(`${base}/cache/courses/clear`, {
        method: 'POST',
        headers,
        body: '{}',
      })
    ).status,
    404,
  );
});

test('short or missing management token disables management API', async (t) => {
  const { manager, config } = await fixture(t, undefined, {
    managementToken: 'short',
  });
  const app = express();
  app.use('/tools', createToolsRouter(config, manager));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(
    (await fetch(`http://127.0.0.1:${server.address().port}/tools`)).status,
    503,
  );
});

test('configuration rejects non-HTTP endpoints and credentials in URLs', () => {
  assert.throws(() => readToolConfig({ HUST_BASE_API_URL: 'file:///private' }));
  assert.throws(() =>
    readToolConfig({ HUST_BASE_API_URL: 'https://x.invalid/?token=secret' }),
  );
  assert.throws(() =>
    readToolConfig({ HUST_BASE_API_URL: 'https://user:pass@x.invalid' }),
  );
});

test('concurrency is bounded and metrics contain operational counts only', async (t) => {
  let unblock;
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  let calls = 0;
  const { manager } = await fixture(t, async () => {
    calls++;
    await gate;
    return json({ data: [] });
  });
  const pending = Array.from({ length: 8 }, () =>
    manager.execute('get_semesters', {}),
  );
  // Wait for all eight to cross the dispatch gate without depending on an arbitrary delay.
  while (calls < 8) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await manager.execute('get_semesters', {})).status, 'busy');
  unblock();
  await Promise.all(pending);
  const catalog = await manager.list();
  const metrics = catalog.find((tool) => tool.id === 'get_semesters').metrics;
  assert.equal(metrics.active, 0);
  assert.equal(metrics.calls, 8);
  assert.equal(metrics.statuses.empty, 8);
  assert.ok(!JSON.stringify(catalog).includes('test-query-token'));
});

test('removed tool cannot be restored by old settings or PATCH', async (t) => {
  let calls = 0;
  const { config } = await fixture(t);
  const removed = 'fetch_courses';
  await writeFile(
    join(config.dataDir, 'settings.json'),
    JSON.stringify({
      version: 1,
      tools: { [removed]: { enabled: true, timeoutMs: 10000, retries: 0 } },
    }),
  );
  const manager = new ToolManager(config, async () => {
    calls++;
    return json({ data: [] });
  });
  assert.equal((await manager.list()).length, 5);
  assert.equal((await manager.execute(removed, {})).status, 'not_found');
  assert.equal(await manager.update(removed, { enabled: true }), undefined);
  assert.equal(calls, 0);
  await manager.update('get_semesters', { enabled: false });
  assert.ok(
    !(
      removed in
      JSON.parse(await readFile(join(config.dataDir, 'settings.json'), 'utf8'))
        .tools
    ),
  );
});
