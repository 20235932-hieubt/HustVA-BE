/**
 * Offline retrieval benchmark: compares chunking/embedding strategies on the crawled data with a
 * golden question set, entirely in memory. Nothing is written to Atlas or .local/embedding.
 *
 *   pnpm eval:retrieval                       # all strategies
 *   pnpm eval:retrieval structure fixed-512   # only some
 *
 * Needs the Python embedding service. Strategies with ~3000-token chunks need it started with
 * EMBEDDING_MAX_SEQ_LENGTH=3200, otherwise the model silently reads only the first 1024 tokens.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { repositoryRoot } from '../crawler/config.js';
import { CrawlStore } from '../crawler/store.js';
import type { CrawlDocument } from '../crawler/types.js';
import { chunkDocument, embedTextOf, stripEmbeddedData } from '../embedding/chunker.js';
import { embeddingConfig } from '../embedding/config.js';
import { HttpEmbedder } from '../embedding/embedder.js';
import { CrawlStoreReader } from '../embedding/reader.js';

interface Golden {
  questions: { id: string; question: string; answers: string[] }[];
}
/** What a strategy produces: `text` is judged against the answers, `embedText` is embedded. */
interface EvalChunk {
  documentId: string;
  title: string;
  text: string;
  embedText: string;
}
type Strategy = { name: string; description: string; build: (doc: CrawlDocument) => EvalChunk[] };

const CHARS_PER_TOKEN = 3.4; // measured on this corpus with the model's tokenizer
const K = [1, 3, 5] as const;
const norm = (text: string) => text.replace(/\s+/gu, '').normalize('NFC').toLocaleLowerCase('vi');
const tokens = (text: string) => Math.round(text.length / CHARS_PER_TOKEN);

const fullText = (doc: CrawlDocument) =>
  doc.blocks
    .map((block) => stripEmbeddedData(block.text.normalize('NFC')).trim())
    .filter(Boolean)
    .join('\n');

/** Sliding window over the whole document, cut at whitespace. */
function windows(doc: CrawlDocument, size: number, overlap: number): EvalChunk[] {
  const text = fullText(doc);
  const out: EvalChunk[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > start + size / 2) end = space;
    }
    const piece = text.slice(start, end).trim();
    if (piece.length >= 40)
      out.push({
        documentId: doc.documentId,
        title: doc.title,
        text: piece,
        embedText: `${doc.title}\n\n${piece}`,
      });
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

/** Structure chunks merged while they share a chapter, up to `maxChars`. */
function grouped(doc: CrawlDocument, maxChars: number): EvalChunk[] {
  const out: EvalChunk[] = [];
  let group: ReturnType<typeof chunkDocument> = [];
  const flush = () => {
    if (!group.length) return;
    const text = group.map((chunk) => chunk.text).join('\n\n');
    const first = group[0];
    out.push({
      documentId: doc.documentId,
      title: doc.title,
      text,
      embedText: embedTextOf({ ...first, text }),
    });
    group = [];
  };
  for (const chunk of chunkDocument(doc)) {
    const chapter = (c: (typeof group)[number]) => c.headings.slice(0, -1).join('›');
    const size = group.reduce((sum, c) => sum + c.text.length, 0);
    if (
      group.length &&
      (chapter(group[0]) !== chapter(chunk) || size + chunk.text.length > maxChars)
    )
      flush();
    group.push(chunk);
  }
  flush();
  return out;
}

const strategies: Strategy[] = [
  {
    name: 'structure',
    description: 'Hiện tại: theo Chương/Điều/Khoản ~1200 ký tự, ghép tiêu đề',
    build: (doc) =>
      chunkDocument(doc).map((chunk) => ({
        documentId: doc.documentId,
        title: doc.title,
        text: chunk.text,
        embedText: embedTextOf(chunk),
      })),
  },
  {
    name: 'structure-no-header',
    description: 'Như trên nhưng KHÔNG ghép tiêu đề vào đoạn embed',
    build: (doc) =>
      chunkDocument(doc).map((chunk) => ({
        documentId: doc.documentId,
        title: doc.title,
        text: chunk.text,
        embedText: chunk.text,
      })),
  },
  {
    name: 'fixed-512',
    description: 'Cắt đều ~512 token, chồng 15%, ghép tên tài liệu',
    build: (doc) => windows(doc, 1750, 260),
  },
  {
    name: 'structure-3000',
    description: 'Gom các Điều cùng Chương tới ~3000 token, ghép tiêu đề',
    build: (doc) => grouped(doc, 10_000),
  },
  {
    name: 'fixed-3000',
    description: 'Cắt đều ~3000 token, chồng 10%, ghép tên tài liệu',
    build: (doc) => windows(doc, 10_000, 1000),
  },
];

const cacheDir = path.join(repositoryRoot, '.local/eval/cache');
async function embedAll(embedder: HttpEmbedder, model: string, texts: string[]) {
  const key = createHash('sha256').update(model).update(JSON.stringify(texts)).digest('hex');
  const file = path.join(cacheDir, `${key.slice(0, 24)}.json`);
  try {
    return { vectors: JSON.parse(await readFile(file, 'utf8')) as number[][], cached: true };
  } catch {
    /* not cached yet */
  }
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) {
    vectors.push(...(await embedder.embed(texts.slice(i, i + 16))));
    if (texts.length > 64)
      process.stdout.write(`\r  embedding ${Math.min(i + 16, texts.length)}/${texts.length}`);
  }
  if (texts.length > 64) process.stdout.write('\n');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, JSON.stringify(vectors));
  return { vectors, cached: false };
}

const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;

async function main() {
  const golden = JSON.parse(
    await readFile(path.join(repositoryRoot, 'eval/golden.json'), 'utf8'),
  ) as Golden;
  const wanted = process.argv.slice(2);
  const chosen = wanted.length ? strategies.filter((s) => wanted.includes(s.name)) : strategies;
  const embedder = new HttpEmbedder(embeddingConfig.serviceUrl, embeddingConfig.requestTimeoutMs);
  const info = await embedder.info();
  const model = `${info.model}@${info.revision}`;
  const maxSeq = (info as { maxSeqLength?: number }).maxSeqLength ?? 1024;

  const store = new CrawlStore();
  const reader = new CrawlStoreReader(store);
  const docs: CrawlDocument[] = [];
  for (const { documentId } of await reader.listLatest()) {
    const doc = await reader.get(documentId);
    if (doc && doc.quality !== 'index_only') docs.push(doc);
  }
  console.log(
    `${docs.length} tài liệu, ${golden.questions.length} câu hỏi, mô hình đọc tối đa ${maxSeq} token/đoạn\n`,
  );

  const queries = (
    await embedAll(
      embedder,
      model,
      golden.questions.map((q) => q.question),
    )
  ).vectors;
  const report: Record<string, unknown>[] = [];
  const perQuestion: Record<string, Record<string, number | null>> = {};

  for (const strategy of chosen) {
    const chunks = docs.flatMap(strategy.build);
    const sizes = chunks.map((chunk) => tokens(chunk.embedText));
    const truncated = sizes.filter((size) => size > maxSeq).length;
    console.log(`▶ ${strategy.name}: ${chunks.length} đoạn`);
    const started = performance.now();
    const { vectors, cached } = await embedAll(
      embedder,
      model,
      chunks.map((c) => c.embedText),
    );
    const embedSeconds = (performance.now() - started) / 1000;

    const ranks: (number | null)[] = [];
    const contextTokens: number[] = [];
    golden.questions.forEach((question, qi) => {
      const answers = question.answers.map(norm);
      const order = vectors
        .map((vector, i) => ({ i, score: dot(queries[qi], vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      const at = order.findIndex(({ i }) => answers.some((a) => norm(chunks[i].text).includes(a)));
      ranks.push(at < 0 ? null : at + 1);
      contextTokens.push(order.slice(0, 5).reduce((sum, { i }) => sum + tokens(chunks[i].text), 0));
      (perQuestion[question.id] ??= {})[strategy.name] = at < 0 ? null : at + 1;
    });
    const hit = (k: number) =>
      ranks.filter((rank) => rank !== null && rank <= k).length / ranks.length;
    const mrr = ranks.reduce<number>((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length;
    report.push({
      strategy: strategy.name,
      description: strategy.description,
      chunks: chunks.length,
      medianTokens: median(sizes),
      truncatedChunks: truncated,
      ...Object.fromEntries(K.map((k) => [`hit@${k}`, hit(k)])),
      mrr: Number(mrr.toFixed(3)),
      top5ContextTokens: Math.round(
        contextTokens.reduce((a, b) => a + b, 0) / contextTokens.length,
      ),
      embedSeconds: cached ? null : Math.round(embedSeconds),
    });
  }

  console.log('\nKẾT QUẢ (tìm đúng = đoạn chứa đáp án nằm trong top-k)\n');
  console.table(
    report.map((row) => ({
      'cách chunk': row.strategy,
      'số đoạn': row.chunks,
      'token/đoạn (trung vị)': row.medianTokens,
      'bị cắt cụt': row.truncatedChunks,
      'Hit@1': pct(row['hit@1'] as number),
      'Hit@3': pct(row['hit@3'] as number),
      'Hit@5': pct(row['hit@5'] as number),
      MRR: row.mrr,
      'token gửi LLM (top-5)': row.top5ContextTokens,
    })),
  );
  console.log('\nVỊ TRÍ ĐOẠN ĐÚNG THEO TỪNG CÂU (- = không có trong top-10)\n');
  console.table(
    Object.fromEntries(
      Object.entries(perQuestion).map(([id, row]) => [
        id,
        Object.fromEntries(Object.entries(row).map(([name, rank]) => [name, rank ?? '-'])),
      ]),
    ),
  );
  const out = path.join(repositoryRoot, '.local/eval/report.json');
  await writeFile(
    out,
    JSON.stringify({ model, maxSeq, at: new Date().toISOString(), report, perQuestion }, null, 2),
  );
  console.log(`\nĐã lưu chi tiết: ${out}`);
}

main().catch((error: Error) => {
  console.error('Lỗi:', error.message);
  process.exitCode = 1;
});
