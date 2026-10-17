// Limits the Mailly API enforces; the tool schemas mirror them so the model gets errors before a round trip.
export const MAX_AGENT_SKILLS = 20;
export const MAX_SKILL_DESCRIPTION = 900;
export const MAX_SKILL_INSTRUCTIONS = 16000;
export const MAX_SUMMARY_PROMPT = 4000;

export const DELIVERY_EVENT_TYPES = [
  'accepted', 'queued', 'sent', 'delivered', 'opened', 'deferred',
  'soft_bounced', 'hard_bounced', 'complained', 'unsubscribed', 'link_clicked',
] as const;
