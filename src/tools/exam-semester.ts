import { z } from 'zod';
import type { ToolAccess } from '../auth/tool-access.js';
import { gradeSemesterSchema } from './grades.js';
import type { ToolResult } from './contracts.js';

export const examSemesterSelection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('code'), code: gradeSemesterSchema }),
  z.strictObject({ kind: z.literal('current') }),
  z.strictObject({ kind: z.literal('context'), code: gradeSemesterSchema }),
]);
export type ExamSemesterSelection = z.infer<typeof examSemesterSelection>;
export interface ToolBudget {
  maxToolCalls: number;
  maxToolRounds: number;
}
export interface ExamSemesterContext {
  code: string;
  establishedAt: Date;
  expiresAt: Date;
}
export function examSemesterFromContext(
  context: ExamSemesterContext | undefined,
  now = new Date(),
): string | undefined {
  if (
    !context ||
    !(context.establishedAt instanceof Date) ||
    !(context.expiresAt instanceof Date) ||
    context.establishedAt > now ||
    context.expiresAt <= now ||
    now.getTime() - context.establishedAt.getTime() > 30 * 60_000
  )
    return;
  const parsed = gradeSemesterSchema.safeParse(context.code);
  return parsed.success ? parsed.data : undefined;
}
const semestersSchema = z
  .array(
    z.object({
      semester: gradeSemesterSchema,
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

export type SemesterResolution =
  | { status: 'resolved'; semester: string }
  | {
      status: 'clarify' | 'summer' | 'budget';
      reasonCode: string;
      answer: string;
    };
interface SemesterTools {
  execute(
    id: string,
    args: unknown,
    signal?: AbortSignal,
    access?: ToolAccess,
  ): Promise<ToolResult>;
}
/** No extra model call. Both lookups share the caller's deadline and logical tool budget. */
export async function resolveExamSemester(
  selection: ExamSemesterSelection,
  tools: SemesterTools,
  signal: AbortSignal,
  access?: ToolAccess,
  budget: ToolBudget = { maxToolCalls: 6, maxToolRounds: 3 },
): Promise<SemesterResolution> {
  signal.throwIfAborted();
  const required = selection.kind === 'current' ? 2 : 1;
  if (budget.maxToolCalls < required || budget.maxToolRounds < required)
    return {
      status: 'budget',
      reasonCode: 'HUST_EXAMS_BUDGET',
      answer:
        'Lượt này chưa đủ ngân sách tra cứu lịch thi. Bạn cho biết mã học kỳ cụ thể hoặc thử lại sau nhé.',
    };
  let semester: string;
  if (selection.kind === 'current') {
    let result: ToolResult;
    try {
      result = await tools.execute('get_semesters', {}, signal, access);
    } catch {
      signal.throwIfAborted();
      return unknownSemester();
    }
    signal.throwIfAborted();
    const parsed = semestersSchema.safeParse(result.data);
    if (result.status !== 'success' || !parsed.success)
      return unknownSemester();
    const current = parsed.data.filter(
      (row) =>
        row.currentForClass === true ||
        row.currentForClass === 1 ||
        row.currentForClass === 'true',
    );
    if (current.length !== 1) return unknownSemester();
    semester = current[0].semester;
  } else {
    const parsed = gradeSemesterSchema.safeParse(selection.code);
    if (!parsed.success) return unknownSemester();
    semester = parsed.data;
  }
  if (semester.endsWith('3'))
    return {
      status: 'summer',
      reasonCode: 'HUST_EXAMS_SUMMER_UNSUPPORTED',
      answer: `API lịch thi HUST chưa hỗ trợ học kỳ hè (${semester}). Mình chưa thể tra lịch thi kỳ này; bạn kiểm tra trên cổng thông tin chính thức nhé.`,
    };
  return { status: 'resolved', semester };
}
function unknownSemester(): SemesterResolution {
  return {
    status: 'clarify',
    reasonCode: 'HUST_EXAM_SEMESTER_REQUIRED',
    answer:
      'Mình chưa xác định được học kỳ cần tra lịch thi. Bạn cung cấp mã học kỳ cụ thể giúp mình nhé.',
  };
}
