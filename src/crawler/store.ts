import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { defaultDataDir } from './config.js';
import { getSource } from './sources.js';
import { readableDocuments } from './report.js';
import type { CrawlDocument, CrawlRun } from './types.js';

export const hash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
const validKey = /^[a-f0-9-]{16,64}$/u;
export function checkKey(id: string): string {
  if (!validKey.test(id)) throw new Error('ID không hợp lệ');
  return id;
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function files(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export class CrawlStore {
  constructor(public readonly directory = defaultDataDir) {}
  private file(folder: string, id: string): string {
    return path.join(this.directory, folder, `${checkKey(id)}.json`);
  }
  async init(): Promise<void> {
    await Promise.all(
      ['runs', 'latest', 'versions', 'artifacts', 'locks'].map((folder) =>
        mkdir(path.join(this.directory, folder), { recursive: true }),
      ),
    );
  }
  async createRun(sourceId: string): Promise<CrawlRun> {
    const source = getSource(sourceId);
    await this.init();
    const lock = path.join(this.directory, 'locks', `${source.id}.lock`);
    let handle;
    try {
      handle = await open(lock, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('Nguồn này đã có một lượt crawl đang chờ hoặc chạy');
      throw error;
    }
    try {
      const runs = await this.listRuns();
      if (
        runs.some((run) => run.sourceId === sourceId && ['queued', 'running'].includes(run.status))
      )
        throw new Error('Nguồn này đã có một lượt crawl đang chờ hoặc chạy');
      const now = new Date().toISOString();
      const run: CrawlRun = {
        id: randomUUID(),
        sourceId,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        pending: source.seeds.map((url) => ({ url, parentUrl: null, kind: 'html' })),
        results: [],
        stopReason: null,
        cancelRequested: false,
      };
      await this.saveRun(run);
      return run;
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }
  async saveRun(run: CrawlRun): Promise<void> {
    run.updatedAt = new Date().toISOString();
    await atomicJson(this.file('runs', run.id), run);
  }
  async getRun(id: string): Promise<CrawlRun | null> {
    const run = await readJson<CrawlRun>(this.file('runs', id));
    return run ? { ...run, cancelRequested: await this.cancelled(id) } : null;
  }
  async listRuns(): Promise<CrawlRun[]> {
    const runs = await Promise.all(
      (await files(path.join(this.directory, 'runs'))).map((file) =>
        readJson<CrawlRun>(path.join(this.directory, 'runs', file)),
      ),
    );
    return runs
      .filter((run): run is CrawlRun => run !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async cancelRun(id: string): Promise<void> {
    const run = await this.getRun(id);
    if (!run) throw new Error('Không tìm thấy lượt crawl');
    // Separate flag cannot be overwritten by a crawl checkpoint.
    await atomicJson(path.join(this.directory, 'runs', `${checkKey(id)}.cancel`), {
      requestedAt: new Date().toISOString(),
    });
  }
  async cancelled(id: string): Promise<boolean> {
    return (
      (await stat(path.join(this.directory, 'runs', `${checkKey(id)}.cancel`)).catch(
        () => null,
      )) !== null
    );
  }
  async saveArtifact(bytes: Uint8Array): Promise<string> {
    const checksum = hash(bytes);
    const file = path.join(this.directory, 'artifacts', checksum);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: 'wx' }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return checksum;
  }
  async getArtifact(checksum: string): Promise<Buffer> {
    return readFile(path.join(this.directory, 'artifacts', checkKey(checksum)));
  }
  private versionFile(id: string, version: string): string {
    return path.join(this.directory, 'versions', checkKey(id), `${checkKey(version)}.json`);
  }
  async saveDocument(document: CrawlDocument): Promise<'saved' | 'unchanged'> {
    const previous = await this.getDocument(document.documentId);
    const existing = await readJson<CrawlDocument>(
      this.versionFile(document.documentId, document.versionId),
    );
    document.firstSeenAt = previous?.firstSeenAt ?? document.fetchedAt;
    if (!existing)
      await atomicJson(this.versionFile(document.documentId, document.versionId), document);
    const stored = existing ?? document;
    if (previous?.versionId !== stored.versionId) {
      await atomicJson(this.file('latest', document.documentId), {
        versionId: stored.versionId,
        changedAt: new Date().toISOString(),
      });
      return 'saved';
    }
    return 'unchanged';
  }
  async getDocument(id: string, version?: string): Promise<CrawlDocument | null> {
    const pointer = await readJson<{ versionId: string; changedAt: string }>(
      this.file('latest', id),
    );
    const versionId = version ?? pointer?.versionId;
    if (!versionId) return null;
    const document = await readJson<CrawlDocument & { review?: unknown }>(
      this.versionFile(id, versionId),
    );
    if (!document) return null;
    delete document.review; // Ignore the retired review field in existing local data.
    return {
      ...document,
      updatedAt: pointer?.versionId === versionId ? pointer.changedAt : document.fetchedAt,
    };
  }
  async documents(runId?: string): Promise<CrawlDocument[]> {
    const references = runId
      ? ((await this.getRun(runId))?.results
          .filter((result) => result.documentId && result.versionId)
          .map((result) => ({ id: result.documentId!, version: result.versionId! })) ?? [])
      : (await files(path.join(this.directory, 'latest'))).map((file) => ({
          id: file.slice(0, -5),
          version: undefined,
        }));
    const unique = [
      ...new Map(references.map((ref) => [`${ref.id}/${ref.version ?? 'latest'}`, ref])).values(),
    ];
    const documents = await Promise.all(unique.map((ref) => this.getDocument(ref.id, ref.version)));
    return documents
      .filter((document): document is CrawlDocument => document !== null)
      .sort((a, b) => a.documentId.localeCompare(b.documentId));
  }
  async exportDocuments(runId?: string): Promise<CrawlDocument[]> {
    return this.documents(runId);
  }
  async refreshExports(runId?: string): Promise<void> {
    const exportDir = path.join(this.directory, 'exports');
    await mkdir(exportDir, { recursive: true });
    const scopes = runId
      ? [runId, undefined]
      : [...(await this.listRuns()).map((run) => run.id), undefined];
    for (const scope of scopes) {
      const documents = await this.exportDocuments(scope);
      const destination = path.join(exportDir, `${scope ?? 'latest'}.jsonl`);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        documents.map((document) => JSON.stringify(document)).join('\n') +
          (documents.length ? '\n' : ''),
      );
      await rename(temporary, destination);
      const readableFile = path.join(exportDir, `${scope ?? 'latest'}.txt`);
      const readableTemporary = `${readableFile}.${randomUUID()}.tmp`;
      await writeFile(readableTemporary, readableDocuments(await this.documents(scope)));
      await rename(readableTemporary, readableFile);
    }
  }
  async acquireCrawler(): Promise<() => Promise<void>> {
    await this.init();
    const lock = path.join(this.directory, 'crawler.lock');
    try {
      const handle = await open(lock, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        await unlink(lock).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(lock, 'utf8'));
      let alive = true;
      try {
        if (pid > 0) process.kill(pid, 0);
        else alive = false;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
      if (alive) throw new Error('Một API khác đang crawl trong thư mục này');
      await unlink(lock);
      return this.acquireCrawler();
    }
  }
}
