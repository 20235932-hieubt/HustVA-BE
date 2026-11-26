import { reply, type ChatResult, type Draft } from '../chat/contracts.js';
import type { Evidence } from '../knowledge/stub.js';
import { PrivacySession } from '../privacy/session.js';

export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .trim();
}
export function fold(text: string): string {
  return normalize(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gu, 'd')
    .replace(/Đ/gu, 'D')
    .toLowerCase();
}

const secretPattern =
  /AIza[\w-]{20,}|mongodb(?:\+srv)?:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|mật khẩu|mat khau|api[_ -]?key|otp)\s*(?:là|la|[:=])\s*\S+/iu;
export function hasSecret(text: string): boolean {
  return secretPattern.test(normalize(text));
}

export function redactPersonalData(
  text: string,
  privacy?: PrivacySession,
): string {
  const session = privacy ?? new PrivacySession();
  try {
    return session.pseudonymize(text);
  } finally {
    if (!privacy) session.dispose();
  }
}

export function checkInput(
  text: string,
  privacy?: PrivacySession,
  options: { allowGradeLookup?: boolean } = {},
): {
  message: string;
  result?: ChatResult;
  retainUser: boolean;
} {
  const clean = normalize(text);
  const value = fold(clean);
  // Recognized credentials never enter the reversible personal-data map.
  const message = hasSecret(clean)
    ? '[Đã loại thông tin xác thực]'
    : redactPersonalData(clean, privacy);
  // Safety support has priority over ordinary scope/refusal rules. No invented hotline numbers.
  if (
    /(?:em|toi|minh) (?:dang |rat |chi )*(?:muon|dinh|sap) (?:tu tu|tu sat|lam hai ban than|chet)/u.test(
      value,
    )
  )
    return {
      message: '[Nội dung cần hỗ trợ an toàn]',
      retainUser: false,
      result: reply(
        'support',
        'Mình rất tiếc bạn đang phải chịu đựng điều này. Nếu bạn có thể làm hại bản thân ngay lúc này, hãy đến nơi an toàn và nhờ một người đáng tin ở bên, hoặc liên hệ dịch vụ khẩn cấp tại nơi bạn đang sống. Bạn không cần chia sẻ thông tin riêng tư ở đây.',
        'SAFE-02',
      ),
    };
  if (
    /(?:em|toi|minh) (?:dang |da )?bi (?:quay roi|bao luc|de doa|xam hai)/u.test(
      value,
    )
  )
    return {
      message: '[Nội dung cần hỗ trợ con người]',
      retainUser: false,
      result: reply(
        'support',
        'Mình rất tiếc bạn đang gặp chuyện này. Bạn không cần kể chi tiết riêng tư ở đây. Nếu đang nguy hiểm, hãy ưu tiên đến nơi an toàn và nhờ người đáng tin hỗ trợ; trường hợp này cần người hoặc đơn vị hỗ trợ phù hợp xác minh trực tiếp.',
        'SAFE-01',
      ),
    };
  if (hasSecret(clean))
    return {
      message: '[Đã loại thông tin xác thực]',
      retainUser: false,
      result: reply(
        'blocked',
        'Bạn đừng gửi mật khẩu, OTP hoặc khóa truy cập trong chat. Hãy bỏ thông tin đó và gửi lại câu hỏi về thủ tục hoặc dịch vụ sinh viên.',
        'PRIV-01',
      ),
    };
  if (
    /(?:bo qua|ignore|bypass).{0,50}(?:chi dan|quy tac|huong dan|policy|instructions)|(?:in ra|tiet lo|reveal|show).{0,40}(?:system prompt|api key|khoa bi mat|mat khau he thong)/u.test(
      value,
    )
  )
    return {
      message: '[Yêu cầu vượt giới hạn]',
      retainUser: false,
      result: reply(
        'blocked',
        'Mình không thể cung cấp cấu hình nội bộ hoặc bỏ qua giới hạn truy cập. Bạn có thể gửi riêng câu hỏi về công tác sinh viên để được hỗ trợ.',
        'SEC-01',
      ),
    };
  if (
    /(?:xem|lay|tra cuu|cho).{0,35}(?:diem|ho so|thong tin ca nhan).{0,30}(?:cua ban |sinh vien khac|nguoi khac)/u.test(
      value,
    ) ||
    // get_student_info only returns the signed-in student's profile, so a request naming a
    // specific MSSV (8-10 digits) must not fall through to it and leak/misattribute a profile.
    (/(?<!\d)\d{8,10}(?!\d)/u.test(value) &&
      !options.allowGradeLookup &&
      (!/diem/u.test(value) ||
        /cpa|gpa|diem trung binh|diem tich luy/u.test(value)) &&
      /(?:diem|ho so|thong tin|lop|co van|trang thai hoc|cpa|gpa|ket qua hoc tap|lich hoc|hoc phi)/u.test(
        value,
      ))
  )
    return {
      message,
      retainUser: true,
      result: reply(
        'blocked',
        'Mình không cung cấp hồ sơ hoặc thông tin cá nhân của sinh viên khác. Mình có thể hướng dẫn quy định và thủ tục công khai.',
        'PRIV-03',
      ),
    };
  if (
    // Own profile goes on to get_student_info; grades and applications still need auth.
    // CPA/GPA are part of get_student_info; per-course grades still need auth.
    /(?:xem|tra cuu|kiem tra).{0,30}(?:diem(?!\s*(?:cpa|gpa|trung binh|tich luy))|trang thai don).{0,20}(?:cua em|cua toi|cua minh)/u.test(
      value,
    ) &&
    !(
      options.allowGradeLookup &&
      /diem/u.test(value) &&
      !/ho so|trang thai don/u.test(value)
    )
  )
    return {
      message,
      retainUser: true,
      result: fallback('requires_authentication'),
    };
  if (/^(?:xin chao|chao|hello|hi|cam on|thank you|thanks)[!. ]*$/u.test(value))
    return {
      message,
      retainUser: true,
      result: reply(
        'answered',
        'Chào bạn! Mình hỗ trợ tra cứu thủ tục, chính sách và dịch vụ sinh viên HUST. Bạn đang cần hỗ trợ việc gì?',
        'SOCIAL',
      ),
    };
  return { message, retainUser: true };
}

export function fallback(
  status: Exclude<Draft['status'], 'answered'>,
  missingFields: Draft['missingFields'] = [],
): ChatResult {
  const templates = {
    needs_clarification: 'Bạn cần hỗ trợ thủ tục hoặc chủ đề cụ thể nào?',
    insufficient_evidence:
      'Mình chưa tìm thấy tài liệu HUST đủ căn cứ để xác nhận nội dung này, nên chưa thể kết luận quy định áp dụng. Bạn có thể hỏi cụ thể hơn hoặc liên hệ kênh chính thức của trường.',
    out_of_scope:
      'Mình tập trung hỗ trợ công tác sinh viên và thông tin học vụ HUST. Bạn có câu hỏi về thủ tục, chính sách hoặc dịch vụ sinh viên không?',
    requires_authentication:
      'Thông tin này cần dịch vụ có xác thực. Chatbot hiện chưa kết nối hồ sơ cá nhân; hãy sử dụng kênh chính thức của trường và đừng gửi mật khẩu hoặc OTP tại đây.',
    handoff:
      'Trường hợp cụ thể này cần đơn vị có thẩm quyền xác minh. Chatbot chưa có chức năng gửi hồ sơ hoặc tạo ticket; hãy liên hệ qua kênh chính thức của trường.',
    blocked:
      'Mình không thể thực hiện yêu cầu vượt quyền hoặc hỗ trợ làm sai thủ tục. Mình có thể hướng dẫn quy trình công khai, hợp lệ.',
    support:
      'Bạn không cần chia sẻ chi tiết riêng tư ở đây. Nếu đang gặp nguy hiểm, hãy ưu tiên đến nơi an toàn và nhờ người đáng tin hoặc dịch vụ khẩn cấp tại nơi bạn sống hỗ trợ.',
  };
  const labels = {
    cohort: 'khóa',
    program: 'chương trình học',
    academicYear: 'năm học',
    purpose: 'mục đích xin giấy hoặc làm thủ tục',
    topic: 'chủ đề cần hỗ trợ',
  };
  const answer =
    status === 'needs_clarification' && missingFields.length
      ? `Bạn cho biết ${[...new Set(missingFields)]
          .slice(0, 2)
          .map((field) => labels[field])
          .join(
            ' và ',
          )} được không? Thông tin này giúp xác định đúng phạm vi cần tra cứu.`
      : templates[status];
  return reply(status, answer, status.toUpperCase());
}

/**
 * Generation gate: an `answered` draft is rendered only when every claim cites evidence that a
 * tool returned in THIS turn. The answer text is built here from those claims, with numbered
 * sources, so the model cannot add uncited sentences or invent citations.
 */
export function validateDraft(
  draft: Draft,
  granted: Record<string, Evidence> = {},
  privacy?: PrivacySession,
): ChatResult {
  const references = [...new Set(draft.entityRefs ?? [])];
  const claimTokens = draft.claims.flatMap(
    (claim) =>
      claim.text.match(/\[\[PII_(?:EMAIL|PHONE|ID|NAME)_[a-f0-9]{32}\]\]/gu) ??
      [],
  );
  if ([...references, ...claimTokens].some((token) => !privacy?.owns(token)))
    return reply(
      'insufficient_evidence',
      fallback('insufficient_evidence').answer,
      'PRIVACY_REFERENCE_INVALID',
    );
  if (draft.claims.some((claim) => hasSecret(claim.text)))
    return reply(
      'insufficient_evidence',
      fallback('insufficient_evidence').answer,
      'PRIVACY_CONTENT_INVALID',
    );
  if (draft.status !== 'answered')
    return fallback(draft.status, draft.missingFields);
  if (!draft.claims.length)
    return reply(
      'insufficient_evidence',
      fallback('insufficient_evidence').answer,
      'CLAIMS_EMPTY',
    );
  const used: Evidence[] = [];
  for (const claim of draft.claims)
    for (const id of claim.evidenceIds) {
      const evidence = granted[id];
      if (!evidence || evidence.isMock)
        return reply(
          'insufficient_evidence',
          fallback('insufficient_evidence').answer,
          'CLAIM_UNGROUNDED',
        );
      if (!used.includes(evidence)) used.push(evidence);
    }
  const number = (id: string) =>
    used.findIndex((evidence) => evidence.id === id) + 1;
  const sentences = draft.claims.map(
    (claim) =>
      `${privacy ? privacy.pseudonymize(claim.text) : claim.text.trim()} [${[...new Set(claim.evidenceIds.map(number))].sort((a, b) => a - b).join(', ')}]`,
  );
  const unreviewed = used.some((evidence) => evidence.quality !== 'accepted');
  return reply('answered', sentences.join('\n\n'), 'GROUNDED', {
    citations: used.map((evidence) => ({
      evidenceId: evidence.id,
      title: evidence.title ?? '',
      url: evidence.url ?? '',
      documentId: evidence.documentId ?? '',
      versionId: evidence.versionId ?? '',
      location: evidence.location ?? '',
    })),
    warnings: unreviewed
      ? [
          'Nội dung trích từ tài liệu chưa được duyệt (thường là PDF); hãy đối chiếu bản gốc theo link nguồn.',
        ]
      : [],
  });
}
