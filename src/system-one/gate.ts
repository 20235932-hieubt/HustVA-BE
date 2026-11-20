import type { ChatResult } from '../chat/contracts.js';
import {
  attackReply,
  fallback,
  otherStudentReply,
  socialReply,
} from '../guardrails/policy.js';
import {
  ATTACK_QUESTION_ID,
  GATE_QUESTION_ID,
  POLICY_QUESTION_ID,
  type GateLabel,
} from './pre-route.js';
import type { SystemOneAnswer } from './response.js';

// Site a (input gate). Thresholds from the step-2 probe (demo-plan 1.3):
// every action also requires P(academic) <= ACADEMIC_CAP.
export const ACADEMIC_CAP = 0.2;
export const LABEL_MIN = 0.6;
export const OUT_OF_SCOPE_MIN = 0.65;
export const ATTACK_NOUL_MIN = 0.8;
export const POLICY_NOUL_MAX = 0.3;

const GATE_LABELS: ReadonlySet<string> = new Set<GateLabel>([
  'academic',
  'personal_data',
  'out_of_scope',
  'attack',
  'privacy_violation',
  'misconduct',
  'social',
  'meta_bot',
]);

/** What the chat turn does instead of tool routing + agent. */
export interface GateAction {
  result: ChatResult;
  /** Keep this turn's merged context (same meaning as checkInput). */
  retainUser: boolean;
  /** Keep this turn in later history (never for blocked/support). */
  retainInContext: boolean;
}
export interface GateDecision {
  label: GateLabel;
  probability: number;
  /** Absent when the turn goes on (academic or below threshold). */
  action?: GateAction;
}

function noul(answer: SystemOneAnswer | undefined): number | undefined {
  return answer?.type === 'noul' ? answer.probability : undefined;
}

function actionFor(
  label: GateLabel,
  probability: number,
  attack: number,
  policy: number,
): GateAction | undefined {
  const sure = probability >= LABEL_MIN;
  switch (label) {
    case 'attack':
      return sure && attack >= ATTACK_NOUL_MIN
        ? {
            result: attackReply(),
            retainUser: false,
            retainInContext: false,
          }
        : undefined;
    case 'privacy_violation':
      return sure
        ? {
            result: otherStudentReply(),
            retainUser: true,
            retainInContext: false,
          }
        : undefined;
    case 'personal_data':
      return sure && policy < POLICY_NOUL_MAX
        ? {
            result: fallback('requires_authentication'),
            retainUser: true,
            retainInContext: true,
          }
        : undefined;
    case 'out_of_scope':
      return probability >= OUT_OF_SCOPE_MIN
        ? {
            result: fallback('out_of_scope'),
            retainUser: true,
            retainInContext: true,
          }
        : undefined;
    case 'misconduct':
      return sure
        ? {
            result: fallback('blocked'),
            retainUser: true,
            retainInContext: false,
          }
        : undefined;
    case 'social':
    case 'meta_bot':
      return sure
        ? { result: socialReply(), retainUser: true, retainInContext: true }
        : undefined;
    case 'academic':
      return undefined;
  }
}

/**
 * Pure: maps the gate answers to an action. Returns null when the answers
 * are missing or malformed, so the caller takes the old path.
 */
export function decideGate(
  answers: Record<string, SystemOneAnswer>,
): GateDecision | null {
  const gate = answers[GATE_QUESTION_ID];
  const attack = noul(answers[ATTACK_QUESTION_ID]);
  const policy = noul(answers[POLICY_QUESTION_ID]);
  if (gate?.type !== 'choice' || attack === undefined || policy === undefined)
    return null;
  if (!GATE_LABELS.has(gate.choice)) return null;
  const label = gate.choice as GateLabel;
  const probability = gate.probabilities[label] ?? 0;
  const academic = gate.probabilities.academic ?? 0;
  const action =
    academic <= ACADEMIC_CAP
      ? actionFor(label, probability, attack, policy)
      : undefined;
  return action ? { label, probability, action } : { label, probability };
}
