import { z } from 'zod';

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

// Phase 1: five independent shared-data endpoints; no student records or workflows.
export const toolCatalog: readonly ToolDefinition[] = [
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
];

export function findTool(id: string): ToolDefinition | undefined {
  return toolCatalog.find((tool) => tool.id === id);
}
