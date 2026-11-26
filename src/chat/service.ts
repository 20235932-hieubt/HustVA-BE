import { demoToolAccess } from '../auth/tool-access.js';
import { authRequired } from '../auth/demo-service.js';
import type { DemoPrincipal } from '../auth/demo-service.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AgentInput } from '../agent/graph.js';
import { runChatTool, type ChatTools } from '../tools/chat.js';
import type { ToolSelector } from '../tools/selector.js';
import { addTraceContext, logger, withTrace } from '../observability/logger.js';
import { checkInput, hasSecret, normalize } from '../guardrails/policy.js';
import { isGradeTool } from '../tools/grades.js';
import {
  isGradeLookupRequest,
  prepareStudentSubjects,
  type StudentSubjectStore,
} from '../tools/student-subject.js';
import {
  PrivacySession,
  privacyVersion,
  publicContext,
  withPrivacy,
} from '../privacy/session.js';
import {
  ChatError,
  reply,
  messageSchema,
  type ChatResult,
  type MessageInput,
} from './contracts.js';
import {
  tokenHash,
  type ConversationStore,
  type RequestRecord,
} from './repository.js';

const isPrivateTool = (id: string) =>
  isGradeTool(id) || id === 'get_student_info' || id === 'get_academic_result';

export type AgentRunner = (
  input: AgentInput,
  signal: AbortSignal,
) => Promise<ChatResult>;
const notFound = () =>
  new ChatError(
    404,
    'CONVERSATION_NOT_FOUND',
    'Không tìm thấy phiên hoặc không có quyền truy cập.',
  );

export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
export function publicRecord(record: RequestRecord) {
  return {
    requestId: record.requestId,
    runId: record.runId,
    message: record.user,
    status: record.status,
    result: record.result ?? null,
    errorCode: record.errorCode,
    createdAt: record.createdAt,
    replayable: !record.nonReplayable,
  };
}

export class ChatService {
  constructor(
    private readonly store: ConversationStore,
    private readonly run: AgentRunner,
    private readonly timeoutMs = 30_000,
    private readonly tools?: ChatTools,
    private readonly selector?: ToolSelector,
    private readonly gradeOptions:
      | { enabled: boolean; subjects: StudentSubjectStore }
      | undefined = undefined,
  ) {}
  async create(principal?: DemoPrincipal) {
    await principal?.validate();
    const token = randomBytes(32).toString('base64url');
    const conversation = await this.store.create(
      tokenHash(token),
      principal?.accountId,
    );
    addTraceContext({ conversationId: conversation._id });
    logger.info('chat.conversation.created', {
      conversationId: conversation._id,
    });
    return {
      conversationId: conversation._id,
      token,
      expiresAt: conversation.expiresAt,
    };
  }
  private async owned(id: string, token: string, principal?: DemoPrincipal) {
    const conversation = await this.store.find(id, tokenHash(token));
    await principal?.validate();
    if (
      !conversation ||
      (conversation.ownerAccountId &&
        conversation.ownerAccountId !== principal?.accountId)
    )
      throw notFound();
    return conversation;
  }
  async history(
    id: string,
    token: string,
    limit: number,
    offset: number,
    principal?: DemoPrincipal,
  ) {
    await this.owned(id, token, principal);
    const records = (await this.store.list(id, limit, offset)).map(
      publicRecord,
    );
    logger.debug('chat.history.loaded', {
      conversationId: id,
      historyTurns: records.length,
    });
    return records;
  }
  async request(
    id: string,
    token: string,
    requestId: string,
    principal?: DemoPrincipal,
  ) {
    await this.owned(id, token, principal);
    const record = await this.store.request(id, requestId);
    if (!record)
      throw new ChatError(
        404,
        'REQUEST_NOT_FOUND',
        'Không tìm thấy lượt xử lý.',
      );
    return publicRecord(record);
  }
  async remove(id: string, token: string, principal?: DemoPrincipal) {
    await this.owned(id, token, principal);
    const runId = randomUUID();
    if (
      !(await this.store.acquire(
        id,
        tokenHash(token),
        runId,
        new Date(Date.now() + 30_000),
      ))
    )
      throw new ChatError(
        409,
        'CONVERSATION_BUSY',
        'Phiên đang xử lý một lượt; thử lại sau.',
      );
    try {
      await this.store.remove(id);
      logger.info('chat.conversation.deleted', { conversationId: id, runId });
    } finally {
      await this.store.release(id, runId);
    }
  }
  async message(
    id: string,
    token: string,
    body: unknown,
    externalSignal = new AbortController().signal,
    principal?: DemoPrincipal,
  ) {
    const parsed = messageSchema.safeParse(body);
    if (!parsed.success)
      throw new ChatError(
        400,
        'MESSAGE_INVALID',
        'Cần requestId UUID, message từ 1–4000 ký tự và context hợp lệ.',
      );
    const input = parsed.data;
    const privacy = new PrivacySession(token, `${id}:${input.requestId}`);
    try {
      return await withTrace(
        { conversationId: id, requestId: input.requestId },
        () =>
          withPrivacy(privacy, () =>
            this.processMessage(
              id,
              token,
              input,
              externalSignal,
              privacy,
              principal,
            ),
          ),
      );
    } finally {
      privacy.dispose();
    }
  }
  private async processMessage(
    id: string,
    token: string,
    input: MessageInput,
    externalSignal: AbortSignal,
    privacy: PrivacySession,
    principal?: DemoPrincipal,
  ) {
    const started = performance.now();
    logger.info('chat.turn.received');
    const screen = checkInput(input.message, privacy, {
      allowGradeLookup: this.gradeOptions?.enabled && Boolean(principal),
    });
    if (
      !screen.result &&
      (!this.gradeOptions?.enabled || !principal) &&
      isGradeLookupRequest(input.message)
    )
      screen.result = reply(
        'requires_authentication',
        'Vui lòng đăng nhập tài khoản demo trên trang chat trực tiếp để tra cứu điểm của bạn.',
        'DEMO_AUTH_REQUIRED',
      );
    if (
      screen.result?.status === 'requires_authentication' &&
      isGradeLookupRequest(input.message)
    )
      screen.result = reply(
        'requires_authentication',
        'Vui lòng đăng nhập tài khoản demo trên trang chat trực tiếp để tra cứu điểm của bạn.',
        'DEMO_AUTH_REQUIRED',
      );
    // Preserve meaning for LLM routing while masking detected identifiers locally.
    const routingMessage =
      !screen.result && this.tools && this.selector
        ? privacy.pseudonymize(input.message)
        : undefined;
    const context = publicContext(input.context ?? {});
    for (const value of Object.values(context)) {
      if (hasSecret(value) || checkInput(value).result?.status === 'blocked')
        throw new ChatError(
          400,
          'CONTEXT_UNSAFE',
          'Context không được chứa định danh, thông tin xác thực hoặc chỉ dẫn vượt quyền.',
        );
    }
    const ownedConversation = await this.owned(id, token, principal);
    const safeMessage = screen.retainUser
      ? privacy.pseudonymize(input.message)
      : screen.message;
    const fingerprint = privacy.fingerprint({
      message: normalize(input.message),
      context: input.context ?? {},
    });
    const existing = await this.store.request(id, input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ChatError(
          409,
          'REQUEST_ID_REUSED',
          'requestId đã dùng cho nội dung khác.',
        );
      if (existing.nonReplayable)
        throw new ChatError(
          409,
          'REQUEST_NOT_REPLAYABLE',
          'Kết quả điểm cá nhân không được lưu để phát lại. Hãy gửi yêu cầu mới nếu cần tra cứu lại.',
        );
      if (existing.status === 'completed' && existing.result) {
        logger.info('chat.turn.replayed', {
          runId: existing.runId,
          status: existing.result.status,
          durationMs: performance.now() - started,
        });
        return {
          ...existing.result,
          answer: privacy.restore(existing.result.answer),
          conversationId: id,
          runId: existing.runId,
          requestId: input.requestId,
          replayed: true,
        };
      }
      // TODO(CHAT-01): recover abandoned pending runs after process crashes without double-calling the provider.
      throw new ChatError(
        409,
        'REQUEST_NOT_REPLAYABLE',
        'Lượt này đang xử lý hoặc đã bị gián đoạn. Xem trạng thái request; dùng requestId mới nếu cần thử lại.',
      );
    }
    const runId = randomUUID();
    addTraceContext({ runId });
    const conversation = await this.store.acquire(
      id,
      tokenHash(token),
      runId,
      new Date(Date.now() + this.timeoutMs + 15_000),
    );
    if (!conversation)
      throw new ChatError(
        409,
        'CONVERSATION_BUSY',
        'Phiên đang xử lý một lượt; chờ hoàn tất rồi gửi tiếp.',
      );
    logger.debug('chat.lease.acquired');
    const record: RequestRecord = {
      _id: `${id}:${input.requestId}`,
      conversationId: id,
      requestId: input.requestId,
      runId,
      fingerprint,
      privacyVersion,
      user: safeMessage,
      retainInContext:
        screen.retainUser &&
        !screen.result?.status.match(/^(blocked|support)$/u),
      status: 'pending',
      createdAt: new Date(),
      expiresAt: conversation.expiresAt,
    };
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          new ChatError(
            504,
            'CHAT_TIMEOUT',
            'Lượt xử lý hết thời gian; hãy kiểm tra trạng thái request trước khi thử lại.',
          ),
        ),
      this.timeoutMs,
    );
    const signal = AbortSignal.any([externalSignal, deadline.signal]);
    try {
      signal.throwIfAborted();
      await this.store.begin(record);
      logger.debug('chat.request.persisted');
      const prepared =
        !screen.result && this.gradeOptions?.enabled
          ? prepareStudentSubjects(
              input.message,
              principal
                ? undefined
                : await this.gradeOptions.subjects.load(id, tokenHash(token)),
              privacy,
              conversation.expiresAt,
            )
          : undefined;
      if (prepared && principal) {
        const selfRef = privacy.pseudonymize(principal.studentId);
        prepared.references.selfRef = selfRef;
        prepared.references.activeRef = prepared.references.explicitRefs.length
          ? prepared.references.activeRef
          : selfRef;
        // Authenticated identity is never written as a self-declared binding.
        prepared.next = undefined;
      }
      privacy.seal();
      const mergedContext = publicContext({
        ...conversation.context,
        ...context,
      });
      const history = (await this.store.list(id, 10, 0, true))
        .reverse()
        .filter((turn) => turn.result)
        .map((turn) => ({
          user: privacy.pseudonymize(turn.user),
          answer: privacy.pseudonymize(turn.result!.answer),
        }));
      logger.debug('chat.history.loaded', { historyTurns: history.length });
      if (screen.result)
        logger.info('guardrail.input.resolved', {
          status: screen.result.status,
          reasonCode: screen.result.reasonCode,
        });
      // A declaration stores context without sending it through the knowledge graph.
      const forbiddenSubject =
        principal &&
        prepared?.references.explicitRefs.some(
          (ref) => privacy.restore(ref) !== principal.studentId,
        );
      const subjectResult = forbiddenSubject
        ? reply(
            'blocked',
            'Bạn chỉ được tra cứu điểm của tài khoản đang đăng nhập.',
            'HUST_STUDENT_FORBIDDEN',
          )
        : prepared?.references.conflict
          ? reply(
              'needs_clarification',
              'Có nhiều MSSV hoặc thông tin đối tượng chưa khớp. Bạn xác định lại sinh viên cần tra cứu giúp mình nhé.',
              'HUST_SUBJECT_AMBIGUOUS',
            )
          : prepared?.next && !isGradeLookupRequest(input.message)
            ? reply(
                'answered',
                'Mình đã ghi nhận đối tượng tra cứu trong phiên này. Bạn muốn xem điểm học kỳ hay học phần nào?',
                'HUST_SUBJECT_RECORDED',
              )
            : undefined;
      const toolPlan =
        !subjectResult && routingMessage !== undefined && this.selector
          ? await abortable(
              this.selector.select(
                routingMessage,
                signal,
                prepared?.references,
              ),
              signal,
            )
          : undefined;
      if (toolPlan) record.retainInContext = false;
      // Never answer a personal grade request using retrieval/model-generated numbers.
      const gradeFallback =
        !screen.result &&
        !subjectResult &&
        isGradeLookupRequest(input.message) &&
        (!toolPlan || !isGradeTool(toolPlan.id))
          ? reply(
              'needs_clarification',
              'Bạn cho biết MSSV cần tra cứu (nếu chưa cung cấp), mã học kỳ hoặc mã học phần cụ thể nhé.',
              'HUST_GRADES_CLARIFICATION',
            )
          : undefined;
      if (isGradeTool(toolPlan?.id ?? '') && !this.gradeOptions?.enabled)
        throw new ChatError(
          403,
          'HUST_GRADES_DISABLED',
          'Tra cứu điểm chưa được bật trong môi trường này.',
        );
      if (isPrivateTool(toolPlan?.id ?? '')) {
        if (
          !principal ||
          ownedConversation.ownerAccountId !== principal.accountId
        )
          throw authRequired();
        await principal.validate();
      }
      const result =
        screen.result ??
        subjectResult ??
        gradeFallback ??
        (toolPlan && this.tools
          ? await abortable(
              runChatTool(
                toolPlan,
                this.tools,
                signal,
                principal ? demoToolAccess(principal) : undefined,
              ),
              signal,
            )
          : await abortable(
              this.run(
                { message: safeMessage, context: mergedContext, history },
                signal,
              ),
              signal,
            ));
      signal.throwIfAborted();
      if (isPrivateTool(toolPlan?.id ?? '')) await principal?.validate();
      if (prepared?.next && this.gradeOptions?.enabled)
        await this.gradeOptions.subjects.save(
          id,
          tokenHash(token),
          runId,
          prepared.next,
        );
      const privateTurn =
        isPrivateTool(toolPlan?.id ?? '') ||
        Boolean(subjectResult) ||
        Boolean(prepared?.next);
      if (privateTurn) record.retainInContext = false;
      const storedResult = isPrivateTool(toolPlan?.id ?? '')
        ? {
            ...reply(
              'handoff',
              isGradeTool(toolPlan?.id ?? '')
                ? 'Kết quả điểm cá nhân chỉ được trả trực tiếp, không lưu trong lịch sử. Gửi yêu cầu mới để tra cứu lại.'
                : 'Đã hiển thị hồ sơ sinh viên. Nội dung hồ sơ không được lưu; hãy hỏi lại để xem.',
              isGradeTool(toolPlan?.id ?? '')
                ? 'HUST_GRADES_NOT_STORED'
                : 'HUST_PROFILE_NOT_STORED',
            ),
            retrievalMode: 'hust_api' as const,
          }
        : result;
      if (isPrivateTool(toolPlan?.id ?? '')) record.nonReplayable = true;
      // Context from blocked/support messages must not poison later turns.
      await this.store.complete(
        record,
        screen.retainUser ? mergedContext : publicContext(conversation.context),
        storedResult,
      );
      if (isPrivateTool(toolPlan?.id ?? '')) await principal?.validate();
      logger.info('chat.turn.completed', {
        status: result.status,
        reasonCode: result.reasonCode,
        durationMs: performance.now() - started,
      });
      return {
        ...result,
        answer: privacy.restore(result.answer),
        conversationId: id,
        runId,
        requestId: input.requestId,
        replayed: false,
      };
    } catch (error) {
      const safe = deadline.signal.aborted
        ? (deadline.signal.reason as ChatError)
        : error instanceof ChatError
          ? error
          : new ChatError(
              503,
              'CHAT_UNAVAILABLE',
              'Chưa hoàn tất được xử lý chatbot; thử lại sau.',
            );
      logger.error('chat.turn.failed', {
        errorCode: safe.code,
        durationMs: performance.now() - started,
      });
      await this.store.fail(record, safe.code).catch(() => {
        logger.error('chat.persistence.failed', {
          errorCode: 'REQUEST_FAIL_WRITE_FAILED',
        });
      });
      throw safe;
    } finally {
      clearTimeout(timer);
      await this.store.release(id, runId).catch(() => {
        logger.warn('chat.lease.release_failed', {
          errorCode: 'LEASE_RELEASE_FAILED',
        });
      });
    }
  }
}
