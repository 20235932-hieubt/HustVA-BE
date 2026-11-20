// Text helpers for choosing which evidence sentences go with a claim.
// Pure functions; fact matching (numbers, dates, codes) arrives in step 6.

export const MAX_EVIDENCE_CHARS = 1800;

const MIN_SENTENCE_CHARS = 1;

function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gu, 'd')
    .toLowerCase();
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.;:!?])\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= MIN_SENTENCE_CHARS);
}

function words(text: string): string[] {
  return fold(text).match(/[\p{L}\d]+/gu) ?? [];
}

/** Unigrams plus bigrams, so a shared phrase scores above scattered words. */
function grams(text: string): Set<string> {
  const list = words(text);
  const result = new Set(list);
  for (let i = 0; i + 1 < list.length; i += 1)
    result.add(`${list[i]} ${list[i + 1]}`);
  return result;
}

export function overlapScore(claim: Set<string>, sentence: string): number {
  let score = 0;
  for (const gram of grams(sentence)) if (claim.has(gram)) score += 1;
  return score;
}

/**
 * Keeps the sentences that overlap the claim most, up to `maxChars`, in
 * original order. Text already within the limit is returned unchanged.
 */
export function selectEvidenceSentences(
  claim: string,
  evidence: string,
  maxChars: number = MAX_EVIDENCE_CHARS,
): string {
  if (evidence.length <= maxChars) return evidence;
  const claimGrams = grams(claim);
  const ranked = splitSentences(evidence)
    .map((text, index) => ({
      text,
      index,
      score: overlapScore(claimGrams, text),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: typeof ranked = [];
  let used = 0;
  for (const sentence of ranked) {
    const cost = sentence.text.length + 1;
    if (used + cost > maxChars) continue;
    chosen.push(sentence);
    used += cost;
  }
  return chosen
    .sort((a, b) => a.index - b.index)
    .map((sentence) => sentence.text)
    .join('\n');
}
