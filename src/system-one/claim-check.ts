import { performance } from 'node:perf_hooks';
import { reply, type ChatResult, type Draft } from '../chat/contracts.js';
import { fallback, validateDraft } from '../guardrails/policy.js';
import type { Evidence } from '../knowledge/stub.js';
import { logger } from '../observability/logger.js';
import type { PrivacySession } from '../privacy/session.js';
import { createSystemOneClient, type SystemOneClient } from './client.js';
import { isSiteActive, type SystemOneConfig } from './config.js';
import { missingFacts, selectEvidenceSentences } from './facts.js';
import type { SystemOneQuestion } from './response.js';
import {
  jsonlSink,
  noopSink,
  type DecisionSink,
  type SystemOneAction,
} from './sink.js';

// Site b (claim check): drop draft claims that the cited evidence does not
// support, before validateDraft renders the answer.

export const SUPPORT_QUESTION_ID = 'ho_tro';
/** Probe step 2: drop below 0.30 (0/10 true claims dropped, 9/10 false). */
export const CLAIM_SUPPORT_MIN = 0.3;
export const CLAIMS_UNSUPPORTED = 'CLAIMS_UNSUPPORTED';
/** demo-plan "Cần chốt" #6. */
export const CLAIMS_DROPPED_WARNING =
  'Một số nội dung chưa đối chiếu được với tài liệu nên đã được lược bỏ.';
/** Sink label for a claim dropped by the code check (no model call). */
export const FACT_MISMATCH_LABEL = 'fact_mismatch';

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

export interface ClaimChecker {
  /**
   * Returns what validateDraft would return, minus unsupported claims.
   * A draft that validateDraft rejects is returned as rejected, unchecked.
   * System One failures keep the claim; never throws on its own.
   */
  review(
    draft: Draft,
    granted: Record<string, Evidence>,
    privacy: PrivacySession,
    signal: AbortSignal,
  ): Promise<ChatResult>;
}
export interface ClaimCheckerDeps {
  client?: SystemOneClient;
  sink?: DecisionSink;
  log?: Pick<typeof logger, 'info' | 'warn'>;
  now?: () => number;
}

interface Verdict {
  keep: boolean;
  failed: boolean;
}
type Claim = Draft['claims'][number];

/** P(true) of the support question; null when unusable (kept). */
function supportProbability(
  decision: Awaited<ReturnType<SystemOneClient['decide']>>,
): number | null {
  if (!decision || decision.truncated) return null;
  const answer = decision.answers[SUPPORT_QUESTION_ID];
  return answer?.type === 'noul' ? answer.probability : null;
}

/** Cited passages; all ids are granted once validateDraft accepted the draft. */
function citedEvidence(claim: Claim, granted: Record<string, Evidence>) {
  const sources = [...new Set(claim.evidenceIds)].map((id) => granted[id]);
  const combined: ClaimEvidence =
    sources.length === 1
      ? { text: sources[0].text, location: sources[0].location }
      : {
          text: sources
            .map((e) => (e.location ? `${e.location}\n${e.text}` : e.text))
            .join('\n'),
        };
  const haystack = sources
    .map((e) => [e.title, e.location, e.text].filter(Boolean).join('\n'))
    .join('\n');
  return { combined, haystack };
}

/** Undefined when site b is inactive: graph.ts keeps calling validateDraft. */
export function createClaimChecker(
  config: SystemOneConfig,
  deps: ClaimCheckerDeps = {},
): ClaimChecker | undefined {
  if (config.mode === 'off' || !isSiteActive(config, 'claimCheck'))
    return undefined;
  const mode = config.mode;
  const client = deps.client ?? createSystemOneClient(config);
  const sink = deps.sink ?? (mode === 'shadow' ? jsonlSink() : noopSink);
  const log = deps.log ?? logger;
  const now = deps.now ?? (() => performance.now());
  const dropAction: SystemOneAction = mode === 'shadow' ? 'shadow' : 'acted';

  async function judge(
    claim: Claim,
    granted: Record<string, Evidence>,
    privacy: PrivacySession,
    signal: AbortSignal,
  ): Promise<Verdict> {
    // Same text validateDraft renders, so tokens never leave as raw values.
    const text = privacy.pseudonymize(claim.text);
    const { combined, haystack } = citedEvidence(claim, granted);
    const state = buildClaimState(text, combined);
    if (missingFacts(text, haystack).length) {
      sink.write({
        site: 'claim_check',
        mode,
        action: dropAction,
        label: FACT_MISMATCH_LABEL,
        state,
        answers: null,
      });
      return { keep: false, failed: false };
    }
    const decision = await client.decide(state, buildClaimQuestions(), signal);
    const probability = supportProbability(decision);
    const keep = probability === null || probability >= CLAIM_SUPPORT_MIN;
    let action: SystemOneAction = keep ? 'passed' : dropAction;
    if (!decision) action = 'failed';
    else if (probability === null) action = 'low_confidence';
    sink.write({
      site: 'claim_check',
      mode,
      action,
      label: SUPPORT_QUESTION_ID,
      probability: probability ?? undefined,
      state,
      answers: decision?.answers ?? null,
      latencyMs: decision?.latencyMs,
    });
    return { keep, failed: !decision };
  }

  return {
    async review(draft, granted, privacy, signal) {
      const baseline = validateDraft(draft, granted, privacy);
      // Filtering must not rescue a draft the gate rejects (unknown PII
      // token, secret, ungranted id) or touch non-answers.
      if (baseline.status !== 'answered') return baseline;
      const started = now();
      let verdicts: Verdict[];
      try {
        verdicts = await Promise.all(
          draft.claims.map((claim) => judge(claim, granted, privacy, signal)),
        );
      } catch {
        log.warn('guardrail.claims.check_failed', {
          errorCode: 'CLAIM_CHECK_FAILED',
          systemOneSite: 'claim_check',
          durationMs: Math.max(0, now() - started),
        });
        return baseline;
      }
      const dropped = verdicts.filter((verdict) => !verdict.keep).length;
      let action: SystemOneAction = dropped ? dropAction : 'passed';
      if (!dropped && verdicts.every((verdict) => verdict.failed))
        action = 'failed';
      log.info('guardrail.claims.checked', {
        systemOneSite: 'claim_check',
        systemOneAction: action,
        claimsChecked: verdicts.length,
        claimsDropped: dropped,
        durationMs: Math.max(0, now() - started),
      });
      if (mode === 'shadow' || !dropped) return baseline;
      const claims = draft.claims.filter((_, index) => verdicts[index].keep);
      if (!claims.length)
        return reply(
          'insufficient_evidence',
          fallback('insufficient_evidence').answer,
          CLAIMS_UNSUPPORTED,
        );
      // entityRefs stay as they are: a token left only there is still owned.
      const result = validateDraft({ ...draft, claims }, granted, privacy);
      return result.status === 'answered'
        ? { ...result, warnings: [...result.warnings, CLAIMS_DROPPED_WARNING] }
        : result;
    },
  };
}
