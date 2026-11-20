import type { ChatStatus } from '../chat/contracts.js';
import { logger } from '../observability/logger.js';
import { createSystemOneClient, type SystemOneClient } from './client.js';
import { isSiteActive, type SystemOneConfig } from './config.js';
import { decideGate, type GateAction, type GateDecision } from './gate.js';
import {
  buildPreRouteQuestions,
  buildPreRouteState,
  type PreRouteSites,
} from './pre-route.js';
import type { SystemOneAnswer } from './response.js';
import {
  jsonlSink,
  noopSink,
  type DecisionSink,
  type SystemOneAction,
  type SystemOneSite,
} from './sink.js';
import { decideToolSkip, type ToolSkipDecision } from './tool-skip.js';

type PreRouteSite = Extract<SystemOneSite, 'input_gate' | 'tool_skip'>;
const EVENTS: Readonly<Record<PreRouteSite, string>> = {
  input_gate: 'system_one.gate.decided',
  tool_skip: 'system_one.tool_skip.decided',
};

export interface PreRouteInput {
  /** Already pseudonymized (privacy tokens), never the raw message. */
  message: string;
  /** Status of the previous completed turn of this conversation. */
  previousStatus?: ChatStatus;
}
/** Present only when System One changes the turn (mode `on`). */
export interface PreRouteOutcome {
  /** Site a: System One answers the turn itself. */
  action?: GateAction;
  /** Site f: go straight to the agent, without the Gemini tool selector. */
  skipTools?: boolean;
}
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

type ActiveMode = 'shadow' | 'on';
const confident = (mode: ActiveMode): SystemOneAction =>
  mode === 'shadow' ? 'shadow' : 'acted';

function gateAction(
  gate: GateDecision | null,
  mode: ActiveMode,
): SystemOneAction {
  if (!gate) return 'failed';
  if (!gate.action)
    return gate.label === 'academic' ? 'passed' : 'low_confidence';
  return confident(mode);
}

function toolSkipAction(
  decision: ToolSkipDecision | null,
  mode: ActiveMode,
): SystemOneAction {
  if (!decision) return 'failed';
  if (decision.skip) return confident(mode);
  return decision.label === 'tai_lieu' ? 'low_confidence' : 'passed';
}

/**
 * Returns undefined when no pre-route site (a, f) is active, so the chat
 * service keeps its exact old code path. Clarify (c) was dropped after the
 * probe and is never asked.
 */
export function createSystemOneTurn(
  config: SystemOneConfig,
  deps: SystemOneTurnDeps = {},
): SystemOneTurn | undefined {
  const sites: PreRouteSites = {
    inputGate: isSiteActive(config, 'inputGate'),
    toolSkip: isSiteActive(config, 'toolSkip'),
    clarify: false,
  };
  if (config.mode === 'off' || (!sites.inputGate && !sites.toolSkip))
    return undefined;
  const mode = config.mode;
  const client = deps.client ?? createSystemOneClient(config);
  const sink = deps.sink ?? (mode === 'shadow' ? jsonlSink() : noopSink);
  const log = deps.log ?? logger;
  const active: PreRouteSite[] = [
    ...(sites.inputGate ? (['input_gate'] as const) : []),
    ...(sites.toolSkip ? (['tool_skip'] as const) : []),
  ];

  function record(
    site: PreRouteSite,
    action: SystemOneAction,
    state: Record<string, string>,
    answers: Record<string, SystemOneAnswer> | null,
    decision?: { label: string; probability: number } | null,
    latencyMs?: number,
  ) {
    sink.write({
      site,
      mode,
      action,
      label: decision?.label,
      probability: decision?.probability,
      state,
      answers,
      latencyMs,
    });
    log.info(EVENTS[site], {
      systemOneSite: site,
      systemOneLabel: decision?.label,
      systemOneProbPct: decision ? decision.probability * 100 : undefined,
      systemOneAction: action,
    });
  }

  return {
    async beforeRouting(input, signal) {
      const state = buildPreRouteState(input.message);
      // A reply to our own follow-up question ("K67", "IT1") is not a new
      // request and must not be classified or routed on its own.
      if (input.previousStatus === 'needs_clarification') {
        for (const site of active) record(site, 'skipped', state, null);
        return undefined;
      }
      const questions = buildPreRouteQuestions(sites, input.message);
      const decision = await client.decide(state, questions, signal);
      const answers = decision?.answers ?? null;
      const latencyMs = decision?.latencyMs;
      if (sites.inputGate) {
        const gate = answers ? decideGate(answers) : null;
        const action = gateAction(gate, mode);
        record('input_gate', action, state, answers, gate, latencyMs);
        if (action === 'acted' && gate?.action) {
          log.info('guardrail.input.resolved', {
            status: gate.action.result.status,
            reasonCode: gate.action.result.reasonCode,
          });
          return { action: gate.action };
        }
      }
      if (!sites.toolSkip) return undefined;
      const skip = answers ? decideToolSkip(answers) : null;
      const action = toolSkipAction(skip, mode);
      record('tool_skip', action, state, answers, skip, latencyMs);
      return action === 'acted' ? { skipTools: true } : undefined;
    },
  };
}
