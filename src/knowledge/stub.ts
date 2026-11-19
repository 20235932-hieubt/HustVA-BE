import { z } from 'zod';

export const searchSchema = z.strictObject({
  query: z.string().trim().min(1).max(300),
  sourceId: z
    .string()
    .regex(/^[a-z0-9-]{1,60}$/u)
    .optional(),
  limit: z.number().int().min(1).max(5).default(3),
});
export const sectionSchema = z.strictObject({
  evidenceId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),
});

/** One retrieved passage. `id` is what the model cites in `submit_answer`. */
export interface Evidence {
  id: string;
  text: string;
  isMock: boolean;
  title?: string;
  url?: string;
  documentId?: string;
  versionId?: string;
  /** "Chương II › Điều 10, trang 4" */
  location?: string;
  /** Crawler quality label; `needs_review` means the text must be checked against the original. */
  quality?: string;
  score?: number;
}
export interface KnowledgeResult {
  status:
    'not_implemented' | 'empty' | 'results' | 'unavailable' | 'not_granted';
  evidence: Evidence[];
  warnings: string[];
}
/** Filters taken from the trusted turn context, never from model arguments. */
export interface SearchScope {
  cohort?: string;
}
export interface KnowledgePort {
  search(
    input: z.infer<typeof searchSchema>,
    signal: AbortSignal,
    scope?: SearchScope,
  ): Promise<KnowledgeResult>;
  read(
    input: z.infer<typeof sectionSchema>,
    signal: AbortSignal,
  ): Promise<KnowledgeResult>;
}

/** Kept for tests and for running the chat without the embedding service wired in. */
export class StubKnowledge implements KnowledgePort {
  async search(
    _input: z.infer<typeof searchSchema>,
    signal: AbortSignal,
  ): Promise<KnowledgeResult> {
    signal.throwIfAborted();
    return {
      status: 'not_implemented',
      evidence: [],
      warnings: ['Retrieval chưa được triển khai.'],
    };
  }
  async read(
    _input: z.infer<typeof sectionSchema>,
    signal: AbortSignal,
  ): Promise<KnowledgeResult> {
    signal.throwIfAborted();
    return {
      status: 'not_implemented',
      evidence: [],
      warnings: ['Đọc section chưa được triển khai.'],
    };
  }
}
