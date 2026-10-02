import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * Deterministic routing only — see `packages/core/src/cost-playbook.ts`'s
 * comment on why this is a two-entry table (`new` vs "everything else"),
 * not the full seven-category `classification` the model concludes with.
 */
const RoutingPlaybookDefinitionSchema = z.object({
  enabledTools: z.array(z.string().regex(/^mcp__cost__[a-z_]+$/)).min(1),
});

export const PlaybooksConfigSchema = z.object({
  schemaVersion: z.literal(1),
  selection: z.object({
    new: z.string().min(1),
    fallback: z.string().min(1),
  }),
  playbooks: z.record(z.string(), RoutingPlaybookDefinitionSchema),
});

export type PlaybooksConfig = z.infer<typeof PlaybooksConfigSchema>;

async function readYaml(path: string): Promise<unknown> {
  return parse(await readFile(path, 'utf8'));
}

export async function loadPlaybooksConfig(path: string): Promise<PlaybooksConfig> {
  const config = PlaybooksConfigSchema.parse(await readYaml(path));
  const referenced = [config.selection.new, config.selection.fallback];
  const missing = referenced.filter((name) => !config.playbooks[name]);
  if (missing.length > 0) throw new Error(`Undefined playbooks: ${missing.join(', ')}`);
  return config;
}

/** Pure selection: mirrors `packages/core/src/cost-playbook.ts`'s `classifySignificance`. */
export function selectRoutingPlaybook(
  config: PlaybooksConfig,
  significance: 'new' | 'increase' | 'decrease' | 'unchanged',
): string {
  return significance === 'new' ? config.selection.new : config.selection.fallback;
}
