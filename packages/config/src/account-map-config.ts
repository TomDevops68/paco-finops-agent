import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

export const AccountMapConfigSchema = z.object({
  accounts: z.record(z.string().regex(/^\d{12}$/), z.string().min(1)),
});

export type AccountMapConfig = z.infer<typeof AccountMapConfigSchema>;

async function readYaml(path: string): Promise<unknown> {
  return parse(await readFile(path, 'utf8'));
}

/** Loads `config/account-map.yaml` — kept manually in sync with `paco-daily-cost-report`'s `ACCOUNT_MAP` (see that file's own header comment). */
export async function loadAccountMapConfig(path: string): Promise<AccountMapConfig> {
  return AccountMapConfigSchema.parse(await readYaml(path));
}
