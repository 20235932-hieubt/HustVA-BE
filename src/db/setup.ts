import { MongoServerError, type Db, type Document } from 'mongodb';
import type { MongoConfig } from './config.js';

export class DatabaseSetupError extends Error {}
export const collections = {
  documents: 'knowledge_documents',
  chunks: 'knowledge_chunks',
  ingestions: 'ingestion_runs',
} as const;

interface VectorField {
  type: string;
  path: string;
  numDimensions?: number;
  similarity?: string;
}

export function vectorDefinition(config: MongoConfig): { fields: VectorField[] } {
  if (!config.embeddingDimension)
    throw new DatabaseSetupError('Chưa cấu hình số chiều embedding; chưa thể tạo vector index.');
  return {
    fields: [
      {
        type: 'vector',
        path: 'embedding',
        numDimensions: config.embeddingDimension,
        similarity: config.similarity,
      },
      { type: 'filter', path: 'sourceId' },
      { type: 'filter', path: 'indexVersion' },
    ],
  };
}

// Never rebuild an existing index silently, especially after changing embedding models.
export function assertCompatibleVectorIndex(index: Document, config: MongoConfig): void {
  const definition = (index.latestDefinition ?? index.definition) as
    { fields?: VectorField[] } | undefined;
  const expected = vectorDefinition(config);
  const fields = definition?.fields;
  const vectorFields = fields?.filter((field) => field.type === 'vector') ?? [];
  if (
    index.type !== 'vectorSearch' ||
    vectorFields.length !== 1 ||
    !expected.fields.every((field) =>
      fields?.some(
        (stored) =>
          stored.type === field.type &&
          stored.path === field.path &&
          (field.type !== 'vector' ||
            (stored.numDimensions === field.numDimensions &&
              stored.similarity === field.similarity)),
      ),
    )
  )
    throw new DatabaseSetupError(
      'Vector index hiện có khác cấu hình. Dùng tên index/phiên bản embedding mới; không tự xóa hoặc ghi đè index cũ.',
    );
}

export async function inspectVectorIndex(db: Db, config: MongoConfig): Promise<Document | null> {
  const exists = await db
    .listCollections({ name: collections.chunks }, { nameOnly: true })
    .hasNext();
  if (!exists) return null;
  const indexes = await db
    .collection(collections.chunks)
    .listSearchIndexes(config.vectorIndexName)
    .toArray();
  const index: Document | undefined = indexes[0];
  if (index) assertCompatibleVectorIndex(index, config);
  return index ?? null;
}

export function isVectorIndexReady(index: Document): boolean {
  // An old definition may remain queryable while its replacement is still building.
  return index.status === 'READY' && index.queryable === true;
}

export async function setupKnowledgeDatabase(db: Db, config: MongoConfig) {
  // Validate the existing vector definition before making changes to other resources.
  const previousIndex = config.embeddingDimension ? await inspectVectorIndex(db, config) : null;
  for (const name of Object.values(collections)) {
    try {
      await db.createCollection(name);
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 48)) throw error;
    }
  }
  await db
    .collection(collections.documents)
    .createIndex({ sourceId: 1 }, { name: 'document_source' });
  await db
    .collection(collections.chunks)
    .createIndex(
      { documentId: 1, versionId: 1, indexVersion: 1, chunkIndex: 1 },
      { name: 'chunk_version_position', unique: true },
    );
  await db
    .collection(collections.ingestions)
    .createIndex({ createdAt: -1 }, { name: 'ingestion_created' });

  if (!config.embeddingDimension) return { vector: 'skipped' as const };
  if (previousIndex)
    return {
      vector: isVectorIndexReady(previousIndex) ? ('ready' as const) : ('building' as const),
    };
  await db.collection(collections.chunks).createSearchIndex({
    name: config.vectorIndexName,
    type: 'vectorSearch',
    definition: vectorDefinition(config),
  });
  return { vector: 'created' as const };
}
