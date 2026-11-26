import { fold } from '../guardrails/policy.js';
import type { PrivacySession } from '../privacy/session.js';
import { studentIdSchema } from './grades.js';

/** Self-declared session context only. Never an assertion of student ownership. */
export interface StudentSubjects {
  self?: string;
  active?: string;
  source: 'user_provided';
  establishedAt: Date;
  expiresAt: Date;
}
export interface SubjectReferences {
  selfRef?: string;
  activeRef?: string;
  explicitRefs: string[];
  conflict: boolean;
}
export interface StudentSubjectStore {
  load(id: string, ownerHash: string): Promise<StudentSubjects | undefined>;
  save(
    id: string,
    ownerHash: string,
    runId: string,
    state: StudentSubjects,
  ): Promise<void>;
}

export function prepareStudentSubjects(
  message: string,
  previous: StudentSubjects | undefined,
  privacy: PrivacySession,
  conversationExpiry: Date,
  now = new Date(),
): { references: SubjectReferences; next?: StudentSubjects } {
  const state = previous && previous.expiresAt > now ? previous : undefined;
  const masked = privacy.pseudonymize(message);
  const explicitRefs = privacy
    .references(masked)
    .filter(
      (ref) =>
        ref.startsWith('[[PII_ID_') &&
        studentIdSchema.safeParse(privacy.restore(ref)).success,
    );
  const ids = [...new Set(explicitRefs.map((ref) => privacy.restore(ref)))];
  const value = fold(message);
  const selfStatement =
    /(?:mssv|ma so sinh vien)\s+(?:cua\s+)?(?:toi|em|minh)\s*(?:la|[:=])/u.test(
      value,
    ) ||
    /(?:toi|em|minh)\s+(?:co\s+)?(?:mssv|ma so sinh vien)\s*(?:la|[:=])/u.test(
      value,
    );
  const selfRequest = /(?:cua\s+(?:toi|em|minh)|diem\s+(?:toi|em|minh))/u.test(
    value,
  );
  const conflict =
    ids.length > 1 ||
    Boolean(
      ids.length === 1 &&
      state?.self &&
      (selfStatement || selfRequest) &&
      ids[0] !== state.self,
    );
  let next: StudentSubjects | undefined;
  if (!conflict && ids.length === 1) {
    next = {
      ...state,
      ...(selfStatement ? { self: ids[0] } : {}),
      active: ids[0],
      source: 'user_provided',
      establishedAt: now,
      expiresAt: new Date(
        Math.min(conversationExpiry.getTime(), now.getTime() + 30 * 60_000),
      ),
    };
  }
  const selected = next ?? state;
  const ref = (id: string | undefined) =>
    id ? privacy.pseudonymize(id) : undefined;
  return {
    next,
    references: {
      selfRef: ref(selected?.self),
      activeRef: ref(selected?.active),
      explicitRefs,
      conflict,
    },
  };
}

export function resolveStudentSubject(
  selection: {
    subject: 'self' | 'active' | 'explicit';
    studentIdRef?: string | null;
  },
  context: SubjectReferences,
  privacy: PrivacySession,
): string | undefined {
  if (context.conflict) return undefined;
  const reference =
    selection.subject === 'self'
      ? context.selfRef
      : selection.subject === 'active'
        ? context.activeRef
        : selection.studentIdRef;
  if (
    !reference ||
    !reference.startsWith('[[PII_ID_') ||
    !privacy.owns(reference)
  )
    return undefined;
  if (
    selection.subject !== 'explicit' &&
    selection.studentIdRef &&
    selection.studentIdRef !== reference
  )
    return undefined;
  if (
    selection.subject === 'explicit' &&
    !context.explicitRefs.includes(reference)
  )
    return undefined;
  const parsed = studentIdSchema.safeParse(privacy.restore(reference));
  return parsed.success ? parsed.data : undefined;
}
