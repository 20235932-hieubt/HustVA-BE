import type { CrawlDocument, DocumentSavedEvent } from '../crawler/types.js';

export type { DocumentSavedEvent };

/** Ingestion reads documents only through this, so the crawler store can become MongoDB later. */
export interface DocumentReader {
  get(documentId: string): Promise<CrawlDocument | null>;
  listLatest(): Promise<{ documentId: string; versionId: string }[]>;
}

export interface EmbedderInfo {
  model: string;
  revision: string;
  dimension: number;
}
export interface Embedder {
  info(): Promise<EmbedderInfo>;
  embed(texts: string[]): Promise<number[][]>;
}

/** Fields kept on every chunk so answers can be filtered by cohort and cite their source. */
export interface ChunkPayload {
  documentId: string;
  versionId: string;
  sourceId: string;
  url: string;
  parentUrl: string | null;
  title: string;
  mimeType: string;
  quality: CrawlDocument['quality'];
  issuedAt: string | null;
  academicYear: string | null;
  cohorts: string[];
  validityStatus: CrawlDocument['metadata']['validityStatus'];
}
export interface Chunk {
  /** UUID-shaped so the same id works as a Qdrant point id. */
  id: string;
  index: number;
  kind: 'text' | 'table';
  headings: string[];
  pageStart: number | null;
  pageEnd: number | null;
  /** Text shown to the user and the LLM. */
  text: string;
  /** Text sent to the embedding model: the passage with context such as the document title. */
  embedText: string;
  payload: ChunkPayload;
}
export interface StoredChunk extends Chunk {
  vector: number[];
}

export interface SearchFilter {
  sourceId?: string;
  /** Keeps chunks for this cohort plus chunks that name no cohort (general rules). */
  cohort?: string;
}
export interface SearchHit {
  score: number;
  chunk: Chunk;
}
/** Local JSON files today; Qdrant later. */
export interface VectorStore {
  /** Recorded in the index state, so switching stores re-embeds everything into the new one. */
  readonly name: string;
  replaceDocument(
    documentId: string,
    embeddingModel: string,
    dimension: number,
    chunks: StoredChunk[],
  ): Promise<void>;
  deleteDocument(documentId: string): Promise<void>;
  /** Chunks of one document in reading order (without vectors), or null when not indexed. */
  getChunks(documentId: string, embeddingModel: string): Promise<Chunk[] | null>;
  search(
    vector: number[],
    embeddingModel: string,
    options: { limit: number; filter?: SearchFilter },
  ): Promise<SearchHit[]>;
}

export type IndexStatus = 'pending' | 'indexed' | 'skipped' | 'failed';
export interface IndexState {
  documentId: string;
  versionId: string;
  status: IndexStatus;
  embeddingModel: string | null;
  chunkerVersion: string;
  /** Vector store the chunks were written to; missing on states written before 'atlas' existed. */
  store?: string;
  chunkCount: number;
  /** Failed attempts for this versionId; reset when the content changes. */
  attempts: number;
  error: string | null;
  updatedAt: string;
}
/** Plays the role of index_status until documents live in MongoDB. */
export interface IndexStateStore {
  get(documentId: string): Promise<IndexState | null>;
  set(state: IndexState): Promise<void>;
  list(): Promise<IndexState[]>;
}
