import { reply, type ChatResult } from '../chat/contracts.js';
import type { ToolAccess } from '../auth/tool-access.js';
import type { ChatTools } from './chat.js';
import type { ToolBudget } from './exam-semester.js';
import {
  resolveResearchLookup,
  type ResearchLookupState,
  type ResearchRequest,
} from './research-lookup.js';
import {
  escapeResearchText as escape,
  type ResearchTopic,
} from './research-topics.js';
import { logger } from '../observability/logger.js';

const short = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}… [đã rút gọn]` : text;
export function renderResearchTopics(
  topics: ResearchTopic[],
  target: string,
): string {
  const intro = `### Đề tài của ${escape(short(target, 220))}\n\nNguồn: HUST Partner API. Có **${topics.length} đề tài** trong dữ liệu trả về. Danh sách theo đối tượng, chưa lọc lĩnh vực hoặc đánh giá mức phù hợp cá nhân.`;
  const sections = [intro];
  let shown = 0;
  for (const topic of topics.slice(0, 10)) {
    const fields: [string, unknown][] = [
      ['Số sinh viên theo nguồn', topic.studentNum],
      ['Đơn vị', topic.departmentName],
      ['Mã ngành', topic.programIds?.join(', ')],
      ['Loại theo nguồn', topic.types?.join(', ')],
      ['Mã loại đề tài', topic.topicType],
      ['Mã loại thực tập', topic.internType],
      ['Trạng thái nguồn', topic.status],
    ];
    const facts = fields
      .filter(([, v]) => v != null && v !== '')
      .map(
        ([label, value]) =>
          `**${label}:** ${escape(short(String(value), 220))}`,
      )
      .join(' · ');
    const section = `### ${shown + 1}. ${escape(short(topic.title, 220))}\n\n${escape(short(topic.description || 'Chưa có mô tả trong dữ liệu nguồn.', 1600))}${facts ? `\n\n${facts}` : ''}`;
    if (sections.join('\n\n').length + section.length > 8500) break;
    sections.push(section);
    shown++;
  }
  sections.push(
    `Hiển thị ${shown}/${topics.length} đề tài. Số sinh viên không khẳng định số chỗ còn trống; mã trạng thái không tự quy đổi thành đang tuyển hoặc đã đóng.${shown < topics.length ? ' Danh sách chưa hiển thị toàn bộ; hãy thu hẹp đối tượng tra cứu.' : ''}`,
  );
  return sections.join('\n\n');
}

export async function runResearchTool(
  request: ResearchRequest,
  tools: ChatTools,
  signal: AbortSignal,
  options: {
    previous?: ResearchLookupState;
    budget?: ToolBudget;
    expiresAt?: Date;
    access?: ToolAccess;
    save: (state: ResearchLookupState) => Promise<void>;
  },
): Promise<ChatResult> {
  const response = (
    status: ChatResult['status'],
    answer: string,
    code: string,
  ): ChatResult => ({
    ...reply(status, answer, code),
    retrievalMode: 'hust_api',
  });
  try {
    const outcome = await resolveResearchLookup(
      request,
      tools,
      signal,
      options.previous,
      options.access,
      options.budget,
      options.expiresAt,
    );
    signal.throwIfAborted();
    if (outcome.status === 'clarify')
      return response(
        'needs_clarification',
        'Bạn cung cấp tên đầy đủ giảng viên/công ty hoặc chọn lại từ danh sách mới nhất nhé. Lựa chọn cũ có thể chưa rõ hoặc đã hết hạn.',
        outcome.reasonCode,
      );
    if (outcome.status === 'unavailable') {
      logger.warn('hust.tool.unavailable', {
        tool:
          request.kind === 'teacher'
            ? 'get_teacher_research_topics'
            : 'get_company_research_topics',
        status: 'error',
        errorCode: outcome.reasonCode,
      });
      const answer =
        outcome.reasonCode === 'HUST_TOPICS_DISABLED'
          ? 'Tính năng tra cứu đề tài này đang tắt.'
          : outcome.reasonCode === 'HUST_TOPICS_BUDGET'
            ? 'Lượt này chưa đủ ngân sách tra cứu đề tài. Bạn thử lại sau nhé.'
            : 'Hiện chưa lấy được dữ liệu đề tài từ HUST. Bạn thử lại sau nhé.';
      return response('insufficient_evidence', answer, outcome.reasonCode);
    }
    await options.save(outcome.state);
    signal.throwIfAborted();
    if (outcome.status === 'selection') {
      const choices = outcome.state.candidates
        .map(
          (candidate, index) =>
            `${index + 1}. **${escape(short(candidate.label, 180))}**${candidate.unit ? ` — ${escape(short(candidate.unit, 120))}` : ''}`,
        )
        .join('\n');
      return response(
        'needs_clarification',
        `Tìm thấy ${outcome.state.total} đối tượng. Bạn chọn đúng người/đơn vị để tra đề tài nhé:\n\n${choices}${outcome.state.total > 10 ? '\n\nChỉ hiển thị 10 đối tượng đầu; bạn có thể cung cấp tên cụ thể hơn.' : ''}`,
        'HUST_TOPIC_TARGET_AMBIGUOUS',
      );
    }
    if (outcome.status === 'empty')
      return response(
        'insufficient_evidence',
        `Đã tra **${escape(short(outcome.target.label, 220))}** nhưng HUST chưa trả đề tài. Điều này không có nghĩa là giảng viên/công ty không nhận sinh viên.`,
        'HUST_TOPICS_EMPTY',
      );
    return response(
      'answered',
      renderResearchTopics(outcome.topics ?? [], outcome.target.label),
      'HUST_TOPICS_RESULT',
    );
  } catch {
    signal.throwIfAborted();
    return response(
      'insufficient_evidence',
      'Chưa hoàn tất tra cứu đề tài. Bạn thử lại sau nhé.',
      'HUST_TOPICS_UNAVAILABLE',
    );
  }
}
