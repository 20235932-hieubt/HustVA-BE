import { readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, checkKey } from '../crawler/store.js';
import type {
  IndexState,
  IndexStateStore,
  SearchFilter,
  SearchHit,
  StoredChunk,
  VectorStore,
} from './types.js';

interface VectorFile {
  documentId: string;
  embeddingModel: string;
  dimension: number;
  chunks: StoredChunk[];
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function jsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

const matches = (chunk: Pick<StoredChunk, 'payload'>, filter: SearchFilter = {}): boolean =>
  (!filter.sourceId || chunk.payload.sourceId === filter.sourceId) &&
  (!filter.cohort ||
    !chunk.payload.cohorts.length ||
    chunk.payload.cohorts.includes(filter.cohort));

/**
 * One JSON file per document under <dir>/vectors. Replacing the file swaps every chunk of the
 * document at once, so search never sees half of an old and half of a new version.
 * Search is a brute-force dot product (vectors are normalised), fine for a few thousand chunks.
 * Swap for Qdrant behind the same VectorStore interface when the data grows.
 */
export class LocalVectorStore implements VectorStore {
  private cache: Map<string, VectorFile> | null = null;
  constructor(private readonly directory: string) {}
  private file(documentId: string): string {
    return path.join(this.directory, 'vectors', `${checkKey(documentId)}.json`);
  }
  private async load(): Promise<Map<string, VectorFile>> {
    if (this.cache) return this.cache;
    const dir = path.join(this.directory, 'vectors');
    const entries = await Promise.all(
      (await jsonFiles(dir)).map((file) => readJson<VectorFile>(path.join(dir, file))),
    );
    this.cache = new Map(
      entries.filter((entry): entry is VectorFile => entry !== null).map((e) => [e.documentId, e]),
    );
    return this.cache;
  }
  async replaceDocument(
    documentId: string,
    embeddingModel: string,
    dimension: number,
    chunks: StoredChunk[],
  ): Promise<void> {
    const entry: VectorFile = { documentId, embeddingModel, dimension, chunks };
    await atomicJson(this.file(documentId), entry);
    this.cache?.set(documentId, entry);
  }
  async deleteDocument(documentId: string): Promise<void> {
    await unlink(this.file(documentId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.cache?.delete(documentId);
  }
  async search(
    vector: number[],
    embeddingModel: string,
    options: { limit: number; filter?: SearchFilter },
  ): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    for (const entry of (await this.load()).values()) {
      // Vectors from another model live in a different space; never compare them.
      if (entry.embeddingModel !== embeddingModel || entry.dimension !== vector.length) continue;
      for (const { vector: stored, ...chunk } of entry.chunks) {
        if (!matches(chunk, options.filter)) continue;
        let score = 0;
        for (let i = 0; i < vector.length; i++) score += vector[i] * stored[i];
        hits.push({ score, chunk });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, options.limit);
  }
}

/** One JSON file per document under <dir>/state. */
export class LocalIndexStateStore implements IndexStateStore {
  constructor(private readonly directory: string) {}
  private file(documentId: string): string {
    return path.join(this.directory, 'state', `${checkKey(documentId)}.json`);
  }
  get(documentId: string): Promise<IndexState | null> {
    return readJson<IndexState>(this.file(documentId));
  }
  async set(state: IndexState): Promise<void> {
    await atomicJson(this.file(state.documentId), state);
  }
  async list(): Promise<IndexState[]> {
    const dir = path.join(this.directory, 'state');
    const states = await Promise.all(
      (await jsonFiles(dir)).map((file) => readJson<IndexState>(path.join(dir, file))),
    );
    return states.filter((state): state is IndexState => state !== null);
  }
}
