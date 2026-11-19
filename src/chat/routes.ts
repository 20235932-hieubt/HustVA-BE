import express from 'express';
import { z } from 'zod';
import { ChatError } from './contracts.js';
import { readChatConfig } from '../agent/config.js';
import { tokenHash } from './repository.js';
import { chatShutdown, getChatService } from './runtime.js';
import { abortable, type ChatService } from './service.js';
import { requestTrace } from '../observability/http.js';
import { addTraceContext, logger } from '../observability/logger.js';
import { readHttpConfig } from '../http-config.js';

export function createChatRouter(
  service: () => Promise<ChatService> = getChatService,
): express.Router {
  const router = express.Router();
  router.use(requestTrace);
  const windows = new Map<string, { count: number; until: number }>();
  // TODO(OPS-01): replace process-local rate limits before running multiple public API instances.
  function limit(key: string, maximum: number) {
    const now = Date.now();
    for (const [name, window] of windows)
      if (window.until <= now) windows.delete(name);
    const window = windows.get(key) ?? { count: 0, until: now + 60_000 };
    if (window.count >= maximum || (!windows.has(key) && windows.size >= 2000))
      throw new ChatError(
        429,
        'RATE_LIMITED',
        'Quá nhiều yêu cầu; thử lại sau một phút.',
      );
    window.count++;
    windows.set(key, window);
  }
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (chatShutdown.signal.aborted)
        throw new ChatError(503, 'SHUTTING_DOWN', 'API đang dừng.');
      const http = readHttpConfig();
      if (!http.chatHostnames.includes(req.hostname))
        throw new ChatError(
          403,
          'API_HOST_DENIED',
          'Hostname API chưa được cấu hình cho chatbot.',
        );
      const origin = req.get('origin');
      if (
        origin &&
        ![
          `${req.protocol}://${req.get('host')}`,
          http.apiOrigin,
          http.webOrigin,
        ].includes(origin)
      )
        throw new ChatError(403, 'ORIGIN_DENIED', 'Origin không được phép.');
      if (req.method === 'POST' && !req.is('application/json'))
        throw new ChatError(
          415,
          'JSON_REQUIRED',
          'Cần Content-Type: application/json.',
        );
      limit(`ip:${req.ip}`, 60);
      next();
    } catch (error) {
      next(error);
    }
  });
  function credentials(req: express.Request) {
    if (!z.uuid().safeParse(req.params.id).success)
      throw new ChatError(400, 'ID_INVALID', 'ID phiên không hợp lệ.');
    const match = /^Bearer ([a-zA-Z0-9_-]{43})$/u.exec(
      req.get('authorization') ?? '',
    );
    if (!match)
      throw new ChatError(401, 'TOKEN_REQUIRED', 'Cần Bearer token phiên.');
    addTraceContext({ conversationId: req.params.id as string });
    return { id: req.params.id as string, token: match[1] };
  }
  router.post('/conversations', async (req, res) => {
    if (!z.strictObject({}).safeParse(req.body).success)
      throw new ChatError(400, 'BODY_INVALID', 'Body tạo phiên là {}.');
    limit(`create:${req.ip}`, 10);
    res.status(201).json(await (await service()).create());
  });
  router.post('/conversations/:id/messages', async (req, res) => {
    if (z.uuid().safeParse(req.body?.requestId).success)
      addTraceContext({ requestId: req.body.requestId });
    const auth = credentials(req);
    limit(`message:${auth.id}:${tokenHash(auth.token)}`, 10);
    const controller = new AbortController();
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          new ChatError(
            504,
            'CHAT_TIMEOUT',
            'Lượt xử lý hết thời gian; kiểm tra trạng thái request trước khi thử lại.',
          ),
        ),
      readChatConfig().timeoutMs,
    );
    const aborted = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', aborted);
    res.once('close', aborted);
    try {
      const signal = AbortSignal.any([
        controller.signal,
        deadline.signal,
        chatShutdown.signal,
      ]);
      const work = (async () => {
        const chat = await service();
        signal.throwIfAborted();
        return chat.message(auth.id, auth.token, req.body, signal);
      })();
      const result = await abortable(work, signal);
      addTraceContext({ runId: result.runId });
      if (!res.destroyed) res.json(result);
    } finally {
      clearTimeout(timer);
      req.off('aborted', aborted);
      res.off('close', aborted);
    }
  });
  router.get('/conversations/:id/messages', async (req, res) => {
    const auth = credentials(req);
    const number = (
      value: unknown,
      fallback: number,
      min: number,
      max: number,
    ) => {
      if (value === undefined) return fallback;
      if (
        typeof value !== 'string' ||
        !/^\d+$/u.test(value) ||
        Number(value) < min ||
        Number(value) > max
      )
        throw new ChatError(
          400,
          'PAGINATION_INVALID',
          'Phân trang không hợp lệ.',
        );
      return Number(value);
    };
    res.json({
      messages: await (
        await service()
      ).history(
        auth.id,
        auth.token,
        number(req.query.limit, 20, 1, 50),
        number(req.query.offset, 0, 0, 1000),
      ),
    });
  });
  router.get('/conversations/:id/requests/:requestId', async (req, res) => {
    const auth = credentials(req);
    if (!z.uuid().safeParse(req.params.requestId).success)
      throw new ChatError(400, 'ID_INVALID', 'requestId không hợp lệ.');
    res.json(
      await (
        await service()
      ).request(auth.id, auth.token, req.params.requestId as string),
    );
  });
  router.delete('/conversations/:id', async (req, res) => {
    const auth = credentials(req);
    await (await service()).remove(auth.id, auth.token);
    res.status(204).end();
  });
  router.use((_req, _res, next) =>
    next(
      new ChatError(
        404,
        'ENDPOINT_NOT_FOUND',
        'Endpoint chatbot không tồn tại.',
      ),
    ),
  );
  router.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      const safe =
        error instanceof ChatError
          ? error
          : new ChatError(
              503,
              'CHAT_UNAVAILABLE',
              'Chưa hoàn tất được yêu cầu chatbot.',
            );
      if (safe.status >= 500)
        logger.error('chat.http.failed', {
          errorCode: safe.code,
          statusCode: safe.status,
        });
      else
        logger.warn('chat.http.rejected', {
          errorCode: safe.code,
          statusCode: safe.status,
        });
      if (res.destroyed) return;
      if (safe.status === 429) res.set('Retry-After', '60');
      res
        .status(safe.status)
        .json({ error: { code: safe.code, message: safe.message } });
    },
  );
  return router;
}
