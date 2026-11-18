import type { z } from 'zod';
import { EmbedderUnavailableError } from '../embedding/embedder.js';
import type { Chunk, SearchFilter, SearchHit } from '../embedding/types.js';
import type {
  Evidence,
  KnowledgePort,
  KnowledgeResult,
  SearchScope,
  searchSchema,
  sectionSchema,
} from './stub.js';

/** The part of the embedding pipeline that retrieval needs. */
export interface Retriever {
  search(query: string, limit: number, filter?: SearchFilter): Promise<SearchHit[]>;
  chunks(documentId: string): Promise<Chunk[] | null>;
}

export interface RagConfig {
  /** Hits below this cosine score are treated as unrelated. */
  minScore: number;
  /** Characters of passage text sent to the model per tool call (graph caps tool output at 8000). */
  textBudget: number;
}
export function readRagConfig(env: NodeJS.ProcessEnv = process.env): RagConfig {
  const minScore = Number(env.RAG_MIN_SCORE ?? 0.45);
  return {
    minScore: Number.isFinite(minScore) && minScore >= 0 && minScore < 1 ? minScore : 0.45,
    textBudget: 5000,
  };
}

const REVIEW_WARNING =
  'Một số đoạn trích từ PDF hoặc trang chưa được duyệt; cần đối chiếu bản gốc trước khi dùng làm căn cứ chính thức.';
const MAX_REFS = 5000;

const locationOf = (chunk: Chunk): string => {
  const pages =
    chunk.pageStart === null
      ? ''
      : chunk.pageStart === chunk.pageEnd
        ? `trang ${chunk.pageStart}`
        : `trang ${chunk.pageStart}-${chunk.pageEnd}`;
  return [chunk.headings.join(' › '), pages].filter(Boolean).join(', ');
};

/**
 * Retrieval over the embedded crawl data: the "R" and "A" of RAG for the ReAct agent.
 * Evidence ids are chunk ids; `read` only expands ids this process has handed out, and the
 * graph additionally checks they were granted in the current turn.
 */
export class RagKnowledge implements KnowledgePort {
  /** chunk id → where it lives, for read_document_section. Bounded, oldest dropped first. */
  private readonly refs = new Map<string, { documentId: string; index: number }>();

  constructor(
    private readonly retriever: Retriever,
    private readonly config: RagConfig = readRagConfig(),
  ) {}

  private remember(chunk: Chunk): void {
    this.refs.delete(chunk.id);
    this.refs.set(chunk.id, { documentId: chunk.payload.documentId, index: chunk.index });
    if (this.refs.size > MAX_REFS) this.refs.delete(this.refs.keys().next().value!);
  }

  private evidence(chunks: { chunk: Chunk; score?: number }[]): Evidence[] {
    const each = Math.floor(this.config.textBudget / Math.max(chunks.length, 1));
    return chunks.map(({ chunk, score }) => {
      this.remember(chunk);
      return {
        id: chunk.id,
        text: chunk.text.length > each ? `${chunk.text.slice(0, each - 1)}…` : chunk.text,
        isMock: false,
        title: chunk.payload.title,
        url: chunk.payload.url,
        documentId: chunk.payload.documentId,
        versionId: chunk.payload.versionId,
        location: locationOf(chunk),
        quality: chunk.payload.quality,
        score: score === undefined ? undefined : Number(score.toFixed(3)),
      };
    });
  }

  private result(evidence: Evidence[]): KnowledgeResult {
    return {
      status: evidence.length ? 'results' : 'empty',
      evidence,
      warnings: evidence.some((item) => item.quality !== 'accepted') ? [REVIEW_WARNING] : [],
    };
  }

  async search(
    input: z.infer<typeof searchSchema>,
    signal: AbortSignal,
    scope: SearchScope = {},
  ): Promise<KnowledgeResult> {
    signal.throwIfAborted();
    let hits: SearchHit[];
    try {
      // Over-fetch: the same PDF can be crawled under two sources, and duplicates are removed below.
      hits = await this.retriever.search(input.query, input.limit * 3, {
        sourceId: input.sourceId,
        cohort: scope.cohort?.toUpperCase(),
      });
    } catch (error) {
      if (error instanceof EmbedderUnavailableError)
        return {
          status: 'unavailable',
          evidence: [],
          warnings: ['Dịch vụ embedding chưa sẵn sàng; chưa tra cứu được kho tài liệu.'],
        };
      throw error;
    }
    signal.throwIfAborted();
    const seen = new Set<string>();
    const picked = hits.filter(({ score, chunk }) => {
      const key = chunk.text.replace(/\s+/gu, ' ').trim();
      if (score < this.config.minScore || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return this.result(this.evidence(picked.slice(0, input.limit)));
  }

  async read(input: z.infer<typeof sectionSchema>, signal: AbortSignal): Promise<KnowledgeResult> {
    signal.throwIfAborted();
    const ref = this.refs.get(input.evidenceId);
    if (!ref)
      return { status: 'not_granted', evidence: [], warnings: ['evidenceId không hợp lệ.'] };
    const chunks = await this.retriever.chunks(ref.documentId);
    signal.throwIfAborted();
    const at = chunks?.findIndex((chunk) => chunk.id === input.evidenceId) ?? -1;
    if (!chunks || at < 0)
      return {
        status: 'empty',
        evidence: [],
        warnings: ['Tài liệu đã được cập nhật; hãy tìm kiếm lại.'],
      };
    // The passage plus its neighbours: the clause before and after usually completes the rule.
    return this.result(
      this.evidence(chunks.slice(Math.max(0, at - 1), at + 2).map((chunk) => ({ chunk }))),
    );
  }
}
