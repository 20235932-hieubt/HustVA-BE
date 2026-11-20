import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../observability/logger.js';
import type { SystemOneAnswer } from './client.js';

export type SystemOneSite =
  | 'input_gate'
  | 'tool_skip'
  | 'clarify'
  | 'claim_check'
  | 'unit_hint'
  | 'relevance';
export type SystemOneAction =
  'acted' | 'passed' | 'low_confidence' | 'failed' | 'shadow' | 'skipped';
/**
 * One System One decision kept for evaluation. `state` carries the message
 * after PII tokenisation; records only go to evals/runs (git-ignored), never
 * to the production logger.
 */
export interface DecisionRecord {
  site: SystemOneSite;
  mode: 'shadow' | 'on';
  action: SystemOneAction;
  label?: string;
  probability?: number;
  state: Record<string, string>;
  answers: Record<string, SystemOneAnswer> | null;
  latencyMs?: number;
}
export interface DecisionSink {
  /** Fire-and-forget: never throws and never delays the chat turn. */
  write(record: DecisionRecord): void;
}
export interface MemorySink extends DecisionSink {
  readonly records: readonly (DecisionRecord & { at: string })[];
}

const DEFAULT_RUNS_DIR = fileURLToPath(
  new URL('../../evals/runs/', import.meta.url),
);

export const noopSink: DecisionSink = { write: () => undefined };

export function memorySink(now: () => Date = () => new Date()): MemorySink {
  const records: (DecisionRecord & { at: string })[] = [];
  return {
    records,
    write: (record) => {
      records.push({ ...record, at: now().toISOString() });
    },
  };
}

function dayStamp(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}${month}${day}`;
}

/**
 * Appends one JSON line per decision to <dir>/shadow-YYYYMMDD.jsonl (local
 * date). Writes are chained so lines keep their order; a failed write is
 * logged by code only and dropped.
 */
export function jsonlSink(
  options: {
    dir?: string;
    now?: () => Date;
    log?: Pick<typeof logger, 'warn'>;
  } = {},
): DecisionSink & { flush(): Promise<void> } {
  const dir = options.dir ?? DEFAULT_RUNS_DIR;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? logger;
  let dirReady = false;
  let queue: Promise<void> = Promise.resolve();
  async function append(file: string, line: string) {
    if (!dirReady) {
      await mkdir(dir, { recursive: true });
      dirReady = true;
    }
    await appendFile(file, line, 'utf8');
  }
  return {
    write(record) {
      const at = now();
      const line = JSON.stringify({ ...record, at: at.toISOString() }) + '\n';
      const file = join(dir, `shadow-${dayStamp(at)}.jsonl`);
      queue = queue
        .then(() => append(file, line))
        .catch(() => {
          log.warn('system_one.sink.failed', {
            errorCode: 'SYSTEM_ONE_SINK_WRITE',
          });
        });
    },
    flush: () => queue,
  };
}
