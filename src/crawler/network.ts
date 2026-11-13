import { lookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import ipaddr from 'ipaddr.js';
import { createRequire } from 'node:module';
import { Agent, fetch } from 'undici';
import type { Fetcher, HttpResult, Source } from './types.js';

export class CrawlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function allowedUrl(value: string, hosts: string[]): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.includes(url.hostname)
  )
    throw new CrawlError('URL_POLICY', 'URL nằm ngoài nguồn HTTPS cho phép');
  if (/\/(?:login|users|admin|oauth|cong-no)(?:[/?]|$)/iu.test(url.pathname))
    throw new CrawlError('URL_POLICY', 'Không crawl trang đăng nhập hoặc dữ liệu riêng');
  url.hash = '';
  return url;
}
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 4);
      return;
    }
    if (!addresses.length || addresses.some((address) => !isPublicAddress(address.address))) {
      callback(
        Object.assign(new Error('DNS không trỏ hoàn toàn tới IP công khai'), { code: 'EACCES' }),
        '',
        4,
      );
      return;
    }
    const chosen =
      addresses.find((address) => !options.family || address.family === options.family) ??
      addresses[0];
    if (options.all) {
      // Node's net lookup callback type omits its all:true overload.
      (callback as unknown as (error: null, values: typeof addresses) => void)(null, addresses);
    } else callback(null, chosen.address, chosen.family);
  });
};
const previous = new Map<string, number>();
interface RobotRules {
  isAllowed(url: string, agent: string): boolean | undefined;
  getCrawlDelay(agent: string): number | undefined;
}
const robotsParser = createRequire(import.meta.url)('robots-parser') as (
  url: string,
  text: string,
) => RobotRules;
type Rules = { missing: boolean; parser: RobotRules | null; delayMs: number };
export class PublicFetcher implements Fetcher {
  private readonly dispatcher = new Agent({ connect: { lookup: publicLookup }, connections: 1 });
  private readonly rules = new Map<string, Rules>();
  constructor(
    private readonly source: Source,
    private readonly signal?: AbortSignal,
  ) {}
  async close(): Promise<void> {
    await this.dispatcher.close();
  }
  private async raw(value: string, maxBytes: number, isRobots = false): Promise<HttpResult> {
    let url = allowedUrl(value, this.source.hosts);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!isRobots) await this.checkRobots(url);
      const interval = Math.max(
        this.source.adapter === 'library' ? 10_000 : 1100,
        this.rules.get(url.origin)?.delayMs ?? 1100,
      );
      const wait = (previous.get(url.origin) ?? 0) + interval - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal: this.signal });
      previous.set(url.origin, Date.now());
      const signal = this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000);
      const response = await fetch(url, {
        dispatcher: this.dispatcher,
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': 'HustVACrawler/0.1 (student knowledge sources; bounded local runs)',
          accept: 'text/html,application/pdf,text/plain;q=0.8',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new CrawlError('REDIRECT', 'Redirect thiếu địa chỉ đích');
        url = allowedUrl(new URL(location, url).href, this.source.hosts);
        continue;
      }
      if ([429, 500, 502, 503, 504].includes(response.status)) {
        const retry = response.headers.get('retry-after');
        await response.body?.cancel();
        let retryMs =
          retry && /^\d+$/u.test(retry)
            ? Number(retry) * 1000
            : retry
              ? Date.parse(retry) - Date.now()
              : 0;
        retryMs = Math.max(0, retryMs || 0);
        if (retryMs > 60_000)
          throw new CrawlError('RETRY_LATER', 'Máy chủ yêu cầu đợi lâu; thử lượt crawl khác sau');
        previous.set(url.origin, Date.now() + retryMs);
        throw new CrawlError('TRANSIENT', `HTTP ${response.status}, sẽ thử lại trong giới hạn`);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > maxBytes)
          throw new CrawlError('SIZE_LIMIT', 'Tài liệu vượt giới hạn dung lượng');
        chunks.push(chunk);
      }
      return {
        url: url.href,
        status: response.status,
        mime: response.headers.get('content-type')?.split(';')[0].trim() ?? '',
        bytes: Buffer.concat(chunks),
        fetchedAt: new Date().toISOString(),
      };
    }
    throw new CrawlError('REDIRECT', 'Quá 5 lần chuyển hướng');
  }
  private async checkRobots(url: URL): Promise<void> {
    let rules = this.rules.get(url.origin);
    if (!rules) {
      const response = await this.raw(`${url.origin}/robots.txt`, 1024 * 1024, true);
      const text = Buffer.from(response.bytes).toString('utf8');
      if ([404, 410].includes(response.status))
        rules = { missing: true, parser: null, delayMs: 1100 };
      else if (response.status >= 200 && response.status < 300 && !/<html[\s>]/iu.test(text)) {
        const parser = robotsParser(response.url, text);
        rules = {
          missing: false,
          parser,
          delayMs: Math.max(1100, (parser.getCrawlDelay('HustVACrawler') ?? 0) * 1000),
        };
      } else
        throw new CrawlError(
          'ROBOTS_UNKNOWN',
          'Chưa xác minh robots.txt hợp lệ, nguồn được tạm dừng',
        );
      this.rules.set(url.origin, rules);
    }
    if (!rules.missing && rules.parser?.isAllowed(url.href, 'HustVACrawler') === false)
      throw new CrawlError('ROBOTS_DENIED', 'robots.txt không cho phép đường dẫn này');
  }
  async get(url: string, kind: 'html' | 'pdf' = 'html'): Promise<HttpResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.raw(url, kind === 'pdf' ? 25 * 1024 * 1024 : 2 * 1024 * 1024);
        if (result.status !== 200) throw new CrawlError('HTTP_STATUS', `HTTP ${result.status}`);
        return result;
      } catch (error) {
        const retryable = !(error instanceof CrawlError) || error.code === 'TRANSIENT';
        if (!retryable || attempt === 2 || this.signal?.aborted) throw error;
        await delay(1000 * 2 ** attempt, undefined, { signal: this.signal });
      }
    }
    throw new Error('Không thể tải nội dung');
  }
}
