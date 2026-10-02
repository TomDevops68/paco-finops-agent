import { z } from 'zod';
import { CostEvidenceTypeSchema } from './cost-analysis.js';

export const CostEvidenceRecordSchema = z.object({
  id: z.string().regex(/^EV-[A-Za-z0-9_-]+$/),
  type: CostEvidenceTypeSchema,
  summary: z.string().min(1).max(2_000),
  collectedAt: z.iso.datetime({ offset: true }),
  storageKey: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
});

export type CostEvidenceRecord = z.infer<typeof CostEvidenceRecordSchema>;
