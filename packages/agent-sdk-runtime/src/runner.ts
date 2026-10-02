import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import {
  FinalCostAnalysisSchema,
  type CostClassification,
  type CostEvidenceRecord,
  type FinalCostAnalysis,
} from '../../schemas/src/index.js';
import {
  validateCostAnalysisEvidence,
  type CostAnalysisValidationResult,
  type BudgetUsage,
} from '../../core/src/index.js';

/**
 * Ported near-verbatim from paco-troubleshoot-agent's
 * `packages/agent-sdk-runtime/src/runner.ts`. The two grace-period constants
 * and the direct tool_use-block final-answer capture below exist because of
 * two specific, previously-confirmed live failure modes in that system using
 * this exact Agent SDK version: a post-final-answer stream stall that
 * silently discarded an already-complete analysis, and the SDK's documented
 * `structured_output` end-turn attachment never actually arriving. See that
 * file's full comments (not repeated here) before changing either grace
 * period or removing the tool_use capture — this agent shares the identical
 * SDK dependency and is exposed to the identical bugs.
 */
const DEFAULT_POST_FINAL_ANSWER_GRACE_MS = 60_000;
const DEFAULT_STREAM_STALL_GRACE_MS = 300_000;

export type AgentMessageStreamFactory = (input: {
  prompt: string;
  options: Options;
}) => AsyncIterable<unknown>;

export interface RunAgentSessionInput {
  prompt: string;
  options: Options;
  classification: CostClassification;
  evidenceCatalog: readonly CostEvidenceRecord[];
  evidenceValidation: {
    minimumConfidence: number;
    minimumEvidenceTypes: number;
    resourceEvidenceVerified: boolean;
  };
  usage: BudgetUsage;
  /** Matches apps/agent-worker/src/main.ts's FINAL_ANSWER_TOOL_NAME and hooks.ts's HarnessHookContext.finalAnswerToolName. */
  finalAnswerToolName: string;
  postFinalAnswerGraceMs?: number;
  streamStallGraceMs?: number;
}

export interface AgentSessionResult {
  sessionId: string | null;
  analysis: CostAnalysisValidationResult;
  toolUses: string[];
  terminalSubtype: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function partialAnalysis(
  classification: CostClassification,
  budgetExhausted: boolean,
): FinalCostAnalysis {
  return {
    classification,
    status: budgetExhausted ? 'BUDGET_EXHAUSTED' : 'INSUFFICIENT_EVIDENCE',
    summary: budgetExhausted
      ? 'The investigation stopped at a configured budget limit.'
      : 'The investigation ended without a valid evidence-supported result.',
    driver: null,
    confidence: 0,
    evidence: [],
    hypotheses: [],
    rejectedHypotheses: [],
    savingsRecommendations: [],
    limitations: ['Only evidence collected before termination is available.'],
    serviceBreakdown: [],
    rootCauseEvidence: [],
    recommendedActions: [],
  };
}

function logSystemInit(message: Record<string, unknown>): void {
  if (message.type !== 'system' || message.subtype !== 'init') return;
  console.log(
    JSON.stringify({
      event: 'sdk_system_init',
      sessionId: message.session_id,
      model: message.model,
      tools: message.tools,
      mcpServers: message.mcp_servers,
    }),
  );
}

function logResultMessage(message: Record<string, unknown>): void {
  if (message.type !== 'result') return;
  console.log(
    JSON.stringify({
      event: 'sdk_result_message',
      subtype: message.subtype,
      stopReason: message.stop_reason,
      terminalReason: message.terminal_reason,
      hasStructuredOutput: message.structured_output !== undefined,
      structuredOutputPreview:
        message.structured_output === undefined
          ? undefined
          : JSON.stringify(message.structured_output).slice(0, 500),
      resultPreview: typeof message.result === 'string' ? message.result.slice(0, 300) : undefined,
    }),
  );
}

function captureToolUses(message: Record<string, unknown>, toolUses: string[]): void {
  if (message.type !== 'assistant') return;
  const assistant = recordOf(message.message);
  if (!assistant || !Array.isArray(assistant.content)) return;
  for (const content of assistant.content) {
    const block = recordOf(content);
    if (block?.type === 'tool_use' && typeof block.name === 'string') toolUses.push(block.name);
  }
}

function captureFinalAnswer(
  message: Record<string, unknown>,
  finalAnswerToolName: string,
): FinalCostAnalysis | null {
  if (message.type !== 'assistant') return null;
  const assistant = recordOf(message.message);
  if (!assistant || !Array.isArray(assistant.content)) return null;
  for (const content of assistant.content) {
    const block = recordOf(content);
    if (block?.type === 'tool_use' && block.name === finalAnswerToolName) {
      const parsed = FinalCostAnalysisSchema.safeParse(block.input);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

function updateUsage(message: Record<string, unknown>, usage: BudgetUsage): void {
  if (message.type === 'assistant') {
    usage.turns += 1;
    return;
  }
  if (message.type !== 'result') return;
  if (typeof message.num_turns === 'number') usage.turns = message.num_turns;
  if (typeof message.total_cost_usd === 'number') usage.costUsd = message.total_cost_usd;
  const tokenUsage = recordOf(message.usage);
  if (typeof tokenUsage?.input_tokens === 'number') usage.inputTokens = tokenUsage.input_tokens;
  if (typeof tokenUsage?.output_tokens === 'number') usage.outputTokens = tokenUsage.output_tokens;
}

export async function runAgentSession(
  input: RunAgentSessionInput,
  streamFactory: AgentMessageStreamFactory = (request) => query(request),
): Promise<AgentSessionResult> {
  let sessionId: string | null = null;
  let terminalSubtype = 'error_during_execution';
  let proposed: FinalCostAnalysis | null = null;
  const toolUses: string[] = [];
  const postFinalAnswerGraceMs = input.postFinalAnswerGraceMs ?? DEFAULT_POST_FINAL_ANSWER_GRACE_MS;
  const streamStallGraceMs = input.streamStallGraceMs ?? DEFAULT_STREAM_STALL_GRACE_MS;
  const STALLED = Symbol('stalled');

  const iterator = streamFactory({ prompt: input.prompt, options: input.options })[
    Symbol.asyncIterator
  ]();
  try {
    for (;;) {
      const graceMs = proposed ? postFinalAnswerGraceMs : streamStallGraceMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<typeof STALLED>((resolve) => {
        timer = setTimeout(() => resolve(STALLED), graceMs);
        timer.unref();
      });
      const nextResult = await Promise.race([iterator.next(), timeoutPromise]);
      if (timer) clearTimeout(timer);
      if (nextResult === STALLED) {
        terminalSubtype = proposed ? 'success_after_stream_stall' : 'error_stream_stall';
        if (typeof iterator.return === 'function')
          void iterator.return(undefined).catch(() => undefined);
        break;
      }
      if (nextResult.done) break;
      const message = recordOf(nextResult.value);
      if (!message) continue;
      if (typeof message.session_id === 'string') sessionId = message.session_id;
      logSystemInit(message);
      captureToolUses(message, toolUses);
      const capturedFinalAnswer = captureFinalAnswer(message, input.finalAnswerToolName);
      if (capturedFinalAnswer) proposed = capturedFinalAnswer;
      updateUsage(message, input.usage);
      logResultMessage(message);
      if (message.type !== 'result' || typeof message.subtype !== 'string') continue;
      terminalSubtype = message.subtype;
      if (message.subtype === 'success' && !proposed) {
        const parsed = FinalCostAnalysisSchema.safeParse(message.structured_output);
        if (parsed.success) proposed = parsed.data;
      }
      // `result` is the stream's terminal message — stop here. Calling
      // iterator.next() again after it can throw (observed live: a session
      // that correctly reached `error_max_budget_usd` here had that exact
      // subtype silently clobbered back to the generic `error_during_execution`
      // by the catch block below, because the extra post-terminal read failed).
      break;
    }
  } catch {
    terminalSubtype = proposed ? 'success_after_stream_error' : 'error_during_execution';
  }

  const budgetExhausted =
    terminalSubtype === 'error_max_turns' || terminalSubtype === 'error_max_budget_usd';
  const analysis = validateCostAnalysisEvidence(
    proposed ?? partialAnalysis(input.classification, budgetExhausted),
    input.evidenceCatalog,
    input.evidenceValidation,
  );
  return { sessionId, analysis, toolUses, terminalSubtype };
}
