import type { ToolAccess } from '../auth/tool-access.js';
import { z } from 'zod';
import { ChatError, reply, type ChatResult } from '../chat/contracts.js';

import type { ToolResult } from './contracts.js';
import { isGradeTool, renderGrades } from './grades.js';
import { logger } from '../observability/logger.js';
import type { ExamSemesterSelection } from './exam-semester.js';
import { resolveExamSemester, type ToolBudget } from './exam-semester.js';
import { renderExams } from './exams.js';
import { authorizeStudentData } from '../auth/tool-access.js';
import type { ResearchRequest } from './research-lookup.js';

export interface ChatTools {
  isEnabled?(id: string): Promise<boolean>;
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
  /** The question is about another person; answer with a refusal, do not call the tool. */
  refusal?: boolean;
  /** Parts of the student profile the question asks about; undefined means all of them. */
  fields?: ProfileField[];
  examSemester?: ExamSemesterSelection;
  /** Resolved locally, never forwarded to upstream or model. */
  studentId?: string;
  upcomingExams?: boolean;
  research?: ResearchRequest;
}

export const profileFields = [
  'identity',
  'class',
  'program',
  'status',
  'advisor',
  'cpa',
  'gpa',
  'credits',
  'warning',
] as const;
export type ProfileField = (typeof profileFields)[number];

/**
 * Fields named in the question, by keyword. Used when the model leaves `fields` empty, so
 * "CPA của tôi" shows the CPA only; a general profile question matches nothing (= all).
 */
export function profileFieldsIn(question: string): ProfileField[] {
  const text = question
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gu, 'd')
    .replace(/Đ/gu, 'D')
    .toLowerCase();
  const rules: [ProfileField, RegExp][] = [
    ['cpa', /\bcpa\b|trung binh tich luy|diem tich luy/u],
    ['gpa', /\bgpa\b|trung binh (?:hoc )?ky/u],
    // Not a bare "tin": "thông tin" would match.
    [
      'credits',
      /tin chi|bao nhieu tin\b|\bso tin\b|\btin (?:tich luy|dang ky)/u,
    ],
    ['warning', /canh bao|canh cao/u],
    ['advisor', /co van|\bcvht\b/u],
    ['class', /\blop\b/u],
    // Not "vien": every "sinh viên" would match.
    ['program', /nganh|chuong trinh|\bkhoa\b|\btruong\b/u],
    ['status', /trang thai|tinh trang|con (?:dang )?hoc|bao luu|thoi hoc/u],
    ['identity', /ho ten|ho va ten|\bten\b|\bmssv\b|ma (?:so )?sinh vien/u],
  ];
  const fields = rules.filter(([, rule]) => rule.test(text)).map(([f]) => f);
  // "Tình trạng học tập" covers standing as well as enrolment status.
  if (/tinh trang hoc tap|ket qua hoc tap/u.test(text))
    fields.push('cpa', 'gpa', 'credits', 'warning');
  return [...new Set(fields)];
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
// Only academic fields; birthdate, gender, phone and personal email are never shown.
const profileSchema = z.object({
  studentId: z.union([z.string(), z.number()]).optional(),
  fullName: label.nullish().catch(undefined),
  studentClass: label.nullish().catch(undefined),
  program: label.nullish().catch(undefined),
  programCode: label.nullish().catch(undefined),
  school: label.nullish().catch(undefined),
  status: label.nullish().catch(undefined),
  teachers: z
    .array(
      z.object({
        fullName: label.nullish().catch(undefined),
        email: label.nullish().catch(undefined),
      }),
    )
    .max(10)
    .nullish()
    .catch(undefined),
});
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
  options?: {
    budget?: ToolBudget;
    onExamSemester?: (semester: string) => void;
  },
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
  if (plan.refusal)
    return response(
      'blocked',
      'Bạn chỉ có thể tìm kiếm thông tin của chính mình.',
      'PRIV-03',
    );
  if (plan.clarification)
    return response(
      'needs_clarification',
      plan.clarification,
      'HUST_ARGUMENT_REQUIRED',
    );
  signal.throwIfAborted();
  if (plan.id === 'get_exams') {
    try {
      // Check trusted access before even the shared semester lookup.
      await authorizeStudentData(plan.studentId, access);
    } catch (error) {
      if (error instanceof ChatError && error.code === 'HUST_STUDENT_FORBIDDEN')
        return response(
          'blocked',
          'Bạn chỉ được tra cứu lịch thi của tài khoản đang đăng nhập.',
          error.code,
        );
      return response(
        'requires_authentication',
        'Vui lòng đăng nhập lại tài khoản demo để tra cứu lịch thi.',
        'DEMO_AUTH_REQUIRED',
      );
    }
    if (tools.isEnabled && !(await tools.isEnabled('get_exams')))
      return response(
        'insufficient_evidence',
        'Tính năng tra cứu lịch thi đang tạm ngừng.',
        'HUST_EXAMS_DISABLED',
      );
    if (!plan.examSemester)
      return response(
        'needs_clarification',
        'Bạn muốn tra lịch thi học kỳ nào?',
        'HUST_EXAM_SEMESTER_REQUIRED',
      );
    const resolved = await resolveExamSemester(
      plan.examSemester,
      tools,
      signal,
      access,
      options?.budget,
    );
    if (resolved.status !== 'resolved')
      return response(
        resolved.status === 'clarify'
          ? 'needs_clarification'
          : 'insufficient_evidence',
        resolved.answer,
        resolved.reasonCode,
      );
    plan = { ...plan, arguments: { semester: resolved.semester } };
  }
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
  if (plan.id === 'get_exams' && ['success', 'empty'].includes(result.status))
    options?.onExamSemester?.(String(plan.arguments.semester));
  if (result.errorCode === 'DEMO_AUTH_REQUIRED')
    return response(
      'requires_authentication',
      'Phiên demo đã hết hạn. Vui lòng đăng nhập lại.',
      'DEMO_AUTH_REQUIRED',
    );
  if (result.errorCode === 'HUST_STUDENT_FORBIDDEN')
    return response(
      'blocked',
      'Bạn chỉ được tra cứu dữ liệu của tài khoản đang đăng nhập.',
      'HUST_STUDENT_FORBIDDEN',
    );
  if (result.status === 'empty')
    return response(
      'insufficient_evidence',
      plan.id === 'get_exams'
        ? 'HUST chưa trả lịch thi cho học kỳ này. Điều này không có nghĩa là bạn không có lịch thi hoặc không phải dự thi.'
        : isGradeTool(plan.id)
          ? 'HUST chưa trả dữ liệu điểm cho yêu cầu này. Điều này không có nghĩa là điểm bằng 0 hoặc chưa đăng ký học.'
          : plan.id.startsWith('search_')
            ? 'Mình chưa tìm thấy kết quả phù hợp. Bạn thử nhập tên hoặc từ khóa khác nhé.'
            : 'Mình chưa tìm thấy thông tin này. Bạn thử lại sau nhé.',
      'HUST_TOOL_EMPTY',
    );
  if (
    plan.id === 'get_student_info' &&
    result.errorCode === 'STUDENT_NOT_CONFIGURED'
  )
    return response(
      'requires_authentication',
      'Thông tin này cần dịch vụ có xác thực. Chatbot hiện chưa kết nối hồ sơ của bạn; hãy xem trên kênh chính thức của trường và đừng gửi mật khẩu hoặc OTP tại đây.',
      'STUDENT_NOT_CONFIGURED',
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
  const answer =
    plan.id === 'get_exams'
      ? renderExams(result.data, String(plan.arguments.semester), {
          upcoming: plan.upcomingExams,
        })
      : plan.id === 'get_student_info'
        ? await profileAnswer(result.data, plan.fields, tools, signal, access)
        : render(plan, result.data);
  if (!answer || answer.length > 10000)
    return response(
      'insufficient_evidence',
      'Mình chưa có thông tin đủ rõ để trả lời chính xác. Bạn thử lại sau nhé.',
      'HUST_DATA_INVALID',
    );
  return response('answered', answer, 'HUST_TOOL_RESULT');
}

const academicSchema = z
  .array(
    z.object({
      cpa: scalar.nullish().catch(undefined),
      gpa: scalar.nullish().catch(undefined),
      cumulateCredit: scalar.nullish().catch(undefined),
      registerCredit: scalar.nullish().catch(undefined),
      warningLevel: scalar.nullish().catch(undefined),
    }),
  )
  .max(5);
type AcademicRow = z.infer<typeof academicSchema>[number];
interface Term {
  semester: string;
  row: AcademicRow;
}

const present = (value: unknown) =>
  value !== undefined && value !== null && value !== '';

/** "học kỳ 2 năm học 2025–2026" */
function termName(code: string): string {
  const year = Number(code.slice(0, 4));
  return `${code.endsWith('3') ? 'học kỳ hè' : `học kỳ ${code.at(-1)}`} năm học ${year}–${year + 1}`;
}

/** Graduation classification bands of HUST's 4-point scale. */
function cpaBand(cpa: unknown): string | undefined {
  const value = Number(cpa);
  if (!Number.isFinite(value)) return;
  if (value >= 3.6) return 'Xuất sắc';
  if (value >= 3.2) return 'Giỏi';
  if (value >= 2.5) return 'Khá';
  if (value >= 2.0) return 'Trung bình';
  return 'dưới mức Trung bình';
}

/**
 * Latest main semesters that have results, newest first. The current semester usually has
 * none yet and summer terms are never published. `count` > 1 builds the GPA history.
 * Returns undefined when the API could not be read.
 */
async function loadTerms(
  tools: ChatTools,
  signal: AbortSignal,
  count: number,
  access?: ToolAccess,
): Promise<Term[] | undefined> {
  let semesters: string[];
  try {
    const listed = await tools.execute('get_semesters', {}, signal);
    const parsed = semesterSchema.safeParse(listed.data);
    if (listed.status !== 'success' || !parsed.success) return;
    const current =
      parsed.data.find((row) =>
        [true, 1, 'true'].includes(row.currentForClass ?? false),
      )?.semester ??
      parsed.data
        .map((row) => row.semester)
        .sort()
        .at(-1);
    semesters = parsed.data
      .map((row) => row.semester)
      .filter((code) => !code.endsWith('3') && (!current || code <= current))
      .sort()
      .reverse()
      .slice(0, count + 3);
  } catch {
    signal.throwIfAborted();
    return;
  }
  const terms: Term[] = [];
  for (const semester of semesters) {
    if (terms.length >= count) break;
    signal.throwIfAborted();
    let result: ToolResult;
    try {
      result = await tools.execute(
        'get_academic_result',
        { semester },
        signal,
        access,
      );
    } catch {
      signal.throwIfAborted();
      return terms.length ? terms : undefined;
    }
    if (result.status === 'empty') continue;
    if (result.status !== 'success') return terms.length ? terms : undefined;
    const parsed = academicSchema.safeParse(
      Array.isArray(result.data) ? result.data : [result.data],
    );
    const row = parsed.success ? parsed.data[0] : undefined;
    if (row && (present(row.cpa) || present(row.gpa)))
      terms.push({ semester, row });
  }
  return terms;
}

/**
 * Natural-language answer built by the backend from allow-listed fields only; the profile
 * never reaches the model. No fields means a general profile question.
 */
async function profileAnswer(
  data: unknown,
  fields: ProfileField[] | undefined,
  tools: ChatTools,
  signal: AbortSignal,
  access?: ToolAccess,
): Promise<string | undefined> {
  const parsed = profileSchema.safeParse(Array.isArray(data) ? data[0] : data);
  if (!parsed.success) return;
  const profile = parsed.data;
  const full = !fields;
  const wants = (field: ProfileField) => full || fields.includes(field);
  const studentId =
    present(profile.studentId) && /^\d{8,10}$/u.test(String(profile.studentId))
      ? String(profile.studentId)
      : undefined;
  const givenName = profile.fullName?.trim().split(/\s+/u).at(-1);
  const parts: string[] = [];

  // Who and where.
  if (full) {
    const who = [
      profile.studentClass ? `lớp ${profile.studentClass}` : '',
      profile.program
        ? `chương trình ${profile.program}${profile.programCode ? ` (${profile.programCode})` : ''}`
        : '',
      profile.school ? `thuộc ${profile.school}` : '',
    ].filter(Boolean);
    if (who.length) parts.push(`Bạn là sinh viên ${who.join(', ')}.`);
    const extra = [
      studentId ? `MSSV: ${studentId}` : '',
      profile.status ? `trạng thái: ${profile.status}` : '',
    ].filter(Boolean);
    if (extra.length)
      parts.push(`${extra.join('; ')}.`.replace(/^./u, (c) => c.toUpperCase()));
  } else {
    if (wants('identity') && (profile.fullName || studentId))
      parts.push(
        `Bạn là ${profile.fullName ?? 'sinh viên'}${studentId ? `, MSSV ${studentId}` : ''}.`,
      );
    if (wants('class') && profile.studentClass)
      parts.push(`Bạn đang học lớp ${profile.studentClass}.`);
    if (wants('program') && (profile.program || profile.school))
      parts.push(
        `Bạn theo học ${profile.program ? `chương trình ${profile.program}${profile.programCode ? ` (${profile.programCode})` : ''}` : 'tại'}${profile.school ? `${profile.program ? ', thuộc ' : ' '}${profile.school}` : ''}.`,
      );
    if (wants('status') && profile.status)
      parts.push(`Trạng thái học tập hiện tại của bạn: ${profile.status}.`);
  }

  // Academic results: only fetched when asked for, the GPA history only for GPA questions.
  const academicAsked =
    full ||
    ['cpa', 'gpa', 'credits', 'warning'].some((f) => wants(f as ProfileField));
  if (academicAsked) {
    const history = !full && wants('gpa');
    const terms = await loadTerms(tools, signal, history ? 6 : 1, access);
    const latest = terms?.[0];
    if (!terms)
      parts.push(
        'Mình chưa lấy được kết quả học tập lúc này, bạn thử lại sau một chút nhé.',
      );
    else if (!latest)
      parts.push('Hệ thống chưa có kết quả học tập của các học kỳ gần đây.');
    else {
      const { row, semester } = latest;
      const when = termName(semester);
      const band = cpaBand(row.cpa);
      const cpaText = present(row.cpa)
        ? `CPA (điểm trung bình tích lũy toàn khóa) của bạn là ${String(row.cpa)}${band ? `, thuộc mức ${band} theo thang điểm 4` : ''}`
        : '';
      const warning = present(row.warningLevel)
        ? Number(row.warningLevel) === 0
          ? 'bạn không bị cảnh báo học tập'
          : `bạn đang ở mức cảnh báo học tập ${String(row.warningLevel)}`
        : '';
      if (full) {
        const facts = [
          cpaText,
          present(row.gpa) ? `GPA học kỳ là ${String(row.gpa)}` : '',
          present(row.cumulateCredit)
            ? `bạn đã tích lũy ${String(row.cumulateCredit)} tín chỉ`
            : '',
          warning,
        ].filter(Boolean);
        if (facts.length)
          parts.push(
            `Về kết quả học tập (tính đến ${when}): ${facts.join('; ')}.`,
          );
      } else {
        if (wants('gpa') && present(row.gpa)) {
          const previous = terms
            .slice(1)
            .filter((term) => present(term.row.gpa))
            .map(
              (term) =>
                `- ${termName(term.semester)}: GPA ${String(term.row.gpa)}`,
            );
          parts.push(
            `GPA ${when} (học kỳ gần nhất đã có điểm) của bạn là ${String(row.gpa)}.${previous.length ? `\n\nCác học kỳ trước:\n${previous.join('\n')}` : ''}`,
          );
        }
        if (wants('cpa') && cpaText)
          parts.push(`${cpaText} (tính đến ${when}).`);
        else if (wants('gpa') && present(row.cpa))
          parts.push(
            `CPA hiện tại của bạn là ${String(row.cpa)}${band ? ` (mức ${band})` : ''}.`,
          );
        if (wants('credits') && present(row.cumulateCredit))
          parts.push(
            `Tính đến ${when}, bạn đã tích lũy ${String(row.cumulateCredit)} tín chỉ${present(row.registerCredit) ? `; học kỳ đó bạn đăng ký ${String(row.registerCredit)} tín chỉ` : ''}.`,
          );
        if (wants('warning') && warning)
          parts.push(
            Number(row.warningLevel) === 0
              ? `Tại ${when}, bạn không bị cảnh báo học tập (mức 0). Bạn cứ tiếp tục duy trì nhé.`
              : `Tại ${when}, bạn đang ở mức cảnh báo học tập ${String(row.warningLevel)}. Bạn nên trao đổi với cố vấn học tập để có kế hoạch cải thiện.`,
          );
      }
    }
  }

  if (wants('advisor')) {
    const advisors = (profile.teachers ?? [])
      .filter((teacher) => teacher.fullName)
      .map(
        (teacher) =>
          `${teacher.fullName}${teacher.email ? ` (${teacher.email})` : ''}`,
      );
    if (advisors.length)
      parts.push(
        `Cố vấn học tập của bạn là ${advisors.join(', ')}. Bạn có thể liên hệ qua email khi cần hỗ trợ.`,
      );
  }

  if (!parts.length) return;
  const greeting = givenName
    ? `Chào ${givenName}, ${full ? 'mình đã xem hồ sơ của bạn trên hệ thống.' : 'mình đã kiểm tra thông tin của bạn trên hệ thống.'}`
    : 'Mình đã kiểm tra thông tin của bạn trên hệ thống.';
  const followUp = full
    ? 'Nếu thông tin chưa đúng, bạn liên hệ phòng Công tác sinh viên hoặc cố vấn học tập để được điều chỉnh. Bạn có muốn xem GPA từng học kỳ hay hỏi thêm về quy định học tập không?'
    : wants('gpa') || wants('cpa')
      ? 'Bạn có muốn mình tra thêm quy định về xếp loại học lực hoặc điều kiện học bổng không?'
      : 'Bạn cần mình hỗ trợ thêm thông tin gì về học tập không?';
  return [greeting, ...parts, followUp].join('\n\n');
}
