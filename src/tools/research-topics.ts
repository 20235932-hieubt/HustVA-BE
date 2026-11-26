import { z } from 'zod';
import { load } from 'cheerio';
import { UpstreamError } from './contracts.js';
import { hasSecret } from '../guardrails/policy.js';

export const researchToolIds = [
  'get_teacher_research_topics',
  'get_company_research_topics',
] as const;
export type ResearchToolId = (typeof researchToolIds)[number];
export type ResearchKind = 'teacher' | 'company';
export const isResearchTool = (id: string): id is ResearchToolId =>
  researchToolIds.some((value) => value === id);
export const researchKind = (id: ResearchToolId): ResearchKind =>
  id === researchToolIds[0] ? 'teacher' : 'company';
export const researchIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
export const teacherTopicsInput = z.strictObject({
  teacherId: researchIdSchema,
});
export const companyTopicsInput = z.strictObject({
  companyId: researchIdSchema,
});

/** Source text is inert display content, never an instruction or model context. */
function sourceText(value: string): string {
  const $ = load(value, undefined, false);
  $('script,style,iframe,object,svg,input,form').remove();
  $('br').replaceWith('\n');
  $('p,div,li,h1,h2,h3,h4,tr').append('\n');
  return $.root()
    .text()
    .replace(/\r\n?/gu, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
      char === '\n' || char === '\t' ? char : '',
    )
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/giu, '[liên kết nguồn]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, '[địa chỉ liên hệ]')
    .trim();
}
const prose = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !hasSecret(value))
    .transform(sourceText);
const label = prose(500);
export const researchLabelSchema = label;
const scalar = z.union([label, z.number().finite()]).nullish();
const topicShape = {
  title: label.refine((value) => Boolean(value)),
  description: prose(50_000).nullish(),
  studentNum: z.union([z.number().int().nonnegative(), label]).nullish(),
  departmentName: label.nullish(),
  programIds: z.array(label).max(200).nullish(),
  types: z
    .array(z.union([label, z.number().finite()]))
    .max(200)
    .nullish(),
  topicType: scalar,
  internType: scalar,
  status: scalar,
};
// Separate adapters: company item fields have not yet been confirmed by a non-empty live response.
const teacherTopic = z.object(topicShape);
const companyTopic = z.object({ ...topicShape });
export type ResearchTopic = z.infer<typeof teacherTopic>;
export function normalizeResearchTopics(
  id: ResearchToolId,
  data: unknown,
): ResearchTopic[] | null {
  if (data === null) return null;
  const parsed = z
    .array(id === researchToolIds[0] ? teacherTopic : companyTopic)
    .max(10_000)
    .safeParse(data);
  if (!parsed.success) throw new UpstreamError('HUST_TOPICS_DATA_INVALID');
  return parsed.data;
}

export const escapeResearchText = (value: unknown): string =>
  String(value).replace(/[\\`*_[\]<>!()|#~]/gu, '\\$&');
