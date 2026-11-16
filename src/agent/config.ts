import { ChatError } from '../chat/contracts.js';

export interface ChatConfig {
  apiKey?: string;
  model?: string;
  timeoutMs: number;
  maxToolRounds: number;
  maxToolCalls: number;
  maxModelCalls: number;
  maxTurnTokens: number;
  maxOutputTokens: number;
}
export function readChatConfig(env: NodeJS.ProcessEnv = process.env): ChatConfig {
  function number(key: string, fallback: number, maximum: number) {
    const raw = env[key]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < 1 || value > maximum)
      throw new ChatError(503, 'CHAT_CONFIG_INVALID', `Cấu hình ${key} không hợp lệ.`);
    return value;
  }
  return {
    apiKey: env.GEMINI_API_KEY?.trim() || undefined,
    model: env.GEMINI_MODEL?.trim() || undefined,
    timeoutMs: number('CHAT_TIMEOUT_MS', 30_000, 60_000),
    maxToolRounds: number('CHAT_MAX_TOOL_ROUNDS', 3, 5),
    maxToolCalls: number('CHAT_MAX_TOOL_CALLS', 6, 10),
    maxModelCalls: number('CHAT_MAX_MODEL_CALLS', 4, 6),
    maxTurnTokens: number('CHAT_MAX_TURN_TOKENS', 12_000, 50_000),
    maxOutputTokens: number('CHAT_MAX_OUTPUT_TOKENS', 1200, 2000),
  };
}
