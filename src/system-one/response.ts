import { z } from 'zod';

export type SystemOneQuestion =
  | { type: 'noul'; instructions: string }
  | {
      type: 'choice';
      instructions: string;
      criteria: Record<string, string>;
    };
export type SystemOneAnswer =
  | { type: 'noul'; probability: number }
  | {
      type: 'choice';
      choice: string;
      probabilities: Record<string, number>;
    };
export interface ParsedDecision {
  answers: Record<string, SystemOneAnswer>;
  truncated: boolean;
  inputTokens?: number;
}

const probability = z.number().min(0).max(1);
// Field names follow the Laya service, which mirrors Jev's documented shape.
// Jev/Clef answers in another shape are rejected (null), never guessed.
const rawAnswer = z.union([
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
  }),
]);
const rawResponse = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      truncated: z.boolean().optional(),
      input_tokens: z.number().int().min(0).optional(),
    })
    .optional(),
});

function normalizeAnswer(
  question: SystemOneQuestion,
  raw: unknown,
): SystemOneAnswer | null {
  const parsed = rawAnswer.safeParse(raw);
  if (!parsed.success || parsed.data.type !== question.type) return null;
  const answer = parsed.data;
  if (answer.type === 'noul') return { type: 'noul', probability: answer.noul };
  if (question.type !== 'choice') return null;
  const labels = Object.keys(question.criteria);
  const unknownLabel = Object.keys(answer.probabilities).some(
    (label) => !labels.includes(label),
  );
  if (
    !labels.includes(answer.choice) ||
    unknownLabel ||
    answer.probabilities[answer.choice] === undefined
  )
    return null;
  return {
    type: 'choice',
    choice: answer.choice,
    probabilities: { ...answer.probabilities },
  };
}

export function normalizeDecision(
  body: unknown,
  questions: Record<string, SystemOneQuestion>,
): ParsedDecision | null {
  const parsed = rawResponse.safeParse(body);
  if (!parsed.success) return null;
  const answers: Record<string, SystemOneAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = normalizeAnswer(question, parsed.data.answers[id]);
    if (!answer) return null;
    answers[id] = answer;
  }
  const inputTokens = parsed.data.usage?.input_tokens;
  return {
    answers,
    truncated: parsed.data.usage?.truncated === true,
    ...(inputTokens === undefined ? {} : { inputTokens }),
  };
}
