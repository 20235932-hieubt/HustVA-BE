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
// TODO(RETRIEVAL-03): extend evidence with source URL, document/version/index IDs,
// location and publication state before implementing claim-level citation rendering.
export interface KnowledgeResult {
  status: 'not_implemented' | 'empty' | 'results';
  evidence: { id: string; text: string; isMock: boolean }[];
  warnings: string[];
}
export interface KnowledgePort {
  search(input: z.infer<typeof searchSchema>, signal: AbortSignal): Promise<KnowledgeResult>;
  read(input: z.infer<typeof sectionSchema>, signal: AbortSignal): Promise<KnowledgeResult>;
}

export class StubKnowledge implements KnowledgePort {
  async search(
    _input: z.infer<typeof searchSchema>,
    signal: AbortSignal,
  ): Promise<KnowledgeResult> {
    signal.throwIfAborted();
    // TODO(RETRIEVAL-01): replace with Atlas Vector Search over published, reviewed chunks.
    // TODO(RETRIEVAL-02): resolve embedding model/dimension/indexVersion; recheck publication from MongoDB.
    return {
      status: 'not_implemented',
      evidence: [],
      warnings: ['Retrieval chưa được triển khai.'],
    };
  }
  async read(_input: z.infer<typeof sectionSchema>, signal: AbortSignal): Promise<KnowledgeResult> {
    signal.throwIfAborted();
    // TODO(TOOLS-01): resolve only evidence IDs granted to this turn; enforce version/section limits.
    return {
      status: 'not_implemented',
      evidence: [],
      warnings: ['Đọc section chưa được triển khai.'],
    };
  }
}
