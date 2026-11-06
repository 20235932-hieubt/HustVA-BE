export type Quality = 'accepted' | 'needs_review' | 'index_only';
export interface Block {
  id: string;
  type: 'heading' | 'paragraph' | 'list_item' | 'table' | 'pdf_page';
  text: string;
  page?: number;
  rows?: string[][];
  cells?: { text: string; rowSpan: number; colSpan: number }[][];
}
export interface CrawlDocument {
  schemaVersion: 'hustva.document.v1';
  documentId: string;
  versionId: string;
  sourceId: string;
  url: string;
  parentUrl: string | null;
  title: string;
  text: string;
  blocks: Block[];
  links?: { url: string; title: string; kind: 'pdf' | 'page' | 'image' | 'file' }[];
  contentHash: string;
  rawHash: string;
  extractorVersion: string;
  mimeType: string;
  fetchedAt: string;
  updatedAt: string;
  firstSeenAt: string;
  quality: Quality;
  warnings: string[];
  metadata: {
    language: 'vi';
    publishedAt: string | null;
    issuedAt: string | null;
    academicYear: string | null;
    cohorts: string[];
    validityStatus: 'unknown';
  };
}
export interface CrawlTarget {
  url: string;
  parentUrl: string | null;
  title?: string;
  kind: 'html' | 'pdf';
}
export interface PageResult {
  url: string;
  status: 'saved' | 'unchanged' | 'discovered' | 'failed' | 'skipped';
  message: string;
  documentId?: string;
  versionId?: string;
  kind?: 'html' | 'pdf';
  rawHash?: string;
  errorCode?: string;
}
export interface CrawlRun {
  id: string;
  sourceId: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  pending: CrawlTarget[];
  results: PageResult[];
  stopReason: string | null;
  cancelRequested: boolean;
}
export interface Source {
  id: string;
  name: string;
  description: string;
  adapter: 'ctt' | 'hust' | 'sdh' | 'library';
  seeds: string[];
  hosts: string[];
}
export interface HttpResult {
  url: string;
  status: number;
  mime: string;
  bytes: Uint8Array;
  fetchedAt: string;
}
export interface Fetcher {
  get(url: string, kind?: 'html' | 'pdf'): Promise<HttpResult>;
  close?(): Promise<void>;
}
