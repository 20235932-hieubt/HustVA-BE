import { ChatError } from '../chat/contracts.js';

export interface ChatConfig {
  apiKey?: string;
  apiKeys?: string[];
  geminiRequestsPerMinute?: number;
  geminiKeyCooldownMs?: number;
  geminiMaxAttempts?: number;
  model?: string;
  timeoutMs: number;
  maxToolRounds: number;
  maxToolCalls: number;
  maxModelCalls: number;
  maxTurnTokens: number;
  maxOutputTokens: number;
  gradesEnabled?: boolean;
  examsEnabled?: boolean;
}
export function readChatConfig(
  env: NodeJS.ProcessEnv = process.env,
): ChatConfig {
  const gradesFlag = env.CHAT_GRADES_ENABLED?.trim() || 'false';
  const examsFlag = env.CHAT_EXAMS_ENABLED?.trim() || 'false';
  if (!['true', 'false'].includes(examsFlag))
    throw new ChatError(
      503,
      'CHAT_CONFIG_INVALID',
      'Cấu hình CHAT_EXAMS_ENABLED không hợp lệ.',
    );
  if (!['true', 'false'].includes(gradesFlag))
    throw new ChatError(
      503,
      'CHAT_CONFIG_INVALID',
      'Cấu hình CHAT_GRADES_ENABLED không hợp lệ.',
    );
  const multipleKeys = (env.GEMINI_API_KEYS ?? '')
    .split(/[\r\n,]+/u)
    .map((key) => key.trim())
    .filter(Boolean);
  const apiKeys = [
    ...new Set(
      multipleKeys.length
        ? multipleKeys
        : [env.GEMINI_API_KEY?.trim()].filter((key): key is string =>
            Boolean(key),
          ),
    ),
  ];
  if (apiKeys.length > 20)
    throw new ChatError(
      503,
      'CHAT_CONFIG_INVALID',
      'GEMINI_API_KEYS chỉ nhận tối đa 20 key.',
    );
  function number(key: string, fallback: number, maximum: number) {
    const raw = env[key]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < 1 || value > maximum)
      throw new ChatError(
        503,
        'CHAT_CONFIG_INVALID',
        `Cấu hình ${key} không hợp lệ.`,
      );
    return value;
  }
  return {
    apiKey: apiKeys[0],
    apiKeys,
    geminiRequestsPerMinute: number('GEMINI_MAX_REQUESTS_PER_MINUTE', 15, 15),
    geminiKeyCooldownMs: number('GEMINI_KEY_COOLDOWN_MS', 60_000, 86_400_000),
    geminiMaxAttempts: number('GEMINI_MAX_ATTEMPTS', 2, 3),
    model: env.GEMINI_MODEL?.trim() || undefined,
    timeoutMs: number('CHAT_TIMEOUT_MS', 30_000, 60_000),
    maxToolRounds: number('CHAT_MAX_TOOL_ROUNDS', 3, 5),
    maxToolCalls: number('CHAT_MAX_TOOL_CALLS', 6, 10),
    maxModelCalls: number('CHAT_MAX_MODEL_CALLS', 4, 6),
    maxTurnTokens: number('CHAT_MAX_TURN_TOKENS', 24_000, 50_000),
    maxOutputTokens: number('CHAT_MAX_OUTPUT_TOKENS', 1200, 2000),
    gradesEnabled: gradesFlag === 'true',
    examsEnabled: examsFlag === 'true',
  };
}
