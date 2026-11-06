import path from 'node:path';
import type { CrawlDocument, CrawlRun } from './types.js';
import type { CrawlStore } from './store.js';

const qualityLabel = {
  accepted: 'Đã lấy nội dung HTML',
  needs_review: 'Đã lấy nội dung; cần đối chiếu bản gốc',
  index_only: 'Trang dẫn tới tài liệu khác',
};
export function readableDocuments(documents: CrawlDocument[]): string {
  if (!documents.length)
    return 'Chưa có nội dung được thu thập. Xem thông báo lỗi trong console.\n';
  return (
    documents
      .map((document) =>
        [
          document.title,
          `Nguồn: ${document.url}`,
          document.parentUrl ? `Bài chứa tài liệu: ${document.parentUrl}` : '',
          `Tình trạng: ${qualityLabel[document.quality]}`,
          ...document.warnings,
          '',
          ...document.blocks.map(
            (block) => `${block.page ? `Trang ${block.page}\n` : ''}${block.text}`,
          ),
          ...(document.links?.length
            ? [
                'Liên kết trong bài:',
                ...document.links.map((link) => `${link.title || link.kind}: ${link.url}`),
              ]
            : []),
        ]
          .filter((line) => line !== '')
          .join('\n\n'),
      )
      .join('\n\n------------------------------\n\n') + '\n'
  );
}

export async function printRunResults(
  store: CrawlStore,
  run: CrawlRun,
  log = console.log,
  fullText = false,
): Promise<void> {
  const documents = await store.documents(run.id);
  log('');
  log(
    run.status === 'failed'
      ? 'Chưa lấy được nội dung. Hãy xem lỗi phía trên.'
      : run.status === 'cancelled'
        ? 'Đã dừng theo yêu cầu.'
        : run.status === 'running'
          ? 'Đã tạm dừng; nội dung đã lấy vẫn được giữ.'
          : 'Đã xử lý xong lượt crawl.',
  );
  if (run.status === 'partial') log('Một phần nội dung chưa lấy được hoặc chưa đi hết nguồn.');
  for (const document of documents.filter((document) => document.quality !== 'index_only')) {
    log(`\n${document.title}\nNguồn: ${document.url}\n${qualityLabel[document.quality]}`);
    log(
      fullText
        ? document.text
        : document.text.slice(0, 400) + (document.text.length > 400 ? '…' : ''),
    );
  }
  log(`\nĐọc toàn bộ nội dung: ${path.join(store.directory, 'exports', 'latest.txt')}`);
  log(`File đầy đủ nội dung JSONL: ${path.join(store.directory, 'exports', 'latest.jsonl')}`);
  if (documents.some((document) => document.quality === 'needs_review'))
    log('Tài liệu có cảnh báo vẫn được đưa vào JSONL để đối chiếu với bản gốc.');
}
