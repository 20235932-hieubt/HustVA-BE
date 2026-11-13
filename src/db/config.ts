export class DatabaseConfigError extends Error {}

export interface MongoConfig {
  uri: string;
  dbName: string;
  vectorIndexName: string;
  embeddingDimension?: number;
  similarity: 'cosine' | 'euclidean' | 'dotProduct';
}

export function readMongoConfig(env: NodeJS.ProcessEnv = process.env): MongoConfig {
  const uri = env.MONGODB_URI?.trim();
  if (!uri || !/^mongodb(?:\+srv)?:\/\//u.test(uri))
    throw new DatabaseConfigError('Cần MONGODB_URI hợp lệ trong .env.');
  const dbName = env.MONGODB_DB_NAME?.trim() || 'hustva_dev';
  if (!/^[a-zA-Z0-9_-]+$/u.test(dbName))
    throw new DatabaseConfigError('MONGODB_DB_NAME chỉ nhận chữ, số, dấu gạch ngang và gạch dưới.');
  const vectorIndexName = env.MONGODB_VECTOR_INDEX?.trim() || 'knowledge_vector_v1';
  if (!/^[a-zA-Z0-9_-]+$/u.test(vectorIndexName))
    throw new DatabaseConfigError('MONGODB_VECTOR_INDEX không hợp lệ.');
  const rawDimension = env.EMBEDDING_DIMENSION?.trim();
  let embeddingDimension: number | undefined;
  if (rawDimension) {
    embeddingDimension = Number(rawDimension);
    if (!/^\d+$/u.test(rawDimension) || embeddingDimension < 1 || embeddingDimension > 8192)
      throw new DatabaseConfigError('EMBEDDING_DIMENSION phải là số nguyên từ 1 đến 8192.');
  }
  const similarity = env.EMBEDDING_SIMILARITY?.trim() || 'cosine';
  if (!['cosine', 'euclidean', 'dotProduct'].includes(similarity))
    throw new DatabaseConfigError(
      'EMBEDDING_SIMILARITY phải là cosine, euclidean hoặc dotProduct.',
    );
  return {
    uri,
    dbName,
    vectorIndexName,
    embeddingDimension,
    similarity: similarity as MongoConfig['similarity'],
  };
}
