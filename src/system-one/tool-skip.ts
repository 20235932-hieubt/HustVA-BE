import {
  LOOKUP_QUESTION_ID,
  LOOKUP_TOOL_IDS,
  type LookupLabel,
} from './pre-route.js';
import type { SystemOneAnswer } from './response.js';

// Site f (skip the Gemini tool selector). Threshold from the step-2 probe
// (demo-plan 1.3): 0/9 tool questions skipped, 7/11 document questions
// skipped at 0.80.
export const TOOL_SKIP_MIN = 0.8;

const DOCUMENT_LABEL: LookupLabel = 'tai_lieu';
const LOOKUP_LABELS: ReadonlySet<string> = new Set<string>([
  DOCUMENT_LABEL,
  ...Object.keys(LOOKUP_TOOL_IDS),
]);

export interface ToolSkipDecision {
  label: LookupLabel;
  probability: number;
  /** True only for a confident document (non-tool) question. */
  skip: boolean;
}

/**
 * Pure: decides whether the turn may go straight to the agent. Returns null
 * when the answer is missing or malformed, so the selector runs as before.
 */
export function decideToolSkip(
  answers: Record<string, SystemOneAnswer>,
): ToolSkipDecision | null {
  const lookup = answers[LOOKUP_QUESTION_ID];
  if (lookup?.type !== 'choice' || !LOOKUP_LABELS.has(lookup.choice))
    return null;
  const label = lookup.choice as LookupLabel;
  const probability = lookup.probabilities[label] ?? 0;
  return {
    label,
    probability,
    skip: label === DOCUMENT_LABEL && probability >= TOOL_SKIP_MIN,
  };
}
