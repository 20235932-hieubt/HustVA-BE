import path from 'node:path';
import { repositoryRoot } from '../crawler/config.js';

const number = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const embeddingConfig = {
  enabled: process.env.EMBEDDING_ENABLED !== 'false',
  dataDir: path.resolve(
    process.env.EMBEDDING_DATA_DIR ?? path.join(repositoryRoot, '.local/embedding'),
  ),
  serviceUrl: (process.env.EMBEDDING_SERVICE_URL ?? 'http://127.0.0.1:8001').replace(/\/+$/u, ''),
  batchSize: number(process.env.EMBEDDING_BATCH_SIZE, 16),
  requestTimeoutMs: number(process.env.EMBEDDING_TIMEOUT_MS, 300_000),
  reconcileIntervalMs: number(process.env.EMBEDDING_RECONCILE_INTERVAL_MS, 5 * 60_000),
  maxAttempts: 5,
  /** `atlas`: chunks and vectors go to MongoDB Atlas (knowledge_chunks) and search uses Atlas
   *  Vector Search. `local`: JSON files under dataDir. Index state stays local either way. */
  store: (process.env.EMBEDDING_STORE?.trim() === 'atlas' ? 'atlas' : 'local') as 'atlas' | 'local',
};

/** Bump when chunking changes so reconcile re-embeds every document. */
export const CHUNKER_VERSION = 'blocks-v4';
