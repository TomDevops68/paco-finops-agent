import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SessionStore,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { COST_SYSTEM_PROMPT } from './prompt.js';

export const AGENT_SDK_VERSION = '0.3.274';
export const EXPECTED_CLAUDE_CODE_VERSION = '2.1.274';

const getReport = tool(
  'get_report',
  'Return the normalized cost report line already scoped to this investigation.',
  { reportDate: z.string().min(1) },
  ({ reportDate }) =>
    Promise.resolve({
      content: [
        { type: 'text' as const, text: 'Report metadata is available in structuredContent.' },
      ],
      structuredContent: { reportDate },
    }),
  { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
);

const costServer = createSdkMcpServer({
  name: 'cost',
  version: '1.0.0',
  tools: [getReport],
  alwaysLoad: true,
});

export interface AgentRuntimeOptionsInput {
  cwd: string;
  model: string;
  sessionStore: SessionStore;
  maxTurns: number;
  maxBudgetUsd: number;
  costServer?: McpSdkServerConfigWithInstance;
  allowedTools?: readonly string[];
  hooks: NonNullable<Options['hooks']>;
  resume?: string;
  environment?: Readonly<Record<string, string>>;
}

/** Ported from paco-troubleshoot-agent's `buildAgentRuntimeOptions` (packages/agent-sdk-runtime/src/sdk-contract.ts) — same headless, tools-locked-down shape. */
export function buildAgentRuntimeOptions(input: AgentRuntimeOptionsInput): Options {
  const options: Options = {
    cwd: input.cwd,
    model: input.model,
    tools: [],
    mcpServers: { cost: input.costServer ?? costServer },
    allowedTools: [...(input.allowedTools ?? ['mcp__cost__get_report'])],
    disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch'],
    permissionMode: 'dontAsk',
    permissionPrompts: 'none',
    strictMcpConfig: true,
    settingSources: [],
    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    systemPrompt: { type: 'custom', prompt: COST_SYSTEM_PROMPT, snapshot: true },
    // Final-answer submission goes through the `submit_final_analysis` MCP
    // tool (tool-server.ts) instead of `outputFormat: {type: 'json_schema'}`
    // — see that tool's comment for why.
    sessionStore: input.sessionStore,
    hooks: input.hooks,
    includePartialMessages: true,
    env: {
      ...process.env,
      ...input.environment,
      CLAUDE_CONFIG_DIR: `${input.cwd}/.claude-runtime`,
      CLAUDE_CODE_PROJECT_DIR_NAME: 'cost-agent',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'paco-cost-agent/0.1.0',
    },
    ...(input.resume ? { resume: input.resume } : {}),
  };
  return options;
}
