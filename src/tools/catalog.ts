import { z } from 'zod';
import { gradesInputSchema, gradesByCourseInputSchema } from './grades.js';
import { examsInputSchema } from './exams.js';

const code = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,40}$/u);
const keyword = z.string().trim().min(1).max(200);

export interface ToolDefinition {
  id: string;
  description: string;
  source: 'partner';
  endpoint: string;
  schema: z.ZodType<Record<string, unknown>>;
  warnings: string[];
  defaultEnabled: boolean;
  timeoutMs: number;
  /** ToolManager adds the authenticated studentId; the model and caller cannot set it. */
  studentBound?: boolean;
  /** Called by the backend only; never offered to the model for selection. */
  internal?: boolean;
}

function partner(
  id: string,
  endpoint: string,
  description: string,
  shape: z.ZodRawShape,
): ToolDefinition {
  return {
    id,
    endpoint,
    description,
    source: 'partner',
    schema: z.strictObject(shape),
    warnings: [],
    defaultEnabled: true,
    timeoutMs: 10000,
  };
}

// Grade tools are explicitly enabled by management; public chat has a separate gate.
export const toolCatalog: readonly ToolDefinition[] = [
  {
    id: 'get_exams',
    endpoint: 'exams',
    description:
      'Lịch thi học kỳ của chính sinh viên đang đăng nhập; không dùng cho quy chế thi.',
    source: 'partner',
    schema: examsInputSchema,
    studentBound: true,
    defaultEnabled: false,
    timeoutMs: 10000,
    warnings: [
      'Lịch thi cá nhân; chỉ tài khoản được gắn đúng MSSV hoặc management được phép truy cập.',
    ],
  },
  partner(
    'get_semesters',
    'semesters',
    'Danh sách học kỳ và cờ currentForClass; không hardcode kỳ hiện tại.',
    {},
  ),
  partner(
    'get_study_conditions',
    'student/study-conditions',
    'Điều kiện học kỹ sư chuyên sâu và thạc sĩ.',
    {},
  ),
  partner(
    'get_advanced_programs',
    'student/kscs',
    'Chương trình kỹ sư chuyên sâu có thể đăng ký.',
    { programId: code },
  ),
  partner('search_teachers', 'teacher/search', 'Tìm giảng viên theo từ khóa.', {
    keyWord: keyword,
  }),
  partner(
    'search_companies',
    'company/search',
    'Tìm công ty đối tác; từ khóa không được rỗng.',
    {
      keyWord: keyword,
    },
  ),
  ...[
    {
      id: 'get_grades',
      endpoint: 'grades',
      schema: gradesInputSchema,
      description:
        'Tra cứu điểm học phần theo MSSV, có thể lọc học kỳ; không trả GPA/CPA.',
    },
    {
      id: 'get_grades_by_course',
      endpoint: 'gradebycourseid',
      schema: gradesByCourseInputSchema,
      description:
        'Tra cứu các lần học của một mã học phần theo MSSV; không tự chọn lần học.',
    },
  ].map((item): ToolDefinition => ({
    ...item,
    source: 'partner',
    defaultEnabled: false,
    timeoutMs: 10000,
    warnings: [
      'Dữ liệu điểm cá nhân; chỉ tài khoản được gắn đúng MSSV hoặc management đã xác thực được phép truy cập.',
    ],
  })),
  {
    ...partner(
      'get_student_info',
      'student/info',
      'Hồ sơ của chính sinh viên đang hỏi: họ tên, lớp, ngành, trường/khoa, trạng thái học, cố vấn học tập, CPA, GPA, tín chỉ tích lũy, mức cảnh báo học tập.',
      {},
    ),
    studentBound: true,
  },
  {
    // Part of get_student_info: the backend picks the latest main semester with results.
    ...partner(
      'get_academic_result',
      'academicresult',
      'Kết quả học tập một học kỳ của chính sinh viên: GPA, CPA, tín chỉ, mức cảnh báo.',
      { semester: z.string().regex(/^\d{4}[12]$/u) },
    ),
    studentBound: true,
    internal: true,
  },
];

export function findTool(id: string): ToolDefinition | undefined {
  return toolCatalog.find((tool) => tool.id === id);
}
