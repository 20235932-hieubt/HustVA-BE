// Text helpers for site b (claim check): choosing which evidence sentences go
// with a claim, and matching hard facts (numbers, dates, codes) in code.
// Pure functions.

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

// Placeholders from PrivacySession: their hex digits are not facts.
const PRIVACY_MARKS =
  /\[\[PII_(?:EMAIL|PHONE|ID|NAME)_[a-f0-9]{32}\]\]|\[thông tin đã ẩn\]|\[ĐỊNH_DANH_KHÔNG_HỢP_LỆ\]/gu;
/** Course code (IT3080, MI 1111); same pattern on both sides. */
const COURSE_CODE = /(?<![\p{L}\d])([A-Z]{2,4}) ?(\d{4})(?!\d)/gu;
/** Cohort written as K67 / K 67. */
const COHORT = /(?<![\p{L}\d])K ?(\d{2})(?!\d)/gu;
/** Cohort written in words in evidence ("khóa 67"), after fold(). */
const COHORT_WORDS = /(?<![\p{L}\d])khoa k?(\d{2})(?!\d)/gu;
/** Claim side: digits glued to letters belong to a code, not a number. */
const CLAIM_NUMBER = /(?<![\p{L}\d])\d+(?:[.,]\d+)*/gu;
/** Evidence side is lenient: every digit run counts. */
const EVIDENCE_NUMBER = /\d+(?:[.,]\d+)*/gu;
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  khong: 0,
  mot: 1,
  hai: 2,
  ba: 3,
  bon: 4,
  tu: 4,
  nam: 5,
  sau: 6,
  bay: 7,
  tam: 8,
  chin: 9,
  muoi: 10,
};

const withoutPrivacyMarks = (text: string) => text.replace(PRIVACY_MARKS, ' ');

/**
 * "3,2" and "3.2" are the same decimal; "1.500.000" and "1500000" the same
 * integer; "03" is 3. Every reading is kept, so formatting never causes a
 * mismatch on its own.
 */
function numberForms(raw: string): string[] {
  const forms = [String(Number(raw.replace(/[.,]/gu, '')))];
  const parts = raw.split(/[.,]/u);
  if (parts.length === 2) forms.push(String(Number(`${parts[0]}.${parts[1]}`)));
  return forms;
}

function codes(text: string): string[] {
  return [
    ...[...text.matchAll(COURSE_CODE)].map((m) => `${m[1]}${m[2]}`),
    ...[...text.matchAll(COHORT)].map((m) => `K${m[1]}`),
  ];
}

function evidenceFacts(evidence: string): Set<string> {
  const text = withoutPrivacyMarks(evidence);
  const folded = fold(text);
  const facts = new Set(codes(text));
  for (const match of folded.matchAll(COHORT_WORDS)) facts.add(`K${match[1]}`);
  for (const match of text.matchAll(EVIDENCE_NUMBER))
    for (const form of numberForms(match[0])) facts.add(form);
  for (const word of words(text)) {
    const value = NUMBER_WORDS[word];
    if (value !== undefined) facts.add(String(value));
  }
  return facts;
}

/**
 * Hard facts of the claim (numbers incl. dates, years, percentages; course
 * codes; cohorts) that the evidence text does not contain. Empty means the
 * claim passes the code check; it still goes to the model.
 */
export function missingFacts(claim: string, evidence: string): string[] {
  const text = withoutPrivacyMarks(claim);
  const known = evidenceFacts(evidence);
  const missing = codes(text).filter((code) => !known.has(code));
  for (const match of text.matchAll(CLAIM_NUMBER))
    if (!numberForms(match[0]).some((form) => known.has(form)))
      missing.push(match[0]);
  return [...new Set(missing)];
}
