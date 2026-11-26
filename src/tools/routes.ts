import { managementToolAccess } from '../auth/tool-access.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { readHttpConfig } from '../http-config.js';
import { readToolConfig, type ToolConfig } from './config.js';
import { ToolManager, settingsPatch } from './manager.js';
import type { ToolStatus } from './contracts.js';

const httpStatus: Record<ToolStatus, number> = {
  success: 200,
  empty: 200,
  error: 502,
  timeout: 504,
  cancelled: 499,
  disabled: 409,
  invalid_arguments: 400,
  not_configured: 503,
  not_found: 404,
  busy: 429,
};
const execution = z.strictObject({
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export const toolsShutdown = new AbortController();

export function createToolsRouter(
  config: ToolConfig = readToolConfig(),
  manager = new ToolManager(config),
) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Applies to reads and writes. Hostname alone is not authorization.
    if (!config.managementToken || config.managementToken.length < 32) {
      res.status(503).json({ errorCode: 'TOOL_MANAGEMENT_NOT_CONFIGURED' });
      return;
    }
    const authorization = req.get('authorization') ?? '';
    const supplied = createHash('sha256').update(authorization).digest();
    const expected = createHash('sha256')
      .update(`Bearer ${config.managementToken}`)
      .digest();
    if (!timingSafeEqual(supplied, expected)) {
      res.status(401).json({ errorCode: 'TOOL_MANAGEMENT_UNAUTHORIZED' });
      return;
    }
    const origin = req.get('origin');
    const http = readHttpConfig();
    if (origin && ![http.apiOrigin, http.webOrigin].includes(origin)) {
      res.status(403).json({ errorCode: 'ORIGIN_DENIED' });
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
      res.status(415).json({ errorCode: 'JSON_REQUIRED' });
      return;
    }
    next();
  });
  router.get('/', async (_req, res) =>
    res.json({ tools: await manager.list() }),
  );
  router.get('/:id', async (req, res) => {
    const tool = (await manager.list()).find(
      (entry) => entry.id === req.params.id,
    );
    if (!tool) {
      res.status(404).json({ errorCode: 'TOOL_NOT_FOUND' });
      return;
    }
    res.json({ tool });
  });
  router.patch('/:id', async (req, res) => {
    const parsed = settingsPatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ errorCode: 'TOOL_SETTINGS_INVALID' });
      return;
    }
    const settings = await manager.update(req.params.id, parsed.data);
    if (!settings) {
      res.status(404).json({ errorCode: 'TOOL_NOT_FOUND' });
      return;
    }
    res.json({ settings });
  });
  router.post('/:id/execute', async (req, res) => {
    const parsed = execution.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ errorCode: 'TOOL_ARGUMENTS_INVALID' });
      return;
    }
    const disconnected = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) disconnected.abort();
    };
    res.once('close', onClose);
    try {
      const result = await manager.execute(
        req.params.id,
        parsed.data.arguments,
        AbortSignal.any([disconnected.signal, toolsShutdown.signal]),
        managementToolAccess(),
      );
      if (!res.destroyed) res.status(httpStatus[result.status]).json(result);
    } finally {
      res.off('close', onClose);
    }
  });
  router.use((_req, res) =>
    res.status(404).json({ errorCode: 'TOOL_ROUTE_NOT_FOUND' }),
  );
  router.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      res.status(500).json({ errorCode: 'TOOL_MANAGEMENT_FAILED' });
    },
  );
  return router;
}
