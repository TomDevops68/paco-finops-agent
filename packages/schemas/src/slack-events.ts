import { z } from 'zod';

/**
 * Slack `app_mention` Events API envelope. `.loose()`, not `.strict()`: a
 * real event carries several legitimate fields this schema doesn't need
 * (client_msg_id, team, parent_user_id, blocks, event_ts, …) — ported from
 * paco-troubleshoot-agent, where `.strict()` rejected every real Slack event
 * with "Unrecognized keys" before that was caught live (2026-09-24).
 */
export const SlackAppMentionEnvelopeSchema = z
  .object({
    type: z.literal('event_callback'),
    event_id: z.string().min(1),
    event_time: z.number().int().positive(),
    team_id: z.string().min(1),
    event: z
      .object({
        type: z.literal('app_mention'),
        user: z.string().min(1),
        text: z.string().min(1),
        channel: z.string().min(1),
        ts: z.string().min(1),
        thread_ts: z.string().min(1).optional(),
      })
      .loose(),
  })
  .loose();

export type SlackAppMentionEnvelope = z.infer<typeof SlackAppMentionEnvelopeSchema>;
