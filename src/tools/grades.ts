import { z } from 'zod';
import { UpstreamError } from './contracts.js';

export const studentIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{8,9}$/u);
export const gradeSemesterSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{4}[123]$/u);
export const courseIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/u);
export const gradesInputSchema = z.strictObject({
  studentId: studentIdSchema,
  semester: gradeSemesterSchema.optional(),
});
export const gradesByCourseInputSchema = z.strictObject({
  studentId: studentIdSchema,
  courseId: courseIdSchema,
});

const text = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) =>
      !/[\p{Cc}\p{Cf}]|\[\[|https?:|mongodb(?:\+srv)?:|AIza/iu.test(value),
  );
const mark = z.union([z.number().finite(), text]).nullish();
// Keep source values: no coercion, derived grades or interpretation of status.
const gradeRowSchema = z.object({
  classId: z.union([text, z.number().int().nonnegative()]),
  courseId: courseIdSchema,
  semester: gradeSemesterSchema,
  examMark: mark,
  processMark: mark,
  // HUST uses an empty string while the letter grade is not available yet.
  finalMarkLetter: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? null : value,
    text.nullish(),
  ),
  status: z.union([text, z.number().finite()]).nullish(),
});
export type GradeRow = z.infer<typeof gradeRowSchema>;
const gradeRowsSchema = z.array(gradeRowSchema).max(10_000);
export const isGradeTool = (id: string): boolean =>
  id === 'get_grades' || id === 'get_grades_by_course';

export function normalizeGrades(data: unknown): GradeRow[] | null {
  if (data === null) return null;
  const parsed = gradeRowsSchema.safeParse(data);
  if (!parsed.success) throw new UpstreamError('HUST_GRADES_DATA_INVALID');
  return parsed.data.map((row) => ({
    ...row,
    courseId: row.courseId.toUpperCase(),
  }));
}

export function renderGrades(data: unknown): string | undefined {
  let rows: GradeRow[] | null;
  try {
    rows = normalizeGrades(data);
  } catch {
    return undefined;
  }
  if (!rows?.length) return undefined;
  const sorted = [...rows].sort(
    (a, b) =>
      b.semester.localeCompare(a.semester) ||
      a.courseId.localeCompare(b.courseId) ||
      String(a.classId).localeCompare(String(b.classId)),
  );
  const value = (item: unknown) =>
    item == null ? 'chưa có dữ liệu' : String(item);
  const lines = [
    `Kết quả tra cứu: ${rows.length} dòng điểm.`,
    'Giữ nguyên các lần học theo nguồn HUST; không tự tính GPA/CPA.',
  ];
  let semester: string | undefined;
  let shown = 0;
  for (const row of sorted.slice(0, 30)) {
    const line = `- ${row.courseId} (lớp ${row.classId}): quá trình ${value(row.processMark)}; cuối kỳ ${value(row.examMark)}; điểm chữ ${value(row.finalMarkLetter)}; trạng thái nguồn ${value(row.status)}.`;
    if (lines.join('\n').length + line.length > 9000) break;
    if (semester !== row.semester) {
      semester = row.semester;
      lines.push(`\nHọc kỳ ${semester}:`);
    }
    lines.push(line);
    shown++;
  }
  if (rows.length > shown)
    lines.push(
      `Chỉ hiển thị ${shown} dòng đầu. Hãy lọc theo học kỳ hoặc mã học phần để xem cụ thể hơn.`,
    );
  return lines.join('\n');
}
