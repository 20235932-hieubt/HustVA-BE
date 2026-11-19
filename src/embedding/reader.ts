import { hash, type CrawlStore } from '../crawler/store.js';
import type { CrawlDocument } from '../crawler/types.js';
import type { DocumentReader } from './types.js';

/**
 * Attachments are often titled by their link text ("tại đây", "Tải file tại đây"), which tells
 * neither the model nor the student which regulation or year the passage belongs to.
 */
const GENERIC_TITLE =
  /^[\s\-–•.:]*(?:xem\s+)?(?:chi\s+tiết\s+)?(?:tải\s+(?:file|về|xuống)\s*)?(?:tại|ở)\s+đây[\s.:!]*$|^[\s\-–•]*(?:tải\s+(?:file|về|xuống)|download|file\s+đính\s+kèm|đính\s+kèm)[\s.:!]*$/iu;
export const isGenericTitle = (title: string): boolean =>
  !title.trim() || GENERIC_TITLE.test(title.normalize('NFC'));

/** MVP: reads the crawler's local files. Replace with a MongoDB or Document Access API reader. */
export class CrawlStoreReader implements DocumentReader {
  constructor(private readonly store: CrawlStore) {}
  async get(documentId: string): Promise<CrawlDocument | null> {
    const document = await this.store.getDocument(documentId);
    if (!document?.parentUrl || !isGenericTitle(document.title))
      return document;
    // Same id scheme as the crawler (crawler/extract.ts): hash of source id and URL.
    const parent = await this.store.getDocument(
      hash(`${document.sourceId}\n${document.parentUrl}`),
    );
    return parent && !isGenericTitle(parent.title)
      ? { ...document, title: parent.title }
      : document;
  }
  async listLatest(): Promise<{ documentId: string; versionId: string }[]> {
    return (await this.store.documents()).map(({ documentId, versionId }) => ({
      documentId,
      versionId,
    }));
  }
}
