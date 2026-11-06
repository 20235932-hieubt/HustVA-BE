import { CrawlStore } from './store.js';
import { PublicFetcher, CrawlError } from './network.js';
import { getSource } from './sources.js';
import { htmlContent, makeDocument, pdfContent } from './extract.js';
import type { Block, CrawlRun, Fetcher } from './types.js';

export async function executeRun(
  store: CrawlStore,
  run: CrawlRun,
  options: {
    fetcher?: Fetcher;
    signal?: AbortSignal;
    extractPdf?: (bytes: Uint8Array) => Promise<Block[]>;
    log?: (message: string) => void;
  } = {},
): Promise<void> {
  const source = getSource(run.sourceId);
  const fetcher = options.fetcher ?? new PublicFetcher(source, options.signal);
  run.status = 'running';
  run.stopReason = null;
  await store.saveRun(run);
  try {
    while (run.pending.length) {
      if (options.signal?.aborted) {
        run.status = 'cancelled';
        run.stopReason = 'request-aborted';
        run.finishedAt = new Date().toISOString();
        return;
      }
      if (await store.cancelled(run.id)) {
        run.status = 'cancelled';
        run.stopReason = 'user-cancelled';
        break;
      }
      // Keep target in checkpoint until its result and discovered links have been persisted.
      const target = run.pending[0];
      if (run.results.some((result) => result.url === target.url)) {
        run.pending.shift();
        continue;
      }
      let rawHash: string | undefined;
      try {
        options.log?.(`Đang đọc: ${target.url}`);
        const response = await fetcher.get(target.url, target.kind);
        rawHash = await store.saveArtifact(response.bytes);
        if (target.kind === 'pdf') {
          const blocks = await (options.extractPdf ?? pdfContent)(response.bytes);
          const document = makeDocument(
            source,
            target,
            response,
            target.title ??
              decodeURIComponent(new URL(response.url).pathname.split('/').at(-1) ?? 'PDF'),
            blocks,
            'needs_review',
          );
          const status = await store.saveDocument(document);
          run.results.push({
            url: target.url,
            status,
            message: 'Đã lưu chữ trong PDF và bản gốc để đối chiếu',
            documentId: document.documentId,
            versionId: document.versionId,
            kind: target.kind,
          });
        } else {
          const parsed = htmlContent(source, response);
          if (parsed.listing)
            run.results.push({
              url: target.url,
              status: 'discovered',
              message: 'Đã tìm thấy các bài viết để đọc tiếp',
            });
          else {
            const document = makeDocument(
              source,
              target,
              response,
              parsed.title,
              parsed.blocks,
              parsed.pointer ? 'index_only' : parsed.requiresReview ? 'needs_review' : 'accepted',
              parsed.links,
            );
            const status = await store.saveDocument(document);
            run.results.push({
              url: target.url,
              status,
              message: parsed.pointer
                ? 'Đã lưu trang dẫn tới PDF đính kèm'
                : 'Đã lấy nội dung HTML',
              documentId: document.documentId,
              versionId: document.versionId,
            });
          }
          const seen = new Set([
            ...run.results.map((result) => result.url),
            ...run.pending.map((target) => target.url),
          ]);
          const discovered = parsed.targets.filter((target) => !seen.has(target.url));
          // Download attachments first; next listing is queued behind article links.
          run.pending.push(...discovered.filter((target) => target.kind === 'html'));
          run.pending.splice(1, 0, ...discovered.filter((target) => target.kind === 'pdf'));
        }
      } catch (error) {
        if (options.signal?.aborted) {
          run.status = 'cancelled';
          run.stopReason = 'request-aborted';
          run.finishedAt = new Date().toISOString();
          return;
        }
        run.results.push({
          url: target.url,
          status:
            error instanceof CrawlError && ['ROBOTS_DENIED', 'URL_POLICY'].includes(error.code)
              ? 'skipped'
              : 'failed',
          message: error instanceof Error ? error.message : 'Lỗi không xác định',
          errorCode: error instanceof CrawlError ? error.code : 'UNEXPECTED',
        });
      }
      run.pending.shift();
      const result = run.results.at(-1);
      if (result) {
        result.kind = target.kind;
        result.rawHash = rawHash;
      }
      await store.saveRun(run);
      if (result)
        options.log?.(
          result.status === 'unchanged' ? 'Nội dung không đổi, giữ bản đã lưu.' : result.message,
        );
    }
    if (run.status !== 'cancelled') {
      const good = run.results.some((result) =>
        ['saved', 'unchanged', 'discovered'].includes(result.status),
      );
      const bad = run.results.some((result) => ['failed', 'skipped'].includes(result.status));
      run.status = good ? (bad || run.stopReason ? 'partial' : 'completed') : 'failed';
      run.stopReason ??= 'frontier-exhausted';
    }
    run.finishedAt = new Date().toISOString();
  } finally {
    await store.saveRun(run);
    await fetcher.close?.();
  }
}
