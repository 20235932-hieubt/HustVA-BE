import { hash } from '../crawler/store.js';
import type { Block, CrawlDocument } from '../crawler/types.js';
import type { Chunk, ChunkPayload } from './types.js';

/** Production chunks: about 512 tokens with 15% overlap, the best retrieval result among the strategies compared. */
export const WINDOW_SIZE = 1750;
export const WINDOW_OVERLAP = 260;

/** Structure chunking (by heading and article), kept for comparison. Sizes are in characters. */
const TARGET = 1200;
const MAX = 2000;
const MIN_CHUNK = 40;
const MAX_HEADING = 160;

// Capitalised only, so a wrapped PDF line such as "điều 5 của Quy chế" is not a new article.
const END = String.raw`(?=$|[\s.:,)\-–])`;
const CHAPTER = new RegExp(
  String.raw`^(?:Chương|CHƯƠNG|Mục|MỤC|Phần|PHẦN)\s+(?:[IVXLC]+|\d+)${END}`,
  'u',
);
const ARTICLE = new RegExp(String.raw`^(?:Điều|ĐIỀU)\s+\d+[a-zđ]?${END}`, 'u');
/** Appendices follow the last article; they must not inherit its heading. */
const APPENDIX = /^(?:PHỤ LỤC|Phụ lục)(?=$|[\s.:\-–])/u;

/** "Điều 2. Quyết định này có hiệu lực kể từ ngày ký. Các …" → "Điều 2. Quyết định này có hiệu lực kể từ ngày ký" */
const articleTitle = (line: string): string => {
  const [, number = line, rest = ''] = /^(\S+\s+\S+?[.:]?)\s*(.*)$/u.exec(line) ?? [];
  const title = rest
    .split(/(?<=[^\d])[.:;]\s/u)[0]
    .slice(0, 100)
    .trim();
  return title ? `${number} ${title}` : number;
};
const CLAUSE = /^\d{1,2}\.\s/u;

/**
 * Inline images (`data:image/png;base64,...`) sometimes end up in extracted HTML text. They carry
 * no meaning for search and would otherwise fill dozens of chunks with base64 noise.
 */
const DATA_URI = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+/gu;
const BASE64_RUN = /[A-Za-z0-9+/]{200,}={0,2}/gu;
const stripEmbeddedData = (text: string): string =>
  text.replace(DATA_URI, ' ').replace(BASE64_RUN, ' ');

export const uuidFromHash = (value: string): string => {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

function payloadOf(document: CrawlDocument): ChunkPayload {
  return {
    documentId: document.documentId,
    versionId: document.versionId,
    sourceId: document.sourceId,
    url: document.url,
    parentUrl: document.parentUrl,
    title: document.title,
    mimeType: document.mimeType,
    quality: document.quality,
    issuedAt: document.metadata.issuedAt,
    academicYear: document.metadata.academicYear,
    cohorts: document.metadata.cohorts,
    validityStatus: document.metadata.validityStatus,
  };
}

/** Splits one over-long line at sentence ends, then at spaces. */
function splitLongLine(line: string): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const sentence of line.split(/(?<=[.!?;:])\s+/u)) {
    let rest = sentence;
    while (rest.length > MAX) {
      const cut = rest.lastIndexOf(' ', MAX);
      const at = cut > MAX / 2 ? cut : MAX;
      if (current) pieces.push(current);
      current = '';
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (current && current.length + rest.length + 1 > TARGET) {
      pieces.push(current);
      current = rest;
    } else current = current ? `${current} ${rest}` : rest;
  }
  if (current) pieces.push(current);
  return pieces.filter(Boolean);
}

function tableRows(block: Block): string[] {
  const rows = block.rows?.length ? block.rows : block.text.split('\n').map((line) => [line]);
  return rows.map((row) => row.join(' | ').trim()).filter(Boolean);
}

/**
 * Cuts a document along its structure: a new chunk starts at each heading, Chương/Mục and Điều.
 * Long articles break at a Khoản ("1. ", "2. ") once the chunk is big enough. Tables are kept
 * whole, or split by rows with the header row repeated.
 */
export function chunkDocument(document: CrawlDocument): Omit<Chunk, 'embedText'>[] {
  const payload = payloadOf(document);
  const chunks: Omit<Chunk, 'embedText' | 'id' | 'index'>[] = [];
  let section: string | null = null;
  let chapter: string | null = null;
  let article: string | null = null;
  /** After a bare "Chương II" line, the next upper-case line is the chapter name. */
  let chapterNameNext = false;
  let text = '';
  let pageStart: number | null = null;
  let pageEnd: number | null = null;

  const headings = (): string[] =>
    [section, chapter, article].filter((value): value is string => Boolean(value));
  const flush = (): void => {
    if (text.trim().length >= MIN_CHUNK)
      chunks.push({
        kind: 'text',
        headings: headings(),
        pageStart,
        pageEnd,
        text: text.trim(),
        payload,
      });
    text = '';
    pageStart = null;
    pageEnd = null;
  };
  const append = (piece: string, page: number | null, separator: string): void => {
    if (text && text.length + piece.length + separator.length > TARGET) flush();
    text = text ? `${text}${separator}${piece}` : piece;
    if (page !== null) {
      pageStart ??= page;
      pageEnd = page;
    }
  };
  const line = (raw: string, page: number | null, separator: string): void => {
    const value = raw.trim();
    if (!value) return;
    const chapterName = chapterNameNext;
    chapterNameNext = false;
    if (
      chapterName &&
      value === value.toUpperCase() &&
      /\p{L}/u.test(value) &&
      !ARTICLE.test(value) &&
      `${chapter}. ${value}`.length <= MAX_HEADING
    ) {
      chapter = `${chapter}. ${value}`;
      return;
    }
    if (APPENDIX.test(value) && value.length <= MAX_HEADING) {
      flush();
      chapter = value;
      article = null;
      chapterNameNext = true;
      return;
    }
    if (CHAPTER.test(value) && value.length <= MAX_HEADING) {
      flush();
      chapter = value;
      article = null;
      chapterNameNext = !/\s\p{L}{2,}/u.test(value.replace(CHAPTER, ''));
      return;
    }
    if (ARTICLE.test(value)) {
      flush();
      article = articleTitle(value);
      if (value.length <= MAX_HEADING && article === value) return; // Line is only the title.
    } else if (CLAUSE.test(value) && text.length >= TARGET * 0.6) flush();
    for (const piece of value.length > MAX ? splitLongLine(value) : [value])
      append(piece, page, separator);
  };

  for (const block of document.blocks) {
    const page = block.page ?? null;
    const value = stripEmbeddedData(block.text.normalize('NFC')).trim();
    if (!value && block.type !== 'table') continue;
    if (block.type === 'heading') {
      flush();
      if (CHAPTER.test(value)) {
        chapter = value.slice(0, MAX_HEADING);
        article = null;
      } else if (ARTICLE.test(value)) article = articleTitle(value);
      else {
        section = value.slice(0, MAX_HEADING);
        chapter = null;
        article = null;
      }
      continue;
    }
    if (block.type === 'table') {
      flush();
      const rows = tableRows(block);
      const header = rows.length > 1 ? rows[0] : null;
      let group: string[] = [];
      const emit = (): void => {
        const body = (header && group[0] !== header ? [header, ...group] : group).join('\n');
        if (body.length >= MIN_CHUNK)
          chunks.push({
            kind: 'table',
            headings: headings(),
            pageStart: page,
            pageEnd: page,
            text: body,
            payload,
          });
        group = [];
      };
      if (rows.join('\n').length <= MAX) group = rows;
      else
        for (const row of header ? rows.slice(1) : rows) {
          if (group.length && [header, ...group, row].join('\n').length > TARGET) emit();
          group.push(row);
        }
      emit();
      continue;
    }
    // Paragraphs are separated by a blank line; lines inside a block or PDF page by a newline.
    value.split('\n').forEach((raw, index) => line(raw, page, index === 0 ? '\n\n' : '\n'));
  }
  flush();

  return chunks.map((chunk, index) => ({
    ...chunk,
    index,
    id: uuidFromHash(`${document.documentId}:${document.versionId}:${index}`),
  }));
}

export function embedTextOf(chunk: Pick<Chunk, 'text' | 'headings' | 'payload'>): string {
  return [chunk.payload.title, chunk.headings.join(' › '), '', chunk.text]
    .filter((part, index) => part || index === 2)
    .join('\n')
    .trim();
}

interface OutlineMark {
  offset: number;
  page: number | null;
  section: string | null;
  chapter: string | null;
  article: string | null;
}

/** The document as one string, with where each page and heading starts in it. */
function outlineOf(document: CrawlDocument): { text: string; marks: OutlineMark[] } {
  const parts: string[] = [];
  const marks: OutlineMark[] = [];
  let offset = 0;
  let section: string | null = null;
  let chapter: string | null = null;
  let article: string | null = null;
  for (const block of document.blocks) {
    const value = stripEmbeddedData(block.text.normalize('NFC')).trim();
    if (!value) continue;
    if (parts.length) offset += 1; // The newline that joins the parts.
    const page = block.page ?? null;
    const mark = (at: number): void => {
      marks.push({ offset: at, page, section, chapter, article });
    };
    if (block.type === 'heading') {
      if (CHAPTER.test(value)) {
        chapter = value.slice(0, MAX_HEADING);
        article = null;
      } else if (ARTICLE.test(value)) article = articleTitle(value);
      else {
        section = value.slice(0, MAX_HEADING);
        chapter = null;
        article = null;
      }
    }
    mark(offset);
    if (block.type !== 'heading') {
      let lineStart = offset;
      for (const raw of value.split('\n')) {
        const line = raw.trim();
        if (CHAPTER.test(line) && line.length <= MAX_HEADING) {
          chapter = line;
          article = null;
          mark(lineStart);
        } else if (ARTICLE.test(line)) {
          article = articleTitle(line);
          mark(lineStart);
        }
        lineStart += raw.length + 1;
      }
    }
    parts.push(value);
    offset += value.length;
  }
  return { text: parts.join('\n'), marks };
}

const articleNumber = (title: string): string => ARTICLE.exec(title)?.[0] ?? title;

/**
 * Sliding window over the whole document, cut at a space. Headings and pages only locate the
 * passage for citations; the embedded text is the document title plus the passage.
 */
export function windowChunks(
  document: CrawlDocument,
  size = WINDOW_SIZE,
  overlap = WINDOW_OVERLAP,
): Chunk[] {
  const payload = payloadOf(document);
  const { text, marks } = outlineOf(document);
  const markAt = (offset: number): OutlineMark | undefined =>
    marks.filter((mark) => mark.offset <= offset).at(-1);
  const chunks: Chunk[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > start + size / 2) end = space;
    }
    const raw = text.slice(start, end);
    const piece = raw.trim();
    if (piece.length >= MIN_CHUNK) {
      const from = start + raw.length - raw.trimStart().length;
      const to = from + piece.length;
      const first = markAt(from);
      const articles = [
        ...new Set(
          [
            first?.article,
            ...marks.filter((m) => m.offset > from && m.offset < to).map((m) => m.article),
          ].filter((value): value is string => Boolean(value)),
        ),
      ];
      const article =
        articles.length > 1 ? [...new Set(articles.map(articleNumber))].join(', ') : articles[0];
      const index = chunks.length;
      chunks.push({
        id: uuidFromHash(`${document.documentId}:${document.versionId}:${index}`),
        index,
        kind: 'text',
        headings: [first?.section, first?.chapter, article].filter((value): value is string =>
          Boolean(value),
        ),
        pageStart: first?.page ?? null,
        pageEnd: markAt(to - 1)?.page ?? null,
        text: piece,
        embedText: `${document.title}\n\n${piece}`,
        payload,
      });
    }
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export function buildChunks(document: CrawlDocument): Chunk[] {
  return windowChunks(document);
}
