import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const defaultDataDir = path.resolve(
  process.env.CRAWL_DATA_DIR ?? path.join(repositoryRoot, '.local/crawler'),
);
