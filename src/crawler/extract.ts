import { load } from 'cheerio';
import { Worker } from 'node:worker_threads';
import { hash } from './store.js';
import { allowedUrl, CrawlError } from './network.js';
import type { Block, CrawlDocument, CrawlTarget, HttpResult, Source } from './types.js';

const normalize = (text: string): string =>
  text
    .normalize('NFC')
    .replace(/[\t \u00a0]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
export function htmlContent(
  source: Source,
  response: HttpResult,
): {
  title: string;
  blocks: Block[];
  targets: CrawlTarget[];
  listing: boolean;
  pointer: boolean;
  requiresReview: boolean;
  links: NonNullable<CrawlDocument['links']>;
} {
  if (!['text/html', 'application/xhtml+xml', ''].includes(response.mime))
    throw new CrawlError('MIME', 'Response không phải HTML');
  const $ = load(Buffer.from(response.bytes).toString('utf8'));
  const pageUrl = new URL(response.url);
  const libraryListing =
    source.adapter === 'library' &&
    /^\/(?:vi\/)?(?:sanpham_dichvu|page-tr-gi-p)\/?$/u.test(pageUrl.pathname);
  const selector = {
    ctt: '.col-md-9',
    hust: '#news-bodyhtml',
    sdh: '#MainContent_ctl00_ctl00_lblPageContent',
    library: libraryListing
      ? /sanpham_dichvu/u.test(pageUrl.pathname)
        ? '#quicktabs-tabpage-s_n_ph_m_d_ch_v_-1'
        : '#block-system-main'
      : '.field-name-body, .field-name-field-body',
  }[source.adapter];
  const content = $(selector).first();
  if (!content.length)
    throw new CrawlError('TEMPLATE_CHANGED', `Không tìm thấy vùng nội dung ${selector}`);
  const title =
    normalize(
      source.adapter === 'ctt'
        ? content.find('h3').first().text()
        : source.adapter === 'sdh'
          ? $('#MainContent_ctl00_ctl00_lblName').text()
          : $('h1').first().text(),
    ) || normalize($('title').text());
  const targets: CrawlTarget[] = [];
  const listing =
    libraryListing ||
    (source.adapter === 'ctt' &&
      /DisplayQuyChe|DisplayListBaiViet|DisplayListKeHoach/iu.test(pageUrl.pathname));
  const add = (href: string | undefined, kind: 'html' | 'pdf', title?: string): void => {
    if (!href) return;
    try {
      const resolved = new URL(href, response.url);
      // The library still publishes some internal links with http or without /vi.
      if (source.adapter === 'library' && source.hosts.includes(resolved.hostname)) {
        if (resolved.protocol === 'http:') resolved.protocol = 'https:';
        if (/^\/node\/\d+\/?$/u.test(resolved.pathname))
          resolved.pathname = `/vi${resolved.pathname}`;
        resolved.pathname = resolved.pathname.replace(/\/$/u, '');
        if (kind === 'html') {
          const page = resolved.searchParams.get('page');
          const tab = resolved.searchParams.get('qt-s_n_ph_m_d_ch_v_');
          resolved.search = '';
          if (libraryListing && /^\d+(?:,\d+)*$/u.test(page ?? '')) {
            const pages = page!.split(',').map(Number);
            if (pages.some((value) => value > 0))
              resolved.searchParams.set('page', pages.join(','));
          }
          if (libraryListing && /^\d+$/u.test(tab ?? '') && Number(tab) > 0)
            resolved.searchParams.set('qt-s_n_ph_m_d_ch_v_', String(Number(tab)));
        }
      }
      const url = allowedUrl(resolved.href, source.hosts).href;
      if (url !== response.url)
        targets.push({ url, parentUrl: listing ? null : response.url, kind, title });
    } catch {
      /* External, private or unsupported targets remain outside this crawl. */
    }
  };
  if (listing && source.adapter === 'ctt') {
    content
      .find('a.contentTitle')
      .each((_index, element) =>
        add($(element).attr('href'), 'html', normalize($(element).text())),
      );
    // Follow only the next page so a listing cannot expand to every page at once.
    const current = Number(new URL(response.url).searchParams.get('page') ?? 1);
    const next = content
      .find('.pagination a[href]')
      .toArray()
      .find((element) => {
        try {
          return (
            Number(new URL($(element).attr('href')!, response.url).searchParams.get('page')) ===
            current + 1
          );
        } catch {
          return false;
        }
      });
    if (next) add($(next).attr('href'), 'html');
  }
  if (libraryListing) {
    content.find('a[href]').each((_index, element) => {
      const href = $(element).attr('href');
      if (!href) return;
      try {
        const url = new URL(href, response.url);
        // Follow category tabs and every pager link; the engine deduplicates URLs.
        if (/^\/(?:vi\/)?(?:sanpham_dichvu|page-tr-gi-p)\/?$/u.test(url.pathname))
          add(href, 'html', normalize($(element).text()));
      } catch {
        /* Invalid category URLs cannot extend the crawl. */
      }
    });
  }
  const attachmentRegion =
    source.adapter === 'sdh' ? content.add('#MainContent_ctl00_ctl00_dgAttach') : content;
  attachmentRegion.find('a[href]').each((_index, element) => {
    const href = $(element).attr('href');
    if (!href) return;
    if (/\.pdf(?:[?#]|$)/iu.test(href)) {
      add(href, 'pdf', normalize($(element).text()) || title);
      return;
    }
    try {
      const url = new URL(href, response.url);
      const article = {
        ctt:
          /\/DisplayWeb\/DisplayBaiViet$/iu.test(url.pathname) && url.searchParams.has('baiviet'),
        hust: /^\/vi\/.+\.html$/iu.test(url.pathname),
        sdh: /\/Default\.aspx$/iu.test(url.pathname) && url.searchParams.has('nid'),
        library: /^\/(?:vi\/)?node\/\d+\/?$/u.test(url.pathname),
      }[source.adapter];
      if (article) add(href, 'html', normalize($(element).text()));
    } catch {
      /* Invalid links do not stop the source crawl. */
    }
  });
  const links: NonNullable<CrawlDocument['links']> = [];
  attachmentRegion.find('a[href],img[src]').each((_index, element) => {
    const node = $(element);
    const href = node.attr('href') ?? node.attr('src');
    if (!href) return;
    try {
      const url = new URL(href, response.url);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      links.push({
        url: url.href,
        title: normalize(node.text() || node.attr('alt') || ''),
        kind:
          element.tagName === 'img'
            ? 'image'
            : /\.pdf(?:[?#]|$)/iu.test(url.href)
              ? 'pdf'
              : /\.(?:docx?|xlsx?|pptx?|zip)(?:[?#]|$)/iu.test(url.href)
                ? 'file'
                : 'page',
      });
    } catch {
      /* Ignore invalid references; retain the original downloaded HTML. */
    }
  });
  content.find('script,style,form,nav,footer,iframe,noscript').remove();
  content.find('br').replaceWith('\n');
  content.find('img').each((_index, element) => {
    const node = $(element);
    const source = node.attr('src') || '';
    $(element).replaceWith(
      `\n[Hình ảnh: ${node.attr('alt') || (/^data:/iu.test(source) ? 'Ảnh nhúng trong HTML; cần OCR' : source)}]\n`,
    );
  });
  const blocks: Block[] = [];
  let looseText = '';
  const flush = (): void => {
    if (normalize(looseText))
      blocks.push({ id: String(blocks.length), type: 'paragraph', text: normalize(looseText) });
    looseText = '';
  };
  const visit = (nodes: ReturnType<typeof content.contents>): void => {
    nodes.each((_index, element) => {
      if (element.type === 'text') {
        looseText += element.data;
        return;
      }
      if (element.type !== 'tag') return;
      if (!/^(?:h[1-6]|p|li|table)$/u.test(element.tagName)) {
        const boundary = /^(?:div|section|article|ul|ol|blockquote)$/u.test(element.tagName);
        if (boundary) flush();
        visit($(element).contents());
        if (boundary) flush();
        return;
      }
      flush();
      const node = $(element);
      const text = normalize(node.text());
      if (!text) return;
      const block: Block = {
        id: String(blocks.length),
        type: /^h[1-6]$/u.test(element.tagName)
          ? 'heading'
          : element.tagName === 'table'
            ? 'table'
            : element.tagName === 'li'
              ? 'list_item'
              : 'paragraph',
        text,
      };
      if (block.type === 'table') {
        block.cells = node
          .find('tr')
          .toArray()
          .map((row) =>
            $(row)
              .children('th,td')
              .toArray()
              .map((cell) => ({
                text: normalize($(cell).text()),
                rowSpan: Math.max(1, Number($(cell).attr('rowspan')) || 1),
                colSpan: Math.max(1, Number($(cell).attr('colspan')) || 1),
              })),
          );
        block.rows = block.cells.map((row) => row.map((cell) => cell.text));
        block.text = block.rows.map((row) => row.join(' | ')).join('\n');
      }
      blocks.push(block);
    });
  };
  visit(content.contents());
  flush();
  if (!blocks.length && normalize(content.text()))
    blocks.push({ id: '0', type: 'paragraph', text: normalize(content.text()) });
  const fullText = blocks.map((block) => block.text).join('\n\n');
  if (libraryListing && !targets.length)
    throw new CrawlError(
      'EMPTY_LISTING',
      'Danh mục thư viện không có link bài hoặc phân trang; cần kiểm tra bố cục',
    );
  if (/oops.{0,20}page|page.{0,10}not found|404 - file/iu.test(title))
    throw new CrawlError('SOFT_404', 'Trang lỗi, không lưu làm tài liệu');
  if (/^Nội dung này đang được cập nhật[.!]?$/iu.test(fullText))
    throw new CrawlError(
      'SOURCE_PENDING',
      'Website nguồn chưa cung cấp nội dung: đang được cập nhật',
    );
  const pointer =
    !listing && targets.some((target) => target.kind === 'pdf') && fullText.length < 700;
  if (!listing && !pointer && fullText.length < 80)
    throw new CrawlError('EMPTY_CONTENT', 'Nội dung quá ngắn hoặc chỉ có giao diện rỗng');
  return {
    title,
    blocks,
    targets: [...new Map(targets.map((target) => [target.url, target])).values()],
    listing,
    pointer,
    requiresReview: blocks.some((block) =>
      block.cells?.some((row) => row.some((cell) => cell.rowSpan !== 1 || cell.colSpan !== 1)),
    ),
    links: [...new Map(links.map((link) => [link.url, link])).values()],
  };
}

export async function pdfContent(bytes: Uint8Array): Promise<Block[]> {
  if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-')
    throw new CrawlError('MIME', 'Tệp không có định dạng PDF');
  return new Promise((resolve, reject) => {
    const development = import.meta.url.endsWith('.ts');
    const worker = new Worker(
      new URL(development ? './pdf-worker.ts' : './pdf-worker.js', import.meta.url),
      {
        workerData: bytes,
        resourceLimits: { maxOldGenerationSizeMb: 256 },
        ...(development ? { execArgv: ['--experimental-strip-types'] } : {}),
      },
    );
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new CrawlError('EXTRACTION_TIMEOUT', 'Đọc PDF quá 120 giây'));
    }, 120_000);
    worker.once('message', (result: { blocks?: Block[]; error?: string }) => {
      clearTimeout(timeout);
      if (result.error || !result.blocks)
        reject(new CrawlError('PDF_PARSE', result.error ?? 'Không đọc được PDF'));
      else resolve(result.blocks);
      void worker.terminate();
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new CrawlError('PDF_PROCESS', 'Tiến trình đọc PDF bị dừng'));
    });
  });
}
export function makeDocument(
  source: Source,
  target: CrawlTarget,
  response: HttpResult,
  title: string,
  blocks: Block[],
  quality: CrawlDocument['quality'],
  links: NonNullable<CrawlDocument['links']> = [],
): CrawlDocument {
  const extractorVersion =
    response.mime === 'application/pdf' || target.kind === 'pdf'
      ? 'pdfjs-text-v2'
      : `${source.adapter}-html-v${source.adapter === 'library' ? 3 : 2}`;
  const metadata: CrawlDocument['metadata'] = {
    language: 'vi',
    publishedAt: null,
    issuedAt: null,
    academicYear: title.match(/20\d{2}\s*[-–]\s*20\d{2}/u)?.[0].replace(/\s/gu, '') ?? null,
    cohorts: [...new Set(title.match(/\bK\d{2}\b/gu) ?? [])],
    validityStatus: 'unknown',
  };
  const contentHash = hash(JSON.stringify({ title, blocks, metadata, links }));
  return {
    schemaVersion: 'hustva.document.v1',
    documentId: hash(`${source.id}\n${response.url}`),
    versionId: hash(`${extractorVersion}\n${contentHash}`),
    sourceId: source.id,
    url: response.url,
    parentUrl: target.parentUrl,
    title,
    text: blocks.map((block) => block.text).join('\n\n'),
    blocks,
    links,
    contentHash,
    rawHash: hash(response.bytes),
    extractorVersion,
    mimeType: target.kind === 'pdf' ? 'application/pdf' : response.mime,
    fetchedAt: response.fetchedAt,
    updatedAt: response.fetchedAt,
    firstSeenAt: response.fetchedAt,
    quality,
    warnings: [
      ...(blocks.some((block) => block.text.includes('Ảnh nhúng trong HTML; cần OCR'))
        ? ['Chưa đọc chữ trong ảnh nhúng HTML; cần OCR hoặc đối chiếu bản gốc.']
        : []),
      ...blocks
        .filter((block) => block.type === 'pdf_page' && !block.text.trim())
        .map((block) => `Trang PDF ${block.page} không có chữ trích xuất được; có thể cần OCR.`),
      ...links
        .filter((link) => link.kind === 'image')
        .map((link) => `Chưa đọc chữ trong hình ảnh: ${link.url}`),
      ...(quality === 'needs_review'
        ? [
            target.kind === 'pdf'
              ? 'Chữ trong PDF có thể thiếu số/ngày văn bản, sai thứ tự hoặc bảng; cần đối chiếu bản gốc.'
              : 'Bảng HTML có ô gộp; cần kiểm tra quan hệ hàng/cột khi sử dụng nội dung.',
          ]
        : quality === 'index_only'
          ? ['Trang dẫn tới tài liệu đính kèm; cần đọc cả PDF đi kèm.']
          : []),
    ],
    metadata,
  };
}
