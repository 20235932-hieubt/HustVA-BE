import { selectEvidenceSentences } from './facts.js';
import type { SystemOneQuestion } from './response.js';

// Question builder for site b (claim check). Pure; the filter that applies
// the answer to a draft is wired in step 6.

export const SUPPORT_QUESTION_ID = 'ho_tro';

export interface ClaimEvidence {
  text: string;
  /** Where the passage comes from (title or section), if known. */
  location?: string;
}

export function buildClaimQuestions(): Record<string, SystemOneQuestion> {
  return {
    [SUPPORT_QUESTION_ID]: {
      type: 'noul',
      instructions:
        'Đoạn tài liệu có nêu rõ nội dung của khẳng định không? Chỉ trả lời đúng khi mọi chi tiết quan trọng của khẳng định (đối tượng, điều kiện, con số, thời hạn) đều có trong đoạn tài liệu.',
    },
  };
}

/** `claim` must already be pseudonymized; evidence is public document text. */
export function buildClaimState(
  claim: string,
  evidence: ClaimEvidence,
): Record<string, string> {
  const selected = selectEvidenceSentences(claim, evidence.text);
  return {
    claim,
    evidence: evidence.location
      ? `${evidence.location}\n${selected}`
      : selected,
  };
}
