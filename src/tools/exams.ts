import { z } from 'zod';
import { gradeSemesterSchema, courseIdSchema } from './grades.js';
import { UpstreamError } from './contracts.js';

// studentId is supplied by ToolManager from trusted server-side identity only.
export const examsInputSchema = z.strictObject({
  semester: gradeSemesterSchema,
});
const sourceText = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !/[\p{Cc}\p{Cf}]|\[\[|https?:|mongodb(?:\+srv)?:|AIza/iu.test(value),
  );
const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? null : value),
  sourceText.nullish(),
);
const scalar = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? null : value),
  z.union([sourceText, z.number().finite()]).nullish(),
);
const timestamp = z
  .number()
  .int()
  .refine((value) => Number.isFinite(new Date(value).getTime()))
  .nullish();
const examRowSchema = z.object({
  courseId: courseIdSchema,
  courseName: optionalText,
  examDate: timestamp,
  endDate: timestamp,
  dateStr: optionalText,
  endDateStr: optionalText,
  place: optionalText,
  examGroup: scalar,
  examType: scalar,
  typeName: optionalText,
  session: scalar,
  notes: optionalText,
});
const examsSchema = z.array(examRowSchema).max(10_000);
export type ExamRow = z.infer<typeof examRowSchema>;

export function normalizeExams(data: unknown): ExamRow[] | null {
  if (data === null) return null;
  const parsed = examsSchema.safeParse(data);
  if (!parsed.success) throw new UpstreamError('HUST_EXAMS_DATA_INVALID');
  return parsed.data.map((row) => ({
    ...row,
    courseId: row.courseId.toUpperCase(),
  }));
}
