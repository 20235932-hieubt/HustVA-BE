import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import { currentTrace, logger, withTrace } from './logger.js';

export const requestTrace: RequestHandler = (req, res, next) => {
  // The chat router also installs this middleware for standalone mounting/tests.
  if (currentTrace().traceId) return next();
  const traceId = randomUUID();
  const started = performance.now();
  withTrace({ traceId }, () => {
    res.set('X-Trace-Id', traceId);
    logger.info('http.request.started', { method: req.method });
    let finished = false;
    const complete = (aborted: boolean) => {
      if (finished) return;
      finished = true;
      const fields = {
        traceId,
        method: req.method,
        // Express route templates only; never log raw path/query parameters.
        route: typeof req.route?.path === 'string' ? req.route.path : undefined,
        statusCode: aborted ? 499 : res.statusCode,
        durationMs: performance.now() - started,
      };
      if (aborted) logger.warn('http.request.aborted', fields);
      else if (res.statusCode >= 500) logger.error('http.request.completed', fields);
      else if (res.statusCode >= 400) logger.warn('http.request.completed', fields);
      else logger.info('http.request.completed', fields);
    };
    res.once(
      'finish',
      AsyncLocalStorage.bind(() => complete(false)),
    );
    res.once(
      'close',
      AsyncLocalStorage.bind(() => complete(!res.writableFinished)),
    );
    next();
  });
};
