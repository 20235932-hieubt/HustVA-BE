// One demo row per line (JSONL) so an interrupted run can resume and the
// multi-run summary reads numbers, not markdown. Rows carry no question text.
import { z } from 'zod';
import type { DemoRow } from './report.js';

export type StoredRow = Omit<DemoRow, 'question'>;

const outcome = z.object({
  status: z.string(),
  reasonCode: z.string(),
  selectorCalls: z.number().int().min(0),
  agentCalls: z.number().int().min(0),
  ms: z.number().min(0),
});
const storedRow = z.object({
  stt: z.number().int(),
  group: z.string(),
  mustPass: z.boolean(),
  mustKeepSelector: z.boolean(),
  off: outcome,
  on: outcome,
  systemOne: z.string(),
  gateActed: z.boolean(),
  toolSkipped: z.boolean(),
  claimsChecked: z.number().int().min(0),
  claimsDropped: z.number().int().min(0),
});

export function rowLine(row: StoredRow): string {
  return `${JSON.stringify(storedRow.parse(row))}\n`;
}

/** Skips blank and malformed lines (a run killed mid-write leaves a
 *  truncated last line); that STT simply runs again on resume. */
export function parseRows(text: string): StoredRow[] {
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = storedRow.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}
