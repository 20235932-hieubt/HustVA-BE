import { demoToolAccess } from '../auth/tool-access.js';
import { authRequired } from '../auth/demo-service.js';
import type { DemoPrincipal } from '../auth/demo-service.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AgentInput } from '../agent/graph.js';
import { runChatTool, type ChatTools } from '../tools/chat.js';
import type { ToolSelector } from '../tools/selector.js';
import type { SystemOneTurn } from '../system-one/turn.js';
import { addTraceContext, logger, withTrace } from '../observability/logger.js';
import { checkInput, hasSecret, normalize } from '../guardrails/policy.js';
import { isGradeTool } from '../tools/grades.js';
import { isPrivateTool } from '../tools/student-data.js';
import { isResearchTool } from '../tools/research-topics.js';
import {
  researchReferences,
  type ResearchLookupStore,
} from '../tools/research-lookup.js';
import { runResearchTool } from '../tools/research-chat.js';
import { pendingContext, validPending } from '../tools/pending-request.js';
import {
  examSemesterFromContext,
  type ToolBudget,
} from '../tools/exam-semester.js';
import {
  isGradeLookupRequest,
  isExamLookupRequest,
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
    private readonly examOptions:
      ({ enabled: boolean } & ToolBudget) | undefined = undefined,
    private readonly researchOptions:
      | ({ enabled: boolean; store: ResearchLookupStore } & ToolBudget)
      | undefined = undefined,
    private readonly multiTurnToolsEnabled = false,
    /** Undefined when System One is off: the old path runs unchanged. */
    private readonly systemOne?: SystemOneTurn,
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
  /** Status of the latest completed turn other than the current request. */
  private async previousStatus(id: string, requestId: string) {
    const [previous] = (await this.store.list(id, 2, 0)).filter(
      (turn) => turn.requestId !== requestId,
    );
    return previous?.result?.status;
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
      allowGradeLookup:
        this.gradeOptions?.enabled &&
        (Boolean(principal) || this.multiTurnToolsEnabled),
    });
    if (
      !screen.result &&
      isExamLookupRequest(input.message) &&
      ((!principal && !this.multiTurnToolsEnabled) ||
        !this.examOptions?.enabled)
    )
      screen.result = principal
        ? reply(
            'insufficient_evidence',
            'Tính năng tra cứu lịch thi chưa được bật trong môi trường này.',
            'HUST_EXAMS_DISABLED',
          )
        : reply(
            'requires_authentication',
            'Vui lòng đăng nhập tài khoản demo trên trang bên ngoài để tra cứu lịch thi của bạn.',
            'DEMO_AUTH_REQUIRED',
          );
    if (
      !screen.result &&
      (!this.gradeOptions?.enabled ||
        (!principal && !this.multiTurnToolsEnabled)) &&
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
          'Kết quả cá nhân không được lưu để phát lại. Hãy gửi yêu cầu mới nếu cần tra cứu lại.',
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
        !screen.result &&
        (this.gradeOptions?.enabled || this.examOptions?.enabled)
          ? prepareStudentSubjects(
              input.message,
              principal
                ? undefined
                : await this.gradeOptions?.subjects.load(id, tokenHash(token)),
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
      if (prepared && principal && this.examOptions?.enabled) {
        const recent = (await this.store.list(id, 10, 0)).find(
          (turn) =>
            turn.status === 'completed' &&
            turn.examLookup &&
            turn.examLookup.expiresAt > new Date() &&
            Date.now() - turn.createdAt.getTime() <= 30 * 60_000,
        );
        if (recent?.examLookup) {
          prepared.references.examLookupPending =
            !this.multiTurnToolsEnabled && !recent.examLookup.semester;
          prepared.references.examSemester = examSemesterFromContext(
            recent.examLookup.semester
              ? {
                  code: recent.examLookup.semester,
                  establishedAt: recent.createdAt,
                  expiresAt: recent.examLookup.expiresAt,
                }
              : undefined,
          );
        }
      }
      const researchAllowed =
        !this.multiTurnToolsEnabled ||
        (this.store.researchContextAllowed
          ? await this.store.researchContextAllowed(id)
          : (await this.store.list(id, 50, 0)).find(
              (turn) =>
                turn.status === 'completed' && turn.pendingTool !== undefined,
            )?.researchContextAllowed === true);
      const researchState =
        !screen.result && researchAllowed && this.researchOptions?.enabled
          ? await this.researchOptions.store.load(id, tokenHash(token))
          : undefined;
      const pendingTool =
        this.multiTurnToolsEnabled && !screen.result
          ? this.store.loadPending
            ? await this.store.loadPending(id)
            : validPending(
                (await this.store.list(id, 50, 0)).find(
                  (turn) =>
                    turn.status === 'completed' &&
                    turn.pendingTool !== undefined,
                )?.pendingTool,
              )
          : undefined;
      // Allocate new name tokens before sealing; never reuse a token from an old turn.
      if (pendingTool) pendingContext(pendingTool, privacy);
      const lookupReferences = researchState
        ? researchReferences(researchState, privacy)
        : undefined;
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
            'Bạn chỉ được tra cứu dữ liệu của tài khoản đang đăng nhập.',
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
      // System One before tool routing: the input gate (site a) may answer
      // the turn; tool skip (site f) may bypass the Gemini tool selector.
      // Skipped when an earlier check already answered or a tool request is
      // pending, so follow-up replies always reach the selector.
      const pre =
        screen.result || subjectResult || pendingTool || !this.systemOne
          ? undefined
          : await abortable(
              this.systemOne.beforeRouting(
                {
                  message: safeMessage,
                  previousStatus: await this.previousStatus(
                    id,
                    input.requestId,
                  ),
                },
                signal,
              ),
              signal,
            );
      // Signed-in demo accounts may look up their own data: fail open to routing.
      const gate =
        principal && pre?.action?.result.status === 'requires_authentication'
          ? undefined
          : pre?.action;
      if (gate) record.retainInContext = gate.retainInContext;
      // Deterministic private-lookup cues always reach the selector.
      const skipTools =
        pre?.skipTools &&
        !isGradeLookupRequest(input.message) &&
        !isExamLookupRequest(input.message);
      const toolPlan =
        !subjectResult &&
        !gate &&
        !skipTools &&
        routingMessage !== undefined &&
        this.selector
          ? await abortable(
              this.selector.select(
                routingMessage,
                signal,
                prepared?.references,
                lookupReferences,
                this.multiTurnToolsEnabled
                  ? { pending: pendingTool, expiresAt: conversation.expiresAt }
                  : undefined,
              ),
              signal,
            )
          : undefined;
      if (toolPlan) record.retainInContext = false;
      if (isResearchTool(toolPlan?.id ?? '') && !this.researchOptions?.enabled)
        throw new ChatError(
          403,
          'HUST_TOPICS_DISABLED',
          'Tra cứu đề tài chưa được bật.',
        );
      // Never answer a personal grade request using retrieval/model-generated numbers.
      const gradeFallback =
        !this.multiTurnToolsEnabled &&
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
      const examFallback =
        !this.multiTurnToolsEnabled &&
        !screen.result &&
        !subjectResult &&
        isExamLookupRequest(input.message) &&
        toolPlan?.id !== 'get_exams'
          ? reply(
              'needs_clarification',
              'Bạn muốn tra lịch thi học kỳ nào? Hãy gửi mã học kỳ hoặc nói “kỳ hiện tại”.',
              'HUST_EXAM_SEMESTER_REQUIRED',
            )
          : undefined;
      if (toolPlan?.id === 'get_exams' && !this.examOptions?.enabled)
        throw new ChatError(
          403,
          'HUST_EXAMS_DISABLED',
          'Tra cứu lịch thi chưa được bật trong môi trường này.',
        );
      if (isGradeTool(toolPlan?.id ?? '') && !this.gradeOptions?.enabled)
        throw new ChatError(
          403,
          'HUST_GRADES_DISABLED',
          'Tra cứu điểm chưa được bật trong môi trường này.',
        );
      const continuationAuth =
        this.multiTurnToolsEnabled &&
        isPrivateTool(toolPlan?.pendingRequest?.tool ?? toolPlan?.id ?? '') &&
        !principal
          ? reply(
              'requires_authentication',
              'Bạn cần đăng nhập để tra cứu dữ liệu cá nhân. Mình đã giữ phần thông tin tra cứu trong phiên còn hiệu lực.',
              'DEMO_AUTH_REQUIRED',
            )
          : undefined;
      if (isPrivateTool(toolPlan?.id ?? '') && !continuationAuth) {
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
        gate?.result ??
        continuationAuth ??
        examFallback ??
        gradeFallback ??
        (toolPlan?.id === 'cancel_tool_request'
          ? reply(
              'answered',
              'Đã hủy yêu cầu tra cứu đang chờ.',
              'HUST_REQUEST_CANCELLED',
            )
          : toolPlan?.id === 'unavailable_tool_request'
            ? reply(
                'insufficient_evidence',
                'Tính năng tra cứu này chưa được bật.',
                'HUST_TOOL_DISABLED',
              )
            : toolPlan?.id === 'clarify_tool_request'
              ? reply(
                  'needs_clarification',
                  toolPlan.clarification!,
                  'HUST_ARGUMENT_REQUIRED',
                )
              : undefined) ??
        (toolPlan?.research && this.tools && this.researchOptions?.enabled
          ? await abortable(
              runResearchTool(toolPlan.research, this.tools, signal, {
                previous: researchState,
                budget: this.researchOptions,
                expiresAt: conversation.expiresAt,
                access: principal ? demoToolAccess(principal) : undefined,
                save: async (state) => {
                  signal.throwIfAborted();
                  await principal?.validate();
                  await this.researchOptions!.store.save(
                    id,
                    tokenHash(token),
                    runId,
                    state,
                  );
                },
              }),
              signal,
            )
          : toolPlan && this.tools
            ? await abortable(
                runChatTool(
                  toolPlan,
                  this.tools,
                  signal,
                  principal ? demoToolAccess(principal) : undefined,
                  {
                    budget: this.examOptions,
                    onExamSemester: (semester) => {
                      record.examLookup = {
                        semester,
                        expiresAt: new Date(
                          Math.min(
                            conversation.expiresAt.getTime(),
                            Date.now() + 30 * 60_000,
                          ),
                        ),
                      };
                    },
                  },
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
      if (this.multiTurnToolsEnabled) {
        const keep =
          ['needs_clarification', 'requires_authentication'].includes(
            result.status,
          ) ||
          (result.status === 'insufficient_evidence' &&
            !['HUST_TOOL_EMPTY', 'HUST_TOPICS_EMPTY'].includes(
              result.reasonCode,
            ));
        record.pendingTool = keep
          ? (validPending(toolPlan?.pendingRequest) ?? null)
          : null;
        record.researchContextAllowed = Boolean(
          (toolPlan?.research ||
            isResearchTool(toolPlan?.pendingRequest?.tool ?? '')) &&
          result.status !== 'blocked',
        );
      }
      if (isPrivateTool(toolPlan?.id ?? '')) await principal?.validate();
      if (toolPlan?.id === 'get_exams' && !record.examLookup)
        record.examLookup = {
          expiresAt: new Date(
            Math.min(
              conversation.expiresAt.getTime(),
              Date.now() + 30 * 60_000,
            ),
          ),
        };
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
              toolPlan?.id === 'get_exams'
                ? 'Đã hiển thị phản hồi tra cứu lịch thi. Lịch thi cá nhân không được lưu; hãy gửi yêu cầu mới để tra cứu lại.'
                : isGradeTool(toolPlan?.id ?? '')
                  ? 'Kết quả điểm cá nhân chỉ được trả trực tiếp, không lưu trong lịch sử. Gửi yêu cầu mới để tra cứu lại.'
                  : 'Đã hiển thị hồ sơ sinh viên. Nội dung hồ sơ không được lưu; hãy hỏi lại để xem.',
              toolPlan?.id === 'get_exams'
                ? 'HUST_EXAMS_NOT_STORED'
                : isGradeTool(toolPlan?.id ?? '')
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
        (gate?.retainUser ?? screen.retainUser)
          ? mergedContext
          : publicContext(conversation.context),
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
