import type { ToolAccess } from '../auth/tool-access.js';
import { z } from 'zod';
import { reply, type ChatResult } from '../chat/contracts.js';

import type { ToolResult } from './contracts.js';
import { isGradeTool, renderGrades } from './grades.js';
import { logger } from '../observability/logger.js';

export interface ChatTools {
  execute(
    id: string,
    input: unknown,
    signal?: AbortSignal,
    access?: ToolAccess,
  ): Promise<ToolResult>;
}
export interface ToolPlan {
  id: string;
  arguments: Record<string, unknown>;
  clarification?: string;
  currentSemester?: boolean;
}

// Field allowlists prevent unexpected upstream fields from entering answers/history.
const label = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
      !/\[\[|https?:|mongodb(?:\+srv)?:|AIza|(?:api[_ -]?(?:key|token)|password|mật khẩu)\s*[:=]/iu.test(
        value,
      ),
  );
const scalar = z.union([z.number().finite(), label]);
const semesterSchema = z
  .array(
    z.object({
      semester: z.string().regex(/^\d{4}[123]$/u),
      currentForClass: z
        .union([
          z.boolean(),
          z.literal(0),
          z.literal(1),
          z.literal('true'),
          z.literal('false'),
        ])
        .optional(),
    }),
  )
  .max(200);
const conditionsSchema = z.object({
  kscs: z
    .object({ project: scalar.optional(), credit: scalar.optional() })
    .optional(),
  ths: z
    .object({ cpa: scalar.optional(), status: scalar.optional() })
    .optional(),
});
const advancedSchema = z.object({
  programName: label.optional(),
  majorName: label.optional(),
  toProgramNames: z.array(label).max(200),
});
const teacherSchema = z
  .array(
    z.object({ fullName: label, schoolName: label.nullish().catch(undefined) }),
  )
  .max(1000);
const companySchema = z
  .array(
    z
      .object({ fullName: label.optional(), displayName: label.optional() })
      .refine((row) => Boolean(row.fullName || row.displayName)),
  )
  .max(1000);
const numberOrText = (value: unknown) =>
  value === undefined ? 'chưa có thông tin' : String(value);

function semesterLabel(code: string): string {
  const year = Number(code.slice(0, 4));
  const term = code.endsWith('3') ? 'học kỳ hè' : `học kỳ ${code.at(-1)}`;
  return `${term}, năm học ${year}–${year + 1} (mã ${code})`;
}

function render(plan: ToolPlan, data: unknown): string | undefined {
  if (isGradeTool(plan.id)) return renderGrades(data);
  switch (plan.id) {
    case 'get_semesters': {
      const parsed = semesterSchema.safeParse(data);
      if (!parsed.success || !parsed.data.length) return;
      if (plan.currentSemester) {
        const current = parsed.data.filter((row) =>
          [true, 1, 'true'].includes(row.currentForClass ?? false),
        );
        return current.length === 1
          ? `Hiện tại là ${semesterLabel(current[0].semester)}.`
          : 'Mình chưa xác định được học kỳ hiện tại. Bạn có thể kiểm tra lại trên cổng thông tin của trường nhé.';
      }
      return `Danh sách học kỳ:\n${parsed.data.map((row) => `- ${semesterLabel(row.semester)}`).join('\n')}`;
    }
    case 'get_study_conditions': {
      const parsed = conditionsSchema.safeParse(data);
      if (!parsed.success) return;
      const { kscs, ths } = parsed.data;
      if (!kscs && !ths) return;
      return `Thông tin về điều kiện học tiếp:\n\nKỹ sư chuyên sâu:\n- Yêu cầu về đồ án: ${numberOrText(kscs?.project)}.\n- Số tín chỉ: ${numberOrText(kscs?.credit)}.\n\nThạc sĩ:\n- Điểm trung bình tích lũy (CPA): ${numberOrText(ths?.cpa)}.\n\nBạn nên xác nhận thêm với đơn vị đào tạo để biết đầy đủ điều kiện áp dụng cho mình nhé.`;
    }
    case 'get_advanced_programs': {
      const parsed = advancedSchema.safeParse(data);
      if (!parsed.success) return;
      if (!parsed.data.toProgramNames.length)
        return 'Mình chưa tìm thấy chương trình kỹ sư chuyên sâu cho ngành này. Bạn kiểm tra lại mã ngành giúp mình nhé.';
      return `Với ngành ${String(plan.arguments.programId)}, bạn có thể tham khảo các chương trình kỹ sư chuyên sâu sau:\n${parsed.data.toProgramNames
        .slice(0, 20)
        .map((name) => `- ${name}`)
        .join(
          '\n',
        )}${parsed.data.toProgramNames.length > 20 ? '\nChỉ hiển thị 20 chương trình đầu tiên.' : ''}`;
    }
    case 'search_teachers': {
      const parsed = teacherSchema.safeParse(data);
      if (!parsed.success || !parsed.data.length) return;
      return `Mình tìm thấy ${parsed.data.length} giảng viên phù hợp${parsed.data.length > 10 ? '. Dưới đây là 10 kết quả đầu tiên' : ''}:\n${parsed.data
        .slice(0, 10)
        .map(
          (row) =>
            `- ${row.fullName}${row.schoolName ? ` — ${row.schoolName}` : ''}`,
        )
        .join('\n')}`;
    }
    case 'search_companies': {
      const parsed = companySchema.safeParse(data);
      if (!parsed.success || !parsed.data.length) return;
      return `Mình tìm thấy ${parsed.data.length} công ty phù hợp${parsed.data.length > 10 ? '. Dưới đây là 10 kết quả đầu tiên' : ''}:\n${parsed.data
        .slice(0, 10)
        .map((row) => `- ${row.displayName ?? row.fullName}`)
        .join('\n')}`;
    }
  }
}

export async function runChatTool(
  plan: ToolPlan,
  tools: ChatTools,
  signal: AbortSignal,
  access?: ToolAccess,
): Promise<ChatResult> {
  const response = (
    status: ChatResult['status'],
    answer: string,
    reason: string,
  ): ChatResult => ({
    ...reply(status, answer, reason),
    retrievalMode: 'hust_api',
    warnings: [],
  });
  if (plan.clarification)
    return response(
      'needs_clarification',
      plan.clarification,
      'HUST_ARGUMENT_REQUIRED',
    );
  signal.throwIfAborted();
  let result: ToolResult;
  try {
    result = await tools.execute(plan.id, plan.arguments, signal, access);
  } catch {
    signal.throwIfAborted();
    return response(
      'insufficient_evidence',
      'Hiện mình chưa tra cứu được thông tin này. Bạn thử lại sau một chút nhé.',
      'HUST_TOOL_ERROR',
    );
  }
  signal.throwIfAborted();
  if (result.status === 'empty')
    return response(
      'insufficient_evidence',
      isGradeTool(plan.id)
        ? 'HUST chưa trả dữ liệu điểm cho yêu cầu này. Điều này không có nghĩa là điểm bằng 0 hoặc chưa đăng ký học.'
        : plan.id.startsWith('search_')
          ? 'Mình chưa tìm thấy kết quả phù hợp. Bạn thử nhập tên hoặc từ khóa khác nhé.'
          : 'Mình chưa tìm thấy thông tin này. Bạn thử lại sau nhé.',
      'HUST_TOOL_EMPTY',
    );
  if (result.status !== 'success') {
    logger.warn('hust.tool.unavailable', {
      tool: plan.id,
      status: result.status,
      errorCode: result.errorCode ?? 'HUST_TOOL_UNAVAILABLE',
      durationMs: result.durationMs,
    });
    const answers: Partial<Record<ToolResult['status'], string>> = {
      disabled: 'Tính năng tra cứu này đang tạm ngừng. Bạn thử lại sau nhé.',
      not_configured:
        'Tính năng tra cứu này chưa sẵn sàng. Bạn thử lại sau nhé.',
      timeout:
        'Tra cứu đang mất nhiều thời gian hơn bình thường. Bạn thử lại sau một chút nhé.',
      busy: 'Hiện có nhiều người đang tra cứu. Bạn thử lại sau một chút nhé.',
    };
    return response(
      'insufficient_evidence',
      answers[result.status] ??
        'Hiện mình chưa tra cứu được thông tin này. Bạn thử lại sau một chút nhé.',
      'HUST_TOOL_UNAVAILABLE',
    );
  }
  const answer = render(plan, result.data);
  if (!answer || answer.length > 10000)
    return response(
      'insufficient_evidence',
      'Mình chưa có thông tin đủ rõ để trả lời chính xác. Bạn thử lại sau nhé.',
      'HUST_DATA_INVALID',
    );
  return response('answered', answer, 'HUST_TOOL_RESULT');
}
