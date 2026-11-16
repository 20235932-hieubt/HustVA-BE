import type { CrawlStore } from '../crawler/store.js';
import type { CrawlDocument } from '../crawler/types.js';
import type { DocumentReader } from './types.js';

/** MVP: reads the crawler's local files. Replace with a MongoDB or Document Access API reader. */
export class CrawlStoreReader implements DocumentReader {
  constructor(private readonly store: CrawlStore) {}
  get(documentId: string): Promise<CrawlDocument | null> {
    return this.store.getDocument(documentId);
  }
  async listLatest(): Promise<{ documentId: string; versionId: string }[]> {
    return (await this.store.documents()).map(({ documentId, versionId }) => ({
      documentId,
      versionId,
    }));
  }
}
