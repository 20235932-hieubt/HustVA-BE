import type { SystemOneAnswer } from '../../src/system-one/client.js';

export interface Labels {
  a: Record<string, string>;
  f: Record<string, string>;
  c: Record<string, string[]>;
}
export interface ClaimRow {
  stt: number;
  evidenceTitle: string;
  evidence: string;
  claim: string;
  supported: boolean;
  falseKind: 'number' | 'meaning' | null;
}
/** One System One call; `id` is the STT (pre-route) or claim index. */
export interface Sample {
  id: number;
  failed?: boolean;
  answers?: Record<string, SystemOneAnswer>;
  latencyMs?: number;
  inputTokens?: number;
  truncated?: boolean;
}
export interface ProbeRaw {
  provider: string;
  model: string;
  pre: Sample[];
  claim: Sample[];
}
