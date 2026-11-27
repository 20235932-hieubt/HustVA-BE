import { AsyncLocalStorage } from 'node:async_hooks';

type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export interface TraceContext {
  traceId?: string;
  conversationId?: string;
  requestId?: string;
  runId?: string;
}
export interface LogFields extends TraceContext {
  method?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
  status?: string;
  reasonCode?: string;
  errorCode?: string;
  providerStatus?: number;
  tool?: string;
  modelCalls?: number;
  toolCalls?: number;
  proposedToolCalls?: number;
  toolRounds?: number;
  tokens?: number;
  historyTurns?: number;
  evidenceCount?: number;
  port?: number;
  systemOneSite?: string;
  systemOneLabel?: string;
  systemOneAction?: string;
  systemOneProbPct?: number;
  claimsChecked?: number;
  claimsDropped?: number;
  chunksDropped?: number;
}

const context = new AsyncLocalStorage<TraceContext>();
const ranks: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ids = new Set(['traceId', 'conversationId', 'requestId', 'runId']);
const numbers = new Set([
  'statusCode',
  'durationMs',
  'providerStatus',
  'modelCalls',
  'toolCalls',
  'proposedToolCalls',
  'toolRounds',
  'tokens',
  'historyTurns',
  'evidenceCount',
  'port',
  'claimsChecked',
  'claimsDropped',
  'chunksDropped',
]);
const statuses = new Set([
  'answered',
  'needs_clarification',
  'insufficient_evidence',
  'out_of_scope',
  'requires_authentication',
  'handoff',
  'blocked',
  'support',
  'not_implemented',
  'invalid_tool',
  'invalid_arguments',
  'empty',
  'ok',
  'success',
  'error',
  'timeout',
  'cancelled',
  'disabled',
  'not_configured',
  'not_found',
  'busy',
]);
const systemOneSites = new Set([
  'input_gate',
  'tool_skip',
  'clarify',
  'claim_check',
  'unit_hint',
  'relevance',
]);
const systemOneActions = new Set([
  'acted',
  'passed',
  'low_confidence',
  'failed',
  'shadow',
  'skipped',
]);

// Only operational metadata crosses this boundary. Never accept bodies, prompts,
// tool arguments/results, headers, URLs, error messages/stacks or arbitrary objects.
function safeFields(fields: LogFields): Record<string, string | number> {
  const safe: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ids.has(key) && typeof value === 'string' && uuid.test(value))
      safe[key] = value;
    else if (
      numbers.has(key) &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0
    )
      safe[key] = Math.round(value);
    else if (
      key === 'status' &&
      typeof value === 'string' &&
      statuses.has(value)
    )
      safe[key] = value;
    else if (
      (key === 'reasonCode' || key === 'errorCode') &&
      typeof value === 'string' &&
      /^[A-Z][A-Z0-9_-]{0,63}$/u.test(value)
    )
      safe[key] = value;
    else if (
      key === 'method' &&
      typeof value === 'string' &&
      /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/u.test(value)
    )
      safe[key] = value;
    else if (
      key === 'route' &&
      typeof value === 'string' &&
      /^\/[a-zA-Z0-9/:_-]{0,120}$/u.test(value)
    )
      safe[key] = value;
    else if (
      key === 'systemOneProbPct' &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 100
    )
      safe[key] = Math.round(value);
    else if (
      key === 'systemOneSite' &&
      typeof value === 'string' &&
      systemOneSites.has(value)
    )
      safe[key] = value;
    else if (
      key === 'systemOneAction' &&
      typeof value === 'string' &&
      systemOneActions.has(value)
    )
      safe[key] = value;
    // Labels are ids we define (question ids, criteria keys), never free text.
    else if (
      key === 'systemOneLabel' &&
      typeof value === 'string' &&
      /^[a-z][a-z0-9_]{0,39}$/u.test(value)
    )
      safe[key] = value;
    else if (key === 'tool' && typeof value === 'string')
      safe[key] = [
        'search_knowledge',
        'read_document_section',
        'submit_answer',
        'get_semesters',
        'get_study_conditions',
        'get_advanced_programs',
        'search_teachers',
        'search_companies',
        'get_grades',
        'get_exams',
        'get_teacher_research_topics',
        'get_company_research_topics',
        'get_grades_by_course',
        'get_student_info',
        'get_academic_result',
      ].includes(value)
        ? value
        : 'unknown';
  }
  return safe;
}

export function withTrace<T>(fields: TraceContext, work: () => T): T {
  return context.run({ ...context.getStore(), ...safeFields(fields) }, work);
}
export function addTraceContext(fields: TraceContext) {
  const current = context.getStore();
  if (current) Object.assign(current, safeFields(fields));
}
export function currentTrace(): TraceContext {
  return { ...context.getStore() };
}

export function createLogger(
  options: { level?: string; write?: (line: string) => void } = {},
) {
  function log(
    level: Exclude<Level, 'silent'>,
    event: string,
    fields: LogFields = {},
  ) {
    const setting = options.level ?? process.env.LOG_LEVEL ?? 'info';
    const threshold = Object.hasOwn(ranks, setting)
      ? ranks[setting as Level]
      : ranks.info;
    if (ranks[level] < threshold) return;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event: /^[a-z][a-z0-9_.]{0,79}$/u.test(event)
        ? event
        : 'log.invalid_event',
      ...safeFields({ ...context.getStore(), ...fields }),
    };
    try {
      (
        options.write ??
        ((line) => {
          process.stdout.write(line);
        })
      )(JSON.stringify(record) + '\n');
    } catch {
      // A failed log destination must not alter request processing or disclose raw errors.
    }
  }
  return {
    debug: (event: string, fields?: LogFields) => log('debug', event, fields),
    info: (event: string, fields?: LogFields) => log('info', event, fields),
    warn: (event: string, fields?: LogFields) => log('warn', event, fields),
    error: (event: string, fields?: LogFields) => log('error', event, fields),
  };
}
export const logger = createLogger();
