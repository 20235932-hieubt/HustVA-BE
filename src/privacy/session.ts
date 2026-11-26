import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes } from 'node:crypto';
import { ChatError, type StudentContext } from '../chat/contracts.js';

export const privacyVersion = 'hmac-projection-v1';
const tokenPattern = /\[\[PII_(?:EMAIL|PHONE|ID|NAME)_[a-f0-9]{32}\]\]/gu;
type Kind = 'EMAIL' | 'PHONE' | 'ID' | 'NAME';
const active = new AsyncLocalStorage<PrivacySession>();
const fold = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gu, 'd')
    .replace(/Đ/gu, 'D')
    .toLowerCase();
const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .trim();

// Capitalised phrases that are places, institutions or document headings, not people.
// Without this, crawled titles and answers lose words like "Hà Nội" to the name detector.
const publicPhraseStart =
  /^(?:dai hoc|truong|phong|ban|khoa|vien|trung tam|bo|so|quy dinh|quy che|thong bao|quyet dinh|huong dan|ke hoach|chuong|dieu|muc|phu luc|hoc bong|hoc ky|chuong trinh|bach khoa|cong hoa|doc lap|thu vien|ky tuc xa|ta quang buu)\b/u;
const publicPlaces = new Set([
  'ha noi',
  'viet nam',
  'thanh pho ho chi minh',
  'ho chi minh',
  'da nang',
  'hai phong',
  'can tho',
]);
// Capitalised words that often open a sentence; stripped before treating the rest as a name.
const leadingWords =
  /^(?:(?:Theo|Trong|Tại|Với|Về|Từ|Khi|Nếu|Để|Cho|Các|Những|Mỗi|Bạn|Mình|Em|Tôi|Thầy|Cô|Giảng viên|Sinh viên|Học viên|Ông|Bà|Anh|Chị)\s+)+/u;
const isPublicPhrase = (value: string) => {
  const folded = fold(value).replace(/\s+/gu, ' ').trim();
  return publicPlaces.has(folded) || publicPhraseStart.test(folded);
};

// Public business vocabulary, not user-provided strings. Unrecognized text is
// deliberately omitted, even when the local PII detector fails to recognize it.
const topics = [
  ['học bổng', /hoc bong|scholarship/u],
  ['học phí', /hoc phi|mien giam|tuition/u],
  ['rèn luyện', /ren luyen/u],
  ['xác nhận sinh viên', /xac nhan sinh vien|giay xac nhan/u],
  ['bảo lưu', /bao luu/u],
  ['ký túc xá', /ky tuc xa|\bktx\b/u],
  ['thư viện', /thu vien|library/u],
  ['bảo hiểm', /bao hiem|\bbhyt\b/u],
  ['học vụ', /hoc vu|dang ky hoc|tin chi|bang diem|tot nghiep/u],
  [
    'dịch vụ sinh viên',
    /dich vu sinh vien|cong tac sinh vien|ho tro sinh vien/u,
  ],
] as const;
const actions = [
  ['điều kiện', /dieu kien|tieu chi/u],
  ['thủ tục', /thu tuc|quy trinh|cac buoc/u],
  ['hồ sơ', /ho so|giay to|bieu mau/u],
  ['thời hạn', /thoi han|deadline|han nop/u],
  ['so sánh', /so sanh|khac nhau/u],
] as const;

export class PrivacySession {
  #key: Buffer;
  #values = new Map<string, string>();
  #disposed = false;
  #sealed = false;

  constructor(capability?: string, scope = '') {
    this.#key = capability
      ? createHmac('sha256', capability)
          .update(JSON.stringify(['hustva-privacy-v1', scope]))
          .digest()
      : randomBytes(32);
  }
  #digest(domain: string, value: string) {
    if (this.#disposed)
      throw new ChatError(
        503,
        'PRIVACY_SESSION_CLOSED',
        'Phiên bảo vệ dữ liệu đã đóng.',
      );
    return createHmac('sha256', this.#key)
      .update(JSON.stringify([domain, value]))
      .digest('hex');
  }
  fingerprint(value: unknown) {
    return `${privacyVersion}:${this.#digest('request', JSON.stringify(value))}`;
  }
  #token(kind: Kind, value: string) {
    const identity =
      kind === 'PHONE'
        ? value.replace(/[ .()-]/gu, '').replace(/^\+84/u, '0')
        : normalize(value).toLocaleLowerCase('vi');
    const token = `[[PII_${kind}_${this.#digest(kind, identity).slice(0, 32)}]]`;
    if (!this.#values.has(token)) {
      if (this.#sealed) return '[thông tin đã ẩn]';
      if (this.#values.size >= 128)
        throw new ChatError(
          400,
          'PRIVACY_ENTITY_LIMIT',
          'Quá nhiều định danh trong một lượt; hãy chia nhỏ câu hỏi.',
        );
      this.#values.set(token, value);
    }
    return token;
  }
  pseudonymize(value: string): string {
    if (this.#disposed)
      throw new ChatError(
        503,
        'PRIVACY_SESSION_CLOSED',
        'Phiên bảo vệ dữ liệu đã đóng.',
      );
    // Scan original spans once: later regexes must never interpret a numeric
    // substring of a hash as a phone/ID, or merge two generated placeholders.
    return normalize(value)
      .split(/(\[\[PII_(?:EMAIL|PHONE|ID|NAME)_[a-f0-9]{32}\]\])/gu)
      .map((part) => {
        if (/^\[\[PII_(?:EMAIL|PHONE|ID|NAME)_[a-f0-9]{32}\]\]$/u.test(part))
          return this.#values.has(part) ? part : '[ĐỊNH_DANH_KHÔNG_HỢP_LỆ]';
        const spans: {
          start: number;
          end: number;
          kind: Kind;
          value: string;
        }[] = [];
        const collect = (pattern: RegExp, kind: Kind, group = 0) => {
          for (const match of part.matchAll(pattern)) {
            let value = match[group];
            let offset = 0;
            if (kind === 'NAME') {
              // A capitalised sentence opener ("Theo", "Sinh viên") is not part of a name.
              const lead = value.match(leadingWords);
              if (lead) {
                offset = lead[0].length;
                value = value.slice(offset);
                if (!/\s/u.test(value.trim())) continue;
              }
              if (isPublicPhrase(value)) continue;
            }
            const start =
              match.index! +
              offset +
              (group ? match[0].length - match[group].length : 0);
            const end = start + value.length;
            if (!spans.some((span) => start < span.end && end > span.start))
              spans.push({ start, end, kind, value });
          }
        };
        collect(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu, 'EMAIL');
        collect(
          /(?:mssv|mã\s*(?:số\s*)?sinh\s*viên|ma\s*(?:so\s*)?sinh\s*vien|cccd|cmnd|số tài khoản|so tai khoan)\s*[:=]?\s*([a-z0-9-]{6,})/giu,
          'ID',
          1,
        );
        collect(/(?<![\p{L}\d])(?:\+84|0)(?:[ .-]?\d){9,10}(?!\d)/gu, 'PHONE');
        collect(/(?<![\p{L}\d])\d{7,20}(?![\p{L}\d])/gu, 'ID');
        // Best effort only. Lowercase/unrecognized names are also omitted by project().
        // Title-case words only: all-caps runs are document headings, not names.
        collect(
          /(?<!\p{L})\p{Lu}[\p{Ll}\p{M}]*(?:[ \t]+\p{Lu}[\p{Ll}\p{M}]*){1,5}(?!\p{L})/gu,
          'NAME',
        );
        let cursor = 0;
        let output = '';
        for (const span of spans.sort((a, b) => a.start - b.start)) {
          output +=
            part.slice(cursor, span.start) + this.#token(span.kind, span.value);
          cursor = span.end;
        }
        return output + part.slice(cursor);
      })
      .join('');
  }
  references(text: string): string[] {
    return [...new Set(text.match(tokenPattern) ?? [])].filter((token) =>
      this.#values.has(token),
    );
  }
  owns(token: string) {
    return this.#values.has(token);
  }
  seal() {
    this.#sealed = true;
  }
  project(text: string): string {
    const masked = this.pseudonymize(text);
    const value = fold(text);
    const selectedTopics = topics
      .filter(([, rule]) => rule.test(value))
      .map(([label]) => label);
    const selectedActions = actions
      .filter(([, rule]) => rule.test(value))
      .map(([label]) => label);
    return JSON.stringify({
      privacy: privacyVersion,
      topics: selectedTopics,
      actions: selectedActions,
      entities: this.references(masked),
    });
  }
  hasTopic(text: string) {
    return topics.some(([, rule]) => rule.test(fold(text)));
  }
  restore(text: string): string {
    // Single pass, exact membership only. Never recursively interpret a restored value.
    return text.replace(
      tokenPattern,
      (token) => this.#values.get(token) ?? '[thông tin đã ẩn]',
    );
  }
  dispose() {
    this.#values.clear();
    this.#key.fill(0);
    this.#disposed = true;
  }
}

export function withPrivacy<T>(session: PrivacySession, work: () => T): T {
  return active.run(session, work);
}
export function currentPrivacy(): PrivacySession {
  const externalTracing = [
    'LANGSMITH_TRACING',
    'LANGCHAIN_TRACING_V2',
    'LANGCHAIN_TRACING',
  ].some((name) => {
    const value = process.env[name]?.trim().toLowerCase();
    return (
      value && (name === 'LANGCHAIN_TRACING' || !['false', '0'].includes(value))
    );
  });
  if (externalTracing)
    throw new ChatError(
      503,
      'EXTERNAL_TRACING_DISABLED',
      'Bỏ cấu hình tracing bên ngoài trước khi dùng luồng chat riêng tư.',
    );
  const session = active.getStore();
  if (!session)
    throw new ChatError(
      503,
      'PRIVACY_CONTEXT_REQUIRED',
      'Không có lớp bảo vệ dữ liệu cho lời gọi bên ngoài.',
    );
  return session;
}

export function publicContext(input: StudentContext): StudentContext {
  const result: StudentContext = {};
  if (input.cohort) {
    const match = /^K([2-9]\d)$/iu.exec(input.cohort.trim());
    if (!match)
      throw new ChatError(
        400,
        'CONTEXT_UNSAFE',
        'Khóa chỉ nhận mã nhóm công khai dạng K69.',
      );
    result.cohort = `K${Number(match[1])}`;
  }
  if (input.academicYear) {
    const match = /^(20\d{2})-(20\d{2})$/u.exec(input.academicYear);
    if (!match || Number(match[2]) !== Number(match[1]) + 1)
      throw new ChatError(
        400,
        'CONTEXT_UNSAFE',
        'Năm học phải có dạng 2026-2027.',
      );
    result.academicYear = `${Number(match[1])}-${Number(match[2])}`;
  }
  if (input.program) {
    const programs: Record<string, string> = {
      chuan: 'chuẩn',
      'chuong trinh chuan': 'chuẩn',
      standard: 'chuẩn',
      cttt: 'tiên tiến',
      'tien tien': 'tiên tiến',
      'chuong trinh tien tien': 'tiên tiến',
      clc: 'chất lượng cao',
      'chat luong cao': 'chất lượng cao',
      'chuong trinh chat luong cao': 'chất lượng cao',
    };
    const key = fold(normalize(input.program));
    const program = Object.hasOwn(programs, key) ? programs[key] : undefined;
    if (!program)
      throw new ChatError(
        400,
        'CONTEXT_UNSAFE',
        'Chương trình chỉ nhận chuẩn, tiên tiến hoặc chất lượng cao; không gửi thông tin cá nhân.',
      );
    result.program = program;
  }
  return result;
}
