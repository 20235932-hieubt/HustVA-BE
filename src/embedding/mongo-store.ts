import {
  MongoNetworkError,
  MongoServerSelectionError,
  type Collection,
  type Db,
  type Document,
} from 'mongodb';
import { collections } from '../db/setup.js';
import { CHUNKER_VERSION } from './config.js';
import { EmbedderUnavailableError } from './embedder.js';
import type {
  Chunk,
  ChunkPayload,
  SearchFilter,
  SearchHit,
  StoredChunk,
  VectorStore,
} from './types.js';

/** Stored in `knowledge_chunks`; `_id` is the chunk id (UUID-shaped, stable per document version). */
interface ChunkDoc {
  _id: string;
  documentId: string;
  versionId: string;
  /** Model + chunker: search only compares vectors produced the same way. */
  indexVersion: string;
  chunkIndex: number;
  sourceId: string;
  /** Cohorts the chunk applies to, or ['*'] for general rules. Vector Search filters cannot test
   *  for an empty array, so "no cohort" is stored as a value that every query includes. */
  cohortScope: string[];
  quality: ChunkPayload['quality'];
  kind: Chunk['kind'];
  headings: string[];
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  embedText: string;
  payload: ChunkPayload;
  embedding: number[];
  updatedAt: Date;
}

const ALL_COHORTS = '*';

/** The cluster cannot be reached: retried later like a stopped embedding service. */
function unavailable(error: unknown): never {
  if (error instanceof MongoNetworkError || error instanceof MongoServerSelectionError)
    throw new EmbedderUnavailableError('Không kết nối được MongoDB Atlas để lưu/tìm vector');
  throw error;
}

const toChunk = (doc: ChunkDoc): Chunk => ({
  id: doc._id,
  index: doc.chunkIndex,
  kind: doc.kind,
  headings: doc.headings,
  pageStart: doc.pageStart,
  pageEnd: doc.pageEnd,
  text: doc.text,
  embedText: doc.embedText,
  payload: doc.payload,
});

/**
 * Chunks and vectors in MongoDB Atlas (`knowledge_chunks`) plus one summary per document
 * (`knowledge_documents`). Search uses Atlas Vector Search; run `pnpm db:setup` once with
 * EMBEDDING_DIMENSION set so the vector index exists.
 */
export class MongoVectorStore implements VectorStore {
  readonly name = 'atlas';
  private readonly chunks: Collection<ChunkDoc>;
  private readonly documents: Collection<Document>;

  constructor(
    db: Db,
    private readonly options: { vectorIndex: string; dimension: number },
  ) {
    this.chunks = db.collection<ChunkDoc>(collections.chunks);
    this.documents = db.collection(collections.documents);
  }

  private indexVersion(embeddingModel: string): string {
    return `${CHUNKER_VERSION}|${embeddingModel}`;
  }

  async replaceDocument(
    documentId: string,
    embeddingModel: string,
    dimension: number,
    stored: StoredChunk[],
  ): Promise<void> {
    if (dimension !== this.options.dimension)
      throw new Error(
        `Vector ${dimension} chiều khác EMBEDDING_DIMENSION=${this.options.dimension} của vector index`,
      );
    const indexVersion = this.indexVersion(embeddingModel);
    const now = new Date();
    try {
      // Upsert the new chunks first, then drop the old ones, so search never sees the document
      // missing; for a moment it may see both versions, which the RAG layer de-duplicates.
      if (stored.length)
        await this.chunks.bulkWrite(
          stored.map(({ vector, ...chunk }) => ({
            replaceOne: {
              filter: { _id: chunk.id },
              upsert: true,
              replacement: {
                documentId,
                versionId: chunk.payload.versionId,
                indexVersion,
                chunkIndex: chunk.index,
                sourceId: chunk.payload.sourceId,
                cohortScope: chunk.payload.cohorts.length
                  ? chunk.payload.cohorts.map((cohort) => cohort.toUpperCase())
                  : [ALL_COHORTS],
                quality: chunk.payload.quality,
                kind: chunk.kind,
                headings: chunk.headings,
                pageStart: chunk.pageStart,
                pageEnd: chunk.pageEnd,
                text: chunk.text,
                embedText: chunk.embedText,
                payload: chunk.payload,
                embedding: vector,
                updatedAt: now,
              },
            },
          })),
          { ordered: false },
        );
      await this.chunks.deleteMany({ documentId, _id: { $nin: stored.map((chunk) => chunk.id) } });
      const payload = stored[0]?.payload;
      if (!payload) {
        await this.documents.deleteOne({ _id: documentId as never });
        return;
      }
      await this.documents.replaceOne(
        { _id: documentId as never },
        {
          sourceId: payload.sourceId,
          versionId: payload.versionId,
          title: payload.title,
          url: payload.url,
          parentUrl: payload.parentUrl,
          mimeType: payload.mimeType,
          quality: payload.quality,
          cohorts: payload.cohorts,
          academicYear: payload.academicYear,
          issuedAt: payload.issuedAt,
          validityStatus: payload.validityStatus,
          indexVersion,
          embeddingModel,
          chunkCount: stored.length,
          updatedAt: now,
        },
        { upsert: true },
      );
    } catch (error) {
      unavailable(error);
    }
  }

  async deleteDocument(documentId: string): Promise<void> {
    try {
      await this.chunks.deleteMany({ documentId });
      await this.documents.deleteOne({ _id: documentId as never });
    } catch (error) {
      unavailable(error);
    }
  }

  async getChunks(documentId: string, embeddingModel: string): Promise<Chunk[] | null> {
    try {
      const docs = await this.chunks
        .find(
          { documentId, indexVersion: this.indexVersion(embeddingModel) },
          { projection: { embedding: 0 } },
        )
        .sort({ chunkIndex: 1 })
        .toArray();
      return docs.length ? docs.map(toChunk) : null;
    } catch (error) {
      unavailable(error);
    }
  }

  async search(
    vector: number[],
    embeddingModel: string,
    options: { limit: number; filter?: SearchFilter },
  ): Promise<SearchHit[]> {
    if (vector.length !== this.options.dimension) return [];
    const filter: Document = { indexVersion: this.indexVersion(embeddingModel) };
    if (options.filter?.sourceId) filter.sourceId = options.filter.sourceId;
    if (options.filter?.cohort)
      filter.cohortScope = { $in: [options.filter.cohort.toUpperCase(), ALL_COHORTS] };
    try {
      const docs = await this.chunks
        .aggregate<ChunkDoc & { score: number }>([
          {
            $vectorSearch: {
              index: this.options.vectorIndex,
              path: 'embedding',
              queryVector: vector,
              numCandidates: Math.max(100, options.limit * 20),
              limit: options.limit,
              filter,
            },
          },
          { $project: { embedding: 0 } },
          { $addFields: { score: { $meta: 'vectorSearchScore' } } },
        ])
        .toArray();
      // Atlas reports cosine as (1 + cos) / 2; convert back so RAG_MIN_SCORE means the same
      // thing for the local and the Atlas store.
      return docs.map((doc) => ({ score: doc.score * 2 - 1, chunk: toChunk(doc) }));
    } catch (error) {
      unavailable(error);
    }
  }
}
