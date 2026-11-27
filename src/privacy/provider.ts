import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { systemPrompt } from '../agent/prompts.js';
import { ChatError } from '../chat/contracts.js';
import {
  currentPrivacy,
  publicContext,
  type PrivacySession,
} from './session.js';
import { z } from 'zod';
import { hasSecret } from '../guardrails/policy.js';
import type { Evidence } from '../knowledge/stub.js';

// Rebuild provider payloads from validated fields. Only evidence registered by
// the backend knowledge adapter in this turn may reach the model.
export function providerMessages(messages: BaseMessage[]): BaseMessage[] {
  const privacy = currentPrivacy();
  privacy.seal();
  const output: BaseMessage[] = [new SystemMessage(systemPrompt)];
  const ids = new Map<string, string>();
  for (const message of messages) {
    const kind = message.getType();
    if (kind === 'system') continue;
    // Gemini returns tool-call turns with content parts; that content is dropped below, so only
    // the remaining messages must be plain text.
    const toolCallTurn =
      kind === 'ai' && ((message as AIMessage).tool_calls ?? []).length > 0;
    if (typeof message.content !== 'string' && !toolCallTurn)
      throw new ChatError(
        400,
        'PRIVACY_CONTENT_UNSUPPORTED',
        'Chưa hỗ trợ dữ liệu đa phương tiện trong chat.',
      );
    const content = typeof message.content === 'string' ? message.content : '';
    if (kind === 'human') {
      let text = content;
      let context = {};
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.message === 'string') {
          text = parsed.message;
          context = publicContext(parsed.context ?? {});
        }
      } catch (error) {
        if (error instanceof ChatError) throw error;
      }
      output.push(
        new HumanMessage(
          JSON.stringify({ message: privacy.pseudonymize(text), context }),
        ),
      );
    } else if (kind === 'ai') {
      const calls = (message as AIMessage).tool_calls ?? [];
      if (!calls.length) {
        // Apply the PII filter again to historical answers before forwarding.
        output.push(new AIMessage(privacy.pseudonymize(content)));
        continue;
      }
      // Tool-call turns are rebuilt from validated calls only; provider parts
      // in content (e.g. Gemini functionCall + thoughtSignature) are dropped.
      output.push(
        new AIMessage({
          content: '',
          tool_calls: calls.map((call) => {
            const id = `tool-${ids.size + 1}`;
            ids.set(call.id ?? '', id);
            if (
              call.name !== 'search_knowledge' &&
              call.name !== 'read_document_section'
            )
              throw new ChatError(
                503,
                'PRIVACY_TOOL_UNSUPPORTED',
                'Không gửi công cụ chưa được kiểm tra ra bên ngoài.',
              );
            return {
              id,
              name: call.name,
              args:
                call.name === 'search_knowledge'
                  ? {
                      query: publicSearchQuery(call.args.query),
                      limit:
                        typeof call.args.limit === 'number'
                          ? Math.min(5, Math.max(1, call.args.limit))
                          : 3,
                      ...(typeof call.args.sourceId === 'string' &&
                      /^[a-z0-9-]{1,60}$/u.test(call.args.sourceId)
                        ? { sourceId: call.args.sourceId }
                        : {}),
                    }
                  : {
                      evidenceId:
                        typeof call.args.evidenceId === 'string' &&
                        grantedEvidence.get(privacy)?.has(call.args.evidenceId)
                          ? call.args.evidenceId
                          : 'not_available',
                    },
            };
          }),
        }),
      );
    } else if (kind === 'tool') {
      const id = ids.get((message as ToolMessage).tool_call_id);
      if (!id)
        throw new ChatError(
          503,
          'PRIVACY_TOOL_UNPAIRED',
          'Kết quả công cụ không có lời gọi tương ứng.',
        );
      let result: unknown;
      try {
        result = JSON.parse(content);
      } catch {
        /* No raw output or error is forwarded. */
      }
      // Re-check against evidence registered in this turn; arbitrary tool payloads are dropped.
      output.push(
        new ToolMessage({
          tool_call_id: id,
          content: JSON.stringify(publicToolResult(result)),
        }),
      );
    } else
      throw new ChatError(
        400,
        'PRIVACY_ROLE_UNSUPPORTED',
        'Loại message không được phép.',
      );
  }
  return output;
}

const evidenceSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),
  text: z.string().min(1).max(8000),
  isMock: z.literal(false),
  title: z.string().max(1000).optional(),
  url: z.string().max(2000).optional(),
  documentId: z.string().max(200).optional(),
  versionId: z.string().max(200).optional(),
  location: z.string().max(1000).optional(),
  quality: z.string().max(80).optional(),
  score: z.number().finite().optional(),
});
const resultSchema = z.object({
  status: z.enum([
    'not_implemented',
    'empty',
    'results',
    'unavailable',
    'not_granted',
    'invalid_tool',
    'invalid_arguments',
  ]),
  evidence: z.array(z.unknown()).max(20),
});
// Weak keys keep this registry scoped to the privacy session's lifetime.
const grantedEvidence = new WeakMap<PrivacySession, Map<string, Evidence>>();

export function publicToolResult(value: unknown, register = false) {
  const privacy = currentPrivacy();
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return { status: 'empty', evidence: [], warnings: [] };
  let granted = grantedEvidence.get(privacy);
  if (!granted) {
    granted = new Map();
    grantedEvidence.set(privacy, granted);
  }
  const evidence: Evidence[] = [];
  for (const candidate of parsed.data.evidence) {
    const item = evidenceSchema.safeParse(candidate);
    if (!item.success) continue;
    if (register) {
      if (hasSecret(JSON.stringify(item.data))) continue;
      const safe: Evidence = {
        ...item.data,
        text: privacy.pseudonymize(item.data.text),
      };
      for (const key of ['title', 'location'] as const)
        if (safe[key]) safe[key] = privacy.pseudonymize(safe[key]!);
      if (safe.url) {
        try {
          const url = new URL(safe.url);
          if (
            !['https:', 'http:'].includes(url.protocol) ||
            url.username ||
            url.password
          )
            delete safe.url;
          else {
            url.search = '';
            url.hash = '';
            safe.url = url.href;
          }
        } catch {
          delete safe.url;
        }
      }
      granted.set(safe.id, safe);
      evidence.push(safe);
    } else {
      const existing = granted.get(item.data.id);
      if (existing && JSON.stringify(existing) === JSON.stringify(item.data))
        evidence.push(existing);
    }
  }
  return {
    status:
      parsed.data.status === 'results' && !evidence.length
        ? 'empty'
        : parsed.data.status,
    evidence,
    warnings: evidence.some((item) => item.quality !== 'accepted')
      ? [
          'Nội dung chưa được duyệt; cần đối chiếu bản gốc trước khi dùng làm căn cứ chính thức.',
        ]
      : [],
  };
}

export function publicSearchQuery(value: unknown): string {
  return (
    currentPrivacy()
      .pseudonymize(typeof value === 'string' && !hasSecret(value) ? value : '')
      .slice(0, 300) || 'dịch vụ sinh viên'
  );
}
