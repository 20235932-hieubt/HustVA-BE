import express from 'express';
import { z } from 'zod';
import { readHttpConfig } from '../http-config.js';
import { ChatError } from '../chat/contracts.js';
import { readDemoConfig } from './demo-config.js';
import { normalizeUsername } from './demo-accounts.js';
import {
  authRequired,
  type DemoAuthService,
  sessionHash,
} from './demo-service.js';
import { demoCookieName, getDemoAuth, readDemoCookie } from './runtime.js';

export function createDemoAuthRouter(
  service: () => Promise<DemoAuthService | undefined> = getDemoAuth,
) {
  const router = express.Router();
  const buckets = new Map<string, { count: number; until: number }>();
  const limit = (key: string, max: number) => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.until <= now) buckets.delete(k);
    const bucket = buckets.get(key) ?? { count: 0, until: now + 60_000 };
    if (bucket.count >= max || (!buckets.has(key) && buckets.size >= 2000))
      throw new ChatError(429, 'DEMO_RATE_LIMITED', 'Thử lại sau một phút.');
    bucket.count++;
    buckets.set(key, bucket);
  };
  const cookieOptions = () => ({
    httpOnly: true,
    secure: readDemoConfig().secure,
    sameSite: 'lax' as const,
    path: '/api/v1',
  });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.method !== 'GET') {
        const http = readHttpConfig();
        if (![http.webOrigin, http.apiOrigin].includes(req.get('origin') ?? ''))
          throw new ChatError(403, 'ORIGIN_DENIED', 'Origin không được phép.');
        if (!req.is('application/json'))
          throw new ChatError(415, 'JSON_REQUIRED', 'Cần JSON.');
      }
      limit(`ip:${req.ip}`, 30);
      next();
    } catch (error) {
      next(error);
    }
  });
  router.post('/login', async (req, res) => {
    const parsed = z
      .strictObject({
        username: z.string().trim().min(1).max(100),
        password: z.string().min(1).max(256),
      })
      .safeParse(req.body);
    if (!parsed.success)
      throw new ChatError(
        400,
        'DEMO_INPUT_INVALID',
        'Cần tên đăng nhập và mật khẩu demo.',
      );
    limit(`user:${sessionHash(normalizeUsername(parsed.data.username))}`, 5);
    const auth = await service();
    if (!auth) throw authRequired();
    const previous = readDemoCookie(req.get('cookie'));
    const result = await auth.login(parsed.data.username, parsed.data.password);
    if (previous) await auth.logout(previous);
    res
      .cookie(demoCookieName, result.token, {
        ...cookieOptions(),
        expires: result.user.expiresAt,
      })
      .json(result.user);
  });
  router.get('/me', async (req, res) => {
    const token = readDemoCookie(req.get('cookie'));
    const auth = await service();
    if (!token || !auth) throw authRequired();
    res.json(await auth.me(token));
  });
  router.post('/logout', async (req, res) => {
    if (!z.strictObject({}).safeParse(req.body).success)
      throw new ChatError(400, 'DEMO_INPUT_INVALID', 'Cần body {}.');
    const token = readDemoCookie(req.get('cookie'));
    const auth = await service();
    if (token && auth) await auth.logout(token);
    res.clearCookie(demoCookieName, cookieOptions()).status(204).end();
  });
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
              'DEMO_AUTH_UNAVAILABLE',
              'Đăng nhập demo chưa sẵn sàng.',
            );
      if (safe.status === 429) res.set('Retry-After', '60');
      res
        .status(safe.status)
        .json({ error: { code: safe.code, message: safe.message } });
    },
  );
  return router;
}
