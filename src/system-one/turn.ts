import type { ChatStatus } from '../chat/contracts.js';
import { logger } from '../observability/logger.js';
import { createSystemOneClient, type SystemOneClient } from './client.js';
import { isSiteActive, type SystemOneConfig } from './config.js';
import { decideGate, type GateAction, type GateDecision } from './gate.js';
import { buildPreRouteQuestions, buildPreRouteState } from './pre-route.js';
import {
  jsonlSink,
  noopSink,
  type DecisionSink,
  type SystemOneAction,
} from './sink.js';

// Clarify (site c) was dropped after the probe; tool skip (f) is step 4.
const GATE_ONLY = { inputGate: true, toolSkip: false, clarify: false };

export interface PreRouteInput {
  /** Already pseudonymized (privacy tokens), never the raw message. */
  message: string;
  /** Status of the previous completed turn of this conversation. */
  previousStatus?: ChatStatus;
}
/** Present only when System One answers the turn itself (mode `on`). */
export type PreRouteOutcome = GateAction;
export interface SystemOneTurn {
  /** Never throws; undefined means "take the old path". */
  beforeRouting(
    input: PreRouteInput,
    signal: AbortSignal,
  ): Promise<PreRouteOutcome | undefined>;
}
export interface SystemOneTurnDeps {
  client?: SystemOneClient;
  sink?: DecisionSink;
  log?: Pick<typeof logger, 'info'>;
}

function gateAction(
  gate: GateDecision | null,
  mode: 'shadow' | 'on',
): SystemOneAction {
  if (!gate) return 'failed';
  if (!gate.action)
    return gate.label === 'academic' ? 'passed' : 'low_confidence';
  return mode === 'shadow' ? 'shadow' : 'acted';
}

/**
 * Returns undefined when no pre-route site is active, so the chat service
 * keeps its exact old code path.
 */
export function createSystemOneTurn(
  config: SystemOneConfig,
  deps: SystemOneTurnDeps = {},
): SystemOneTurn | undefined {
  if (config.mode === 'off' || !isSiteActive(config, 'inputGate'))
    return undefined;
  const mode = config.mode;
  const client = deps.client ?? createSystemOneClient(config);
  const sink = deps.sink ?? (mode === 'shadow' ? jsonlSink() : noopSink);
  const log = deps.log ?? logger;
  return {
    async beforeRouting(input, signal) {
      const state = buildPreRouteState(input.message);
      // A reply to our own follow-up question ("K67", "IT1") is not a new
      // request and must not be classified on its own.
      if (input.previousStatus === 'needs_clarification') {
        sink.write({
          site: 'input_gate',
          mode,
          action: 'skipped',
          state,
          answers: null,
        });
        log.info('system_one.gate.decided', {
          systemOneSite: 'input_gate',
          systemOneAction: 'skipped',
        });
        return undefined;
      }
      const questions = buildPreRouteQuestions(GATE_ONLY, input.message);
      const decision = await client.decide(state, questions, signal);
      const gate = decision ? decideGate(decision.answers) : null;
      const action = gateAction(gate, mode);
      sink.write({
        site: 'input_gate',
        mode,
        action,
        label: gate?.label,
        probability: gate?.probability,
        state,
        answers: decision?.answers ?? null,
        latencyMs: decision?.latencyMs,
      });
      log.info('system_one.gate.decided', {
        systemOneSite: 'input_gate',
        systemOneLabel: gate?.label,
        systemOneProbPct: gate ? gate.probability * 100 : undefined,
        systemOneAction: action,
      });
      if (action !== 'acted' || !gate?.action) return undefined;
      log.info('guardrail.input.resolved', {
        status: gate.action.result.status,
        reasonCode: gate.action.result.reasonCode,
      });
      return gate.action;
    },
  };
}
