import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { MaillyApi } from './server';
import type { McpPrincipal } from './principal';
import { SCOPES } from './scopes';
import { email, GUARD, key, OUTWARD, path, recordId, run } from './common';

const line = (max: number) => z.string().min(1).max(max).refine(s => !/[\r\n]/.test(s), 'No line breaks');

// New outbound email, forwards and campaign resends (replies go through drafts). Each send keeps a review step: dry_run or an idempotency key.
export function registerSendTools(server: McpServer, api: MaillyApi, principal: McpPrincipal) {
  if (!principal.scopes.includes(SCOPES.send)) return;
  server.registerTool('mailly_send_email', {
    title: 'Send new email',
    description: `Send a new email (to reply to a conversation, use mailly_save_draft instead). Always call with dry_run=true first: it checks the sender domain, suppressions and unsubscribes, and reports eligible recipients and cost without sending. Then show the user the exact sender, recipients, subject and body, and call with dry_run=false and confirmed=true only after an explicit yes. Body is html and/or text, or a published template (template_key + template_version + variables). With campaign_key and no to, it sends to that campaign's frozen audience. This send has no idempotency key: if the outcome is unknown, check mailly_list_sent_messages instead of retrying. ${GUARD}`,
    inputSchema: z.object({
      dry_run: z.boolean(),
      confirmed: z.boolean().describe('true only for the real send, after the user approved the exact email'),
      from_email: email.describe('On a domain with verified sending'),
      from_name: line(200).optional(),
      to: z.array(email).min(1).max(1000).optional(),
      reply_to: email.optional(),
      subject: line(998).optional(),
      html: z.string().min(1).max(512 * 1024).optional(),
      text: z.string().min(1).max(512 * 1024).optional(),
      email_type: z.enum(['transactional', 'lifecycle', 'marketing']).describe('marketing adds the unsubscribe link and brand footer'),
      topic: key.optional().describe('Unsubscribe and frequency-cap topic; required for lifecycle and marketing'),
      recipient_reason: z.string().max(300).optional().describe('Why the recipient gets this; required for marketing'),
      campaign_key: key.optional(),
      template_key: key.optional(), template_version: z.number().int().positive().optional(),
      variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      scheduled_at: z.number().int().positive().optional().describe('Future Unix seconds to schedule instead of sending now'),
    }),
    annotations: OUTWARD,
  }, ({ dry_run, confirmed, to, ...mail }) => run(() => {
    if (!dry_run && !confirmed) throw new Error('Run with dry_run=true, have the user review the exact email, then send with confirmed=true');
    if (!to?.length && !mail.campaign_key) throw new Error('Specify to, or a campaign_key with a frozen audience');
    if (!mail.html && !mail.text && !mail.template_key) throw new Error('Specify html, text, or a template');
    return api('POST', '/send-email', { body: {
      fromEmail: mail.from_email, fromName: mail.from_name, replyTo: mail.reply_to, subject: mail.subject, html: mail.html, text: mail.text,
      emailType: mail.email_type, topic: mail.topic, recipientReason: mail.recipient_reason, campaignKey: mail.campaign_key,
      templateKey: mail.template_key, templateVersion: mail.template_version, variables: mail.variables, scheduledAt: mail.scheduled_at,
      ...(to ? { to: to.length === 1 ? to[0] : to } : {}),
      sourceApp: 'mailly_plugin', dryRun: dry_run,
    } });
  }));

  server.registerTool('mailly_forward_message', {
    title: 'Forward email',
    description: `Forward an email (message_id from mailly_read_thread) to one address, sent from the inbox address that received it; the body is an optional note above the quoted original, and original attachments are included unless include_attachments=false. It costs credits like any send. Show the user the recipient and note first and forward only after an explicit yes. Use a new idempotency_key per forward and reuse it when retrying: a retry with the same key and content never sends twice, and a status of processing means call again with the same key. ${GUARD}`,
    inputSchema: z.object({
      message_id: recordId,
      to: email,
      text: z.string().max(512_000).optional().describe('Plain-text note above the forwarded content'),
      html: z.string().max(512_000).optional().describe('HTML note, instead of or alongside text'),
      subject: line(500).optional().describe('Overrides the default "Fwd: ..." subject'),
      from_name: line(200).optional(),
      include_attachments: z.boolean().optional().describe('Default true'),
      idempotency_key: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/).describe('8-200 letters, digits, . _ : -'),
      confirmed: z.literal(true).describe('Set only after the user approved the recipient and note in this conversation'),
    }),
    annotations: { ...OUTWARD, idempotentHint: true },
  }, ({ message_id, idempotency_key, from_name, include_attachments, confirmed: _, ...body }) => run(() => api('POST', `/inbox/messages/${path(message_id)}/forward`, {
    body: { ...body, fromName: from_name, include_attachments }, headers: { 'Idempotency-Key': idempotency_key },
  })));

  server.registerTool('mailly_resend_campaign_failures', {
    title: 'Resend campaign to failed recipients',
    description: `For a campaign in sending state, send its stored content again to recipients whose delivery attempt failed, plus frozen-audience members that were never sent. Call with dry_run=true first to list who would get it (no sending, no charge), show that to the user, then call dry_run=false and confirmed=true only after an explicit yes; it costs credits. No idempotency key: if the outcome is unknown, run dry_run again or check mailly_list_campaign_recipients instead of retrying. ${GUARD}`,
    inputSchema: z.object({ campaign_key: key, dry_run: z.boolean(), confirmed: z.boolean().describe('true only for the real resend, after the user approved the list') }),
    annotations: OUTWARD,
  }, ({ campaign_key, dry_run, confirmed }) => run(() => {
    if (!dry_run && !confirmed) throw new Error('Run with dry_run=true, have the user review the recipients, then resend with confirmed=true');
    return api('POST', `/campaigns/${path(campaign_key)}/resend-unsent`, { body: { dryRun: dry_run } });
  }));
}
