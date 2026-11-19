import { performance } from 'node:perf_hooks';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import {
  ChatError,
  draftSchema,
  reply,
  type ChatResult,
  type StudentContext,
} from '../chat/contracts.js';
import {
  checkInput,
  fallback,
  hasSecret,
  normalize,
  redactPersonalData,
  validateDraft,
} from '../guardrails/policy.js';
import {
  searchSchema,
  sectionSchema,
  type Evidence,
  type KnowledgePort,
  type KnowledgeResult,
} from '../knowledge/stub.js';
import type { ChatConfig } from './config.js';
import type { AgentModel, ModelReply } from './model.js';
import { systemPrompt } from './prompts.js';
import { logger } from '../observability/logger.js';

export interface AgentInput {
  message: string;
  context: StudentContext;
  history: { user: string; answer: string }[];
}
const State = Annotation.Root({
  input: Annotation<AgentInput>(),
  messages: Annotation<BaseMessage[]>(),
  result: Annotation<ChatResult | undefined>(),
  modelCalls: Annotation<number>(),
  toolCalls: Annotation<number>(),
  toolRounds: Annotation<number>(),
  tokens: Annotation<number>(),
  seen: Annotation<string[]>(),
  /** Evidence returned by tools in this turn; only these ids may be cited or expanded. */
  evidence: Annotation<Record<string, Evidence>>(),
});
const limited = (reason: string) => {
  logger.warn('agent.budget.exceeded', { reasonCode: reason });
  return reply(
    'insufficient_evidence',
    'Lượt tra cứu đã đạt giới hạn xử lý. Mình chưa đủ căn cứ để kết luận; bạn có thể hỏi một nội dung cụ thể hơn.',
    reason,
  );
};

export function createChatAgent(model: AgentModel, knowledge: KnowledgePort, config: ChatConfig) {
  const builder = new StateGraph(State)
    .addNode('guard', (state) => {
      const screen = checkInput(state.input.message);
      logger.debug('agent.guard.checked', {
        status: screen.result?.status,
        reasonCode: screen.result?.reasonCode,
      });
      // Context is also untrusted input, not an instruction with system authority.
      for (const value of Object.values(state.input.context)) {
        if (
          hasSecret(value) ||
          redactPersonalData(value) !== normalize(value) ||
          checkInput(value).result?.status === 'blocked'
        )
          throw new ChatError(
            400,
            'CONTEXT_UNSAFE',
            'Context chỉ nhận khóa, chương trình và năm học; không gửi định danh hoặc thông tin xác thực.',
          );
      }
      const history = state.input.history
        .slice(-10)
        .flatMap((turn) => [new HumanMessage(turn.user), new AIMessage(turn.answer)]);
      return {
        result: screen.result,
        messages: [
          new SystemMessage(systemPrompt),
          ...history,
          new HumanMessage(
            JSON.stringify({ message: screen.message, context: state.input.context }),
          ),
        ],
      };
    })
    .addNode('agent', async (state, runtime) => {
      const signal = runtime.signal!;
      signal.throwIfAborted();
      // Conservative estimate, not exact token counting. Bytes overcount Vietnamese 2-3x (each
      // accented letter is 2-3 UTF-8 bytes) and exhausted the budget as soon as real evidence
      // arrived; Gemini averages ~3-4 characters per token, so characters / 2 still over-reserves.
      const reserve = Math.ceil(JSON.stringify(state.messages).length / 2) + config.maxOutputTokens;
      if (state.modelCalls >= config.maxModelCalls || state.tokens + reserve > config.maxTurnTokens)
        return { result: limited('MODEL_BUDGET') };
      const started = performance.now();
      logger.info('agent.model.started', { modelCalls: state.modelCalls + 1 });
      let response: ModelReply;
      try {
        // Last allowed model call: ask for the answer instead of letting the model plan another
        // lookup that the tools node would refuse (the turn would end with TOOL_BUDGET).
        const final =
          state.toolRounds >= config.maxToolRounds || state.modelCalls + 1 >= config.maxModelCalls;
        response = await model.invoke(
          final
            ? [
                ...state.messages,
                new HumanMessage(
                  '[Hệ thống] Đã hết lượt tra cứu. Gọi submit_answer ngay, chỉ dựa trên evidence đã nhận; nếu chưa đủ căn cứ thì chọn insufficient_evidence.',
                ),
              ]
            : state.messages,
          signal,
          { final },
        );
        signal.throwIfAborted();
      } catch (error) {
        const fields = {
          durationMs: performance.now() - started,
          modelCalls: state.modelCalls + 1,
          errorCode: error instanceof ChatError ? error.code : 'MODEL_CALL_FAILED',
        };
        if (signal.aborted) logger.warn('agent.model.aborted', fields);
        else logger.error('agent.model.failed', fields);
        throw error;
      }
      const reported = response.usage_metadata?.total_tokens;
      const tokens =
        state.tokens + (Number.isFinite(reported) && reported! >= 0 ? reported! : reserve);
      logger.info('agent.model.completed', {
        durationMs: performance.now() - started,
        modelCalls: state.modelCalls + 1,
        proposedToolCalls: response.tool_calls?.length ?? 0,
        tokens,
      });
      if (tokens > config.maxTurnTokens)
        return { result: limited('TOKEN_BUDGET'), tokens, modelCalls: state.modelCalls + 1 };
      if (response.invalid_tool_calls?.length || !response.tool_calls?.length) {
        logger.warn('agent.model.output_rejected', { reasonCode: 'MODEL_OUTPUT_INVALID' });
        return {
          tokens,
          modelCalls: state.modelCalls + 1,
          result: reply(
            'insufficient_evidence',
            fallback('insufficient_evidence').answer,
            'MODEL_OUTPUT_INVALID',
          ),
        };
      }
      return { messages: [...state.messages, response], tokens, modelCalls: state.modelCalls + 1 };
    })
    .addNode('tools', async (state, runtime) => {
      const signal = runtime.signal!;
      signal.throwIfAborted();
      const calls = (state.messages.at(-1) as ModelReply).tool_calls ?? [];
      const final = calls.find((call) => call.name === 'submit_answer');
      if (final) {
        const parsed = draftSchema.safeParse(final.args);
        // A valid draft sent alongside other tool calls is still judged on its own: validateDraft
        // only accepts evidence already granted, so the unexecuted calls cannot add citations.
        if (calls.length > 1)
          logger.warn('guardrail.draft.extra_calls_ignored', { proposedToolCalls: calls.length });
        if (!parsed.success) {
          logger.warn('guardrail.draft.rejected', { reasonCode: 'DRAFT_INVALID' });
          return {
            result: reply(
              'insufficient_evidence',
              fallback('insufficient_evidence').answer,
              'DRAFT_INVALID',
            ),
          };
        }
        const result = validateDraft(parsed.data, state.evidence);
        logger.info('guardrail.draft.validated', {
          tool: 'submit_answer',
          status: result.status,
          reasonCode: result.reasonCode,
        });
        return { result };
      }
      if (
        state.toolRounds >= config.maxToolRounds ||
        state.toolCalls + calls.length > config.maxToolCalls
      )
        return { result: limited('TOOL_BUDGET') };
      const messages = [...state.messages];
      const seen = [...state.seen];
      const evidence = { ...state.evidence };
      for (const call of calls) {
        signal.throwIfAborted();
        const fingerprint = JSON.stringify([call.name, call.args]);
        if (seen.includes(fingerprint)) return { result: limited('TOOL_LOOP') };
        seen.push(fingerprint);
        const started = performance.now();
        logger.info('agent.tool.started', {
          tool: call.name,
          toolCalls: state.toolCalls + messages.length - state.messages.length + 1,
        });
        let output: unknown = { status: 'invalid_tool', evidence: [] };
        // Schema/allowlist gate: the model only proposes calls, the backend decides what runs.
        try {
          if (call.name === 'search_knowledge') {
            const parsed = searchSchema.safeParse(call.args);
            output = parsed.success
              ? await knowledge.search(parsed.data, signal, {
                  cohort: state.input.context.cohort,
                })
              : { status: 'invalid_arguments', evidence: [] };
          } else if (call.name === 'read_document_section') {
            const parsed = sectionSchema.safeParse(call.args);
            output = !parsed.success
              ? { status: 'invalid_arguments', evidence: [] }
              : evidence[parsed.data.evidenceId]
                ? await knowledge.read(parsed.data, signal)
                : {
                    status: 'not_granted',
                    evidence: [],
                    warnings: ['Chỉ đọc thêm được evidenceId đã trả về trong lượt này.'],
                  };
          }
        } catch (error) {
          logger.error('agent.tool.failed', {
            tool: call.name,
            errorCode: 'TOOL_CALL_FAILED',
            durationMs: performance.now() - started,
          });
          throw error;
        }
        signal.throwIfAborted();
        const metadata = output as { status?: unknown; evidence?: unknown };
        logger.info('agent.tool.completed', {
          tool: call.name,
          durationMs: performance.now() - started,
          status: typeof metadata?.status === 'string' ? metadata.status : undefined,
          evidenceCount: Array.isArray(metadata?.evidence) ? metadata.evidence.length : 0,
        });
        for (const item of (output as Partial<KnowledgeResult>).evidence ?? [])
          evidence[item.id] = item;
        const payload = JSON.stringify(output);
        if (payload.length > 8000) return { result: limited('TOOL_OUTPUT_BUDGET') };
        messages.push(
          new ToolMessage({
            content: payload,
            tool_call_id: call.id ?? `call-${seen.length}`,
            name: call.name,
          }),
        );
      }
      return {
        messages,
        seen,
        evidence,
        toolCalls: state.toolCalls + calls.length,
        toolRounds: state.toolRounds + 1,
      };
    })
    .addEdge(START, 'guard')
    .addConditionalEdges('guard', (state) => (state.result ? END : 'agent'))
    .addConditionalEdges('agent', (state) => (state.result ? END : 'tools'))
    .addConditionalEdges('tools', (state) => (state.result ? END : 'agent'));
  const graph = builder.compile();
  return async (input: AgentInput, signal: AbortSignal): Promise<ChatResult> => {
    const state = await graph.invoke(
      {
        input,
        messages: [],
        result: undefined,
        modelCalls: 0,
        toolCalls: 0,
        toolRounds: 0,
        tokens: 0,
        seen: [],
        evidence: {},
      },
      { signal, recursionLimit: 20 },
    );
    signal.throwIfAborted();
    logger.info('agent.graph.completed', {
      status: state.result?.status,
      reasonCode: state.result?.reasonCode,
      modelCalls: state.modelCalls,
      toolCalls: state.toolCalls,
      toolRounds: state.toolRounds,
      tokens: state.tokens,
    });
    return state.result ?? fallback('insufficient_evidence');
  };
}
