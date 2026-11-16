import { z } from 'zod';

export const policyVersion = 'hustva-ctsv-v1';
export const contextSchema = z.strictObject({
  cohort: z.string().trim().min(1).max(40).optional(),
  program: z.string().trim().min(1).max(120).optional(),
  academicYear: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{4}$/u)
    .optional(),
});
export const messageSchema = z.strictObject({
  requestId: z.uuid(),
  message: z.string().trim().min(1).max(4000),
  context: contextSchema.optional(),
});
export const draftSchema = z.strictObject({
  status: z.enum([
    'answered',
    'needs_clarification',
    'insufficient_evidence',
    'out_of_scope',
    'requires_authentication',
    'handoff',
    'blocked',
    'support',
  ]),
  claims: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(1200),
        evidenceIds: z
          .array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u))
          .min(1)
          .max(5),
      }),
    )
    .max(5),
  missingFields: z.array(z.enum(['topic', 'cohort', 'program', 'academicYear', 'purpose'])).max(3),
});

export type StudentContext = z.infer<typeof contextSchema>;
export type MessageInput = z.infer<typeof messageSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type ChatStatus = Draft['status'];
export interface Citation {
  evidenceId: string;
  title: string;
  url: string;
  documentId: string;
  versionId: string;
  location: string;
}
export interface ChatResult {
  status: ChatStatus;
  answer: string;
  citations: Citation[];
  reasonCode: string;
  warnings: string[];
  policyVersion: string;
  retrievalMode: 'stub';
}
export interface ChatTurn {
  requestId: string;
  runId: string;
  user: string;
  result: ChatResult;
  createdAt: Date;
}

export function reply(status: ChatStatus, answer: string, reasonCode: string): ChatResult {
  return {
    status,
    answer,
    reasonCode,
    citations: [],
    policyVersion,
    retrievalMode: 'stub',
    warnings: ['Tra cứu tri thức đang dùng stub; chưa kết nối kho quy định HUST.'],
  };
}

export class ChatError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
