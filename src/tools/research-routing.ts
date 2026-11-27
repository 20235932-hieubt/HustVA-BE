import { z } from 'zod';
import { fold, hasSecret } from '../guardrails/policy.js';
import type { PrivacySession } from '../privacy/session.js';
import {
  candidateRefSchema,
  type ResearchReferences,
  type ResearchRequest,
} from './research-lookup.js';
import type { ResearchKind } from './research-topics.js';

export const researchSelectionSchema = z.strictObject({
  keyWord: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullish()
    .describe(
      'Tên giảng viên/công ty trong câu hỏi, giữ token tên nếu có; null khi chọn từ context.',
    ),
  targetRef: candidateRefSchema
    .nullish()
    .describe(
      'Ref thuộc context backend khi chọn hoặc tiếp nối; null khi tìm theo tên.',
    ),
  unitHint: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullish()
    .describe(
      'Tên đơn vị/trường của giảng viên được nêu rõ trong câu, null nếu không có hoặc tra công ty.',
    ),
});
export function resolveResearchSelection(
  kind: ResearchKind,
  input: unknown,
  message: string,
  privacy: PrivacySession,
  context?: ResearchReferences,
): ResearchRequest | undefined {
  const parsed = researchSelectionSchema.safeParse(input);
  if (!parsed.success) return;
  const { keyWord, targetRef, unitHint } = parsed.data;
  if (Boolean(keyWord) === Boolean(targetRef)) return;
  if (keyWord) {
    const refs = keyWord.match(/\[\[.*?\]\]/gu) ?? [];
    if (
      refs.some(
        (ref) =>
          !/^\[\[PII_NAME_[a-f0-9]{32}\]\]$/u.test(ref) || !privacy.owns(ref),
      )
    )
      return;
    const restored = privacy.restore(keyWord).trim();
    if (
      hasSecret(restored) ||
      /@|https?:|\d{7,}|\[\[/iu.test(restored) ||
      !fold(privacy.restore(message)).includes(fold(restored))
    )
      return;
    if (unitHint) {
      const unitRefs = unitHint.match(/\[\[.*?\]\]/gu) ?? [];
      if (
        kind !== 'teacher' ||
        unitRefs.some(
          (ref) =>
            !/^\[\[PII_NAME_[a-f0-9]{32}\]\]$/u.test(ref) || !privacy.owns(ref),
        )
      )
        return;
      const unit = privacy.restore(unitHint).trim();
      if (
        hasSecret(unit) ||
        /@|https?:|\d{7,}|\[\[/iu.test(unit) ||
        !fold(privacy.restore(message)).includes(fold(unit))
      )
        return;
      return { kind, keyWord: restored, unitHint: unit };
    }
    return { kind, keyWord: restored };
  }
  if (unitHint) return;
  if (!context || context.kind !== kind) return;
  const selected = context.choices.find(
    (candidate) => candidate.ref === targetRef,
  );
  if (!selected) return;
  const text = fold(privacy.restore(message));
  const ordinals = [
    ...new Set(
      text.match(
        /(?<![a-z0-9])[1-9](?![a-z0-9])|(?<![a-z0-9])10(?![a-z0-9])/gu,
      ) ?? [],
    ),
  ].map(Number);
  const words = [
    'mot',
    'hai',
    'ba',
    'tu',
    'nam',
    'sau',
    'bay',
    'tam',
    'chin',
    'muoi',
  ];
  for (const [index, word] of words.entries())
    if (new RegExp(`(?:thu|so) ${word}\\b`, 'u').test(text))
      ordinals.push(index + 1);
  if (/dau tien/u.test(text)) ordinals.push(1);
  const byName = context.choices.filter((choice) =>
    text.includes(fold(privacy.restore(choice.label))),
  );
  const ordinalMatch =
    ordinals.length > 0 &&
    new Set(ordinals).size === 1 &&
    ordinals[0] === selected.index;
  const nameMatch = byName.length === 1 && byName[0].ref === targetRef;
  const byUnit = context.choices.filter(
    (choice) =>
      choice.unit && text.includes(fold(privacy.restore(choice.unit))),
  );
  const unitMatch = byUnit.length === 1 && byUnit[0].ref === targetRef;
  if (ordinals.length && !ordinalMatch) return;
  if (byName.length === 1 && !nameMatch) return;
  if (byUnit.length === 1 && !unitMatch) return;
  if (byUnit.length > 1 && !ordinalMatch && !nameMatch) return;
  if (
    context.selectedRef !== targetRef &&
    !ordinalMatch &&
    !nameMatch &&
    !unitMatch
  )
    return;
  return { kind, targetRef: targetRef! };
}

export const researchRoutingPrompt = `
Người dùng có thể chọn bằng đơn vị, ví dụ trả lời "Truong cong nghe thong tin va truyen thong" sau danh sách giảng viên. Nếu đúng một candidate có unit tương ứng thì dùng targetRef của candidate đó, keyWord=null và unitHint=null; không route_knowledge chỉ vì câu tiếp chỉ có tên trường. Nếu nhiều người cùng đơn vị thì hỏi số thứ tự, không chọn ngẫu nhiên.
Nếu người dùng nêu đơn vị/trường của giảng viên, đặt đúng phần đó trong unitHint để backend đối chiếu schoolName. Không tự thêm unitHint; bỏ/null nếu không được nêu. Không dùng unitHint cho công ty hoặc lựa chọn ref, không coi khoa/trường nêu trong câu là một phần tên người.
Tra đề tài của giảng viên dùng get_teacher_research_topics; đề tài công ty/thực tập tại đối tác dùng get_company_research_topics. Đây là dữ liệu dùng chung, không cần đăng nhập/MSSV. Tìm theo tên: chỉ đặt tên có trong câu vào keyWord, giữ nguyên token PII_NAME được cấp; targetRef=null. Backend tự search để lấy ID, không tự điền teacherId/companyId.
Khi chọn từ danh sách ("người thứ 2", "thứ hai") hoặc "thầy đó/công ty đó", dùng targetRef đúng ref trong lookup context backend, keyWord=null. Chưa có selectedRef và người dùng chưa chọn rõ thì hỏi lại; không mặc định lấy candidate đầu. Không tự tạo ref hoặc dùng ref khác loại. Nếu không có tên hoặc context thì ask_clarification với tool tương ứng.
Hỏi quy định/điều kiện đăng ký đồ án, thực tập dùng route_knowledge. Hỏi "tôi đã đăng ký/đang làm đề tài gì" là dữ liệu cá nhân chưa có tool, không dùng danh sách công khai để suy ra. Không search tất cả giảng viên/công ty cho yêu cầu đề tài AI hoặc lĩnh vực chung: hỏi người dùng muốn tra của ai/đơn vị nào. Không thêm tham số lọc lĩnh vực, page/limit hay mã ngành mà API không có. Chỉ gọi một tool routing; backend làm workflow.`;
