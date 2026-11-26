import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ToolAccess } from '../auth/tool-access.js';
import type { ToolResult } from './contracts.js';
import type { ChatTools } from './chat.js';
import type { ToolBudget } from './exam-semester.js';
import {
  researchIdSchema,
  researchLabelSchema,
  normalizeResearchTopics,
  type ResearchKind,
  type ResearchTopic,
} from './research-topics.js';

export const candidateRefSchema = z.string().regex(/^rt_[a-f0-9]{32}$/u);
const sourceId = z.union([
  researchIdSchema,
  z.number().int().safe().nonnegative().transform(String),
]);
const searchRows = z
  .array(
    z.object({
      id: sourceId,
      fullName: researchLabelSchema.nullish(),
      displayName: researchLabelSchema.nullish(),
      schoolName: researchLabelSchema.nullish(),
    }),
  )
  .max(1000);
export const researchRequestSchema = z
  .strictObject({
    kind: z.enum(['teacher', 'company']),
    keyWord: z.string().trim().min(1).max(200).optional(),
    targetRef: candidateRefSchema.optional(),
  })
  .refine((value) => Boolean(value.keyWord) !== Boolean(value.targetRef));
export type ResearchRequest = z.infer<typeof researchRequestSchema>;
export const researchStateSchema = z
  .object({
    kind: z.enum(['teacher', 'company']),
    candidates: z
      .array(
        z.object({
          id: researchIdSchema,
          ref: candidateRefSchema,
          label: researchLabelSchema.refine(Boolean),
          unit: researchLabelSchema.optional(),
        }),
      )
      .min(1)
      .max(10),
    selectedRef: candidateRefSchema.optional(),
    total: z.number().int().positive(),
    establishedAt: z.date(),
    expiresAt: z.date(),
  })
  .refine(
    (state) =>
      new Set(state.candidates.map((c) => c.ref)).size ===
        state.candidates.length &&
      (!state.selectedRef ||
        state.candidates.some((c) => c.ref === state.selectedRef)),
  );
export type ResearchLookupState = z.infer<typeof researchStateSchema>;
export function validResearchState(
  value: unknown,
  now = new Date(),
): ResearchLookupState | undefined {
  const parsed = researchStateSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.expiresAt <= now ||
    parsed.data.establishedAt > now ||
    now.getTime() - parsed.data.establishedAt.getTime() > 600_000
  )
    return;
  return parsed.data;
}
export interface ResearchReferences {
  kind: ResearchKind;
  choices: { ref: string; label: string; unit?: string; index: number }[];
  selectedRef?: string;
}
export type ResearchOutcome =
  | { status: 'selection'; state: ResearchLookupState }
  | {
      status: 'success' | 'empty';
      state: ResearchLookupState;
      target: ResearchLookupState['candidates'][number];
      topics: ResearchTopic[] | null;
    }
  | { status: 'clarify' | 'unavailable'; reasonCode: string };

export async function resolveResearchLookup(
  input: ResearchRequest,
  tools: ChatTools,
  signal: AbortSignal,
  previous?: ResearchLookupState,
  access?: ToolAccess,
  budget: ToolBudget = { maxToolCalls: 6, maxToolRounds: 3 },
  conversationExpiry = new Date(Date.now() + 600_000),
): Promise<ResearchOutcome> {
  signal.throwIfAborted();
  const parsed = researchRequestSchema.safeParse(input);
  if (!parsed.success)
    return { status: 'clarify', reasonCode: 'HUST_TOPIC_TARGET_REQUIRED' };
  const request = parsed.data;
  const tool =
    request.kind === 'teacher'
      ? 'get_teacher_research_topics'
      : 'get_company_research_topics';
  if (tools.isEnabled && !(await tools.isEnabled(tool)))
    return { status: 'unavailable', reasonCode: 'HUST_TOPICS_DISABLED' };
  const required = request.keyWord ? 2 : 1;
  if (budget.maxToolCalls < required || budget.maxToolRounds < required)
    return { status: 'unavailable', reasonCode: 'HUST_TOPICS_BUDGET' };
  let state: ResearchLookupState;
  if (request.keyWord) {
    const result = await tools.execute(
      request.kind === 'teacher' ? 'search_teachers' : 'search_companies',
      { keyWord: request.keyWord },
      signal,
      access,
    );
    signal.throwIfAborted();
    if (result.status === 'empty')
      return { status: 'clarify', reasonCode: 'HUST_TOPIC_TARGET_NOT_FOUND' };
    if (result.status !== 'success') return unavailable(result);
    const rows = searchRows.safeParse(result.data);
    if (!rows.success)
      return {
        status: 'unavailable',
        reasonCode: 'HUST_TOPIC_TARGET_DATA_INVALID',
      };
    if (!rows.data.length)
      return { status: 'clarify', reasonCode: 'HUST_TOPIC_TARGET_NOT_FOUND' };
    const candidates = rows.data.slice(0, 10).map((row) => ({
      id: row.id,
      ref: `rt_${randomBytes(16).toString('hex')}`,
      label:
        (request.kind === 'company'
          ? row.displayName || row.fullName
          : row.fullName) || '',
      ...(row.schoolName ? { unit: row.schoolName } : {}),
    }));
    if (candidates.some((candidate) => !candidate.label))
      return {
        status: 'unavailable',
        reasonCode: 'HUST_TOPIC_TARGET_DATA_INVALID',
      };
    const now = new Date();
    state = {
      kind: request.kind,
      candidates,
      total: rows.data.length,
      establishedAt: now,
      expiresAt: new Date(
        Math.min(now.getTime() + 600_000, conversationExpiry.getTime()),
      ),
    };
    if (rows.data.length !== 1) return { status: 'selection', state };
    state.selectedRef = candidates[0].ref;
  } else {
    const existing = validResearchState(previous);
    if (
      !existing ||
      existing.kind !== request.kind ||
      !existing.candidates.some(
        (candidate) => candidate.ref === request.targetRef,
      )
    )
      return { status: 'clarify', reasonCode: 'HUST_TOPIC_TARGET_EXPIRED' };
    state = { ...existing, selectedRef: request.targetRef };
  }
  const target = state.candidates.find(
    (candidate) => candidate.ref === state.selectedRef,
  )!;
  signal.throwIfAborted();
  const result = await tools.execute(
    tool,
    { [request.kind === 'teacher' ? 'teacherId' : 'companyId']: target.id },
    signal,
    access,
  );
  signal.throwIfAborted();
  if (!['success', 'empty'].includes(result.status)) return unavailable(result);
  try {
    const topics = normalizeResearchTopics(tool, result.data);
    return {
      status: topics?.length ? 'success' : 'empty',
      state,
      target,
      topics,
    };
  } catch {
    return { status: 'unavailable', reasonCode: 'HUST_TOPICS_DATA_INVALID' };
  }
}
function unavailable(result: ToolResult): ResearchOutcome {
  return {
    status: 'unavailable',
    reasonCode:
      result.status === 'disabled'
        ? 'HUST_TOPICS_DISABLED'
        : result.status === 'timeout'
          ? 'HUST_TOPICS_TIMEOUT'
          : 'HUST_TOPICS_UNAVAILABLE',
  };
}
