import { z } from 'zod';
import { fold, hasSecret } from '../guardrails/policy.js';
import type { PrivacySession } from '../privacy/session.js';
import { profileFields } from './chat.js';

export const workflowIds = [
  'get_semesters',
  'get_study_conditions',
  'get_advanced_programs',
  'search_teachers',
  'search_companies',
  'get_student_info',
  'get_grades',
  'get_grades_by_course',
  'get_exams',
  'get_teacher_research_topics',
  'get_company_research_topics',
] as const;
export type WorkflowId = (typeof workflowIds)[number];
const text = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (s) => !hasSecret(s) && !/@|https?:|\d{7,}|\[\[|[\x00-\x1f]/iu.test(s),
  );
export const slotSchema = z.strictObject({
  keyWord: text.optional(),
  unitHint: text.optional(),
  semester: z
    .string()
    .regex(/^(?:\d{4}[123]|current|context|upcoming)$/u)
    .optional(),
  courseId: z
    .string()
    .regex(/^[A-Z][A-Z0-9_.-]{1,39}$/u)
    .optional(),
  programId: z
    .string()
    .regex(/^[A-Z][A-Z0-9_.-]{0,39}$/u)
    .optional(),
  currentOnly: z.boolean().optional(),
  fields: z.array(z.enum(profileFields)).max(profileFields.length).optional(),
});
export type ToolSlots = z.infer<typeof slotSchema>;
export type SlotName = keyof ToolSlots;
export const requirements: Record<
  WorkflowId,
  { allowed: SlotName[]; required: SlotName[] }
> = {
  get_semesters: { allowed: ['currentOnly'], required: [] },
  get_study_conditions: { allowed: [], required: [] },
  get_advanced_programs: { allowed: ['programId'], required: ['programId'] },
  search_teachers: { allowed: ['keyWord'], required: ['keyWord'] },
  search_companies: { allowed: ['keyWord'], required: ['keyWord'] },
  get_student_info: { allowed: ['fields'], required: [] },
  get_grades: { allowed: ['semester'], required: [] },
  get_grades_by_course: { allowed: ['courseId'], required: ['courseId'] },
  get_exams: { allowed: ['semester'], required: ['semester'] },
  get_teacher_research_topics: {
    allowed: ['keyWord', 'unitHint'],
    required: ['keyWord'],
  },
  get_company_research_topics: { allowed: ['keyWord'], required: ['keyWord'] },
};
export const pendingSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    tool: z.enum(workflowIds),
    slots: slotSchema,
    createdAt: z.date(),
    expiresAt: z.date(),
    clarificationCount: z.number().int().min(0).max(100),
  })
  .refine((v) =>
    Object.keys(v.slots).every((k) =>
      requirements[v.tool].allowed.includes(k as SlotName),
    ),
  );
export type PendingToolRequest = z.infer<typeof pendingSchema>;
export function validPending(
  value: unknown,
  now = new Date(),
): PendingToolRequest | undefined {
  const parsed = pendingSchema.safeParse(value);
  if (!parsed.success) return;
  const p = parsed.data;
  if (
    p.createdAt > now ||
    p.expiresAt <= now ||
    p.expiresAt.getTime() - p.createdAt.getTime() > 600_000
  )
    return;
  return p;
}

export function missingSlots(tool: WorkflowId, slots: ToolSlots): SlotName[] {
  return requirements[tool].required.filter((key) => slots[key] === undefined);
}
export function questionFor(
  tool: WorkflowId,
  missing: SlotName[],
  count = 0,
): string {
  const field = missing[0];
  const question =
    field === 'semester'
      ? 'Bạn muốn tra lịch thi học kỳ nào?'
      : field === 'courseId'
        ? 'Bạn muốn xem điểm học phần nào? Cho mình mã học phần nhé.'
        : field === 'programId'
          ? 'Bạn cho mình mã ngành cần tra cứu nhé.'
          : tool === 'search_teachers' || tool === 'get_teacher_research_topics'
            ? 'Bạn muốn tra cứu giảng viên tên gì?'
            : 'Bạn muốn tra cứu công ty nào?';
  const example =
    field === 'semester'
      ? 'Ví dụ: 20252 hoặc “kỳ hiện tại”.'
      : field === 'courseId'
        ? 'Ví dụ: IT3090.'
        : field === 'programId'
          ? 'Ví dụ: IT1.'
          : 'Bạn có thể gửi tên hoặc từ khóa cụ thể hơn.';
  return `${question}${count >= 2 ? ` ${example}` : ''}${count >= 3 ? ' Bạn cũng có thể nói “hủy tra cứu”.' : ''}`;
}

/** Values are restored locally and re-tokenized in every new PrivacySession. */
export function pendingContext(
  pending: PendingToolRequest | undefined,
  privacy: PrivacySession,
) {
  if (!pending) return;
  return {
    tool: pending.tool,
    slots: {
      ...pending.slots,
      ...(pending.slots.keyWord
        ? { keyWord: privacy.pseudonymize(pending.slots.keyWord) }
        : {}),
      ...(pending.slots.unitHint
        ? { unitHint: privacy.pseudonymize(pending.slots.unitHint) }
        : {}),
    },
    missingFields: missingSlots(pending.tool, pending.slots),
  };
}

export function groundedText(
  value: string,
  message: string,
  privacy: PrivacySession,
): string | undefined {
  const refs = value.match(/\[\[.*?\]\]/gu) ?? [];
  if (
    refs.some(
      (ref) =>
        !/^\[\[PII_NAME_[a-f0-9]{32}\]\]$/u.test(ref) || !privacy.owns(ref),
    )
  )
    return;
  const restored = privacy.restore(value).trim();
  return text.safeParse(restored).success &&
    fold(privacy.restore(message)).includes(fold(restored))
    ? restored
    : undefined;
}
