import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { MaillyApi } from './server';
import type { McpPrincipal } from './principal';
import { SCOPES } from './scopes';

const key = z.string().min(1).max(200);
const segment = (value?: string) => {
  if (!value || value === '.' || value === '..') throw new Error('Select a record');
  return encodeURIComponent(value);
};
// App-only operations are deliberately enumerated: never accept arbitrary API paths.
const reads = {
  overview: '/operations-overview', addresses: '/inbox/addresses', drafts: '/mail-drafts',
  outbox: '/sent-messages', contacts: '/contacts', audiences: '/audiences',
  templates: '/templates', campaigns: '/campaigns', workflows: '/workflows',
  domains: '/sender-domains', agents: '/agents', agent_runs: '/agents/runs',
  events: '/delivery-events', workflow_events: '/events', logs: '/logs',
  settings: '/marketing-settings', delivery_webhook: '/delivery-webhook', inbox_webhook: '/inbox/webhook',
  entitlements: '/billing/entitlements', purchases: '/billing/purchases', catalog: '/billing/catalog',
} as const;
const details = {
  outbox_detail: (id: string) => `/sent-messages/${segment(id)}`,
  contact: (id: string) => `/contacts/${segment(id)}`,
  contact_history: (id: string) => `/contacts/${segment(id)}/history`,
  contact_timeline: (id: string) => `/contacts/${segment(id)}/timeline`,
  audience: (id: string) => `/audiences/${segment(id)}/preview`,
  template: (id: string) => `/templates/${segment(id)}`,
  campaign: (id: string) => `/campaigns/${segment(id)}`,
  campaign_audience: (id: string) => `/campaigns/${segment(id)}/audience`,
  campaign_recipients: (id: string) => `/campaigns/${segment(id)}/recipients`,
  workflow: (id: string) => `/workflows/${segment(id)}`,
  workflow_runs: (id: string) => `/workflows/${segment(id)}/runs`,
  agent_memories: (id: string) => `/agents/${segment(id)}/memories`,
  event: (id: string) => `/delivery-events/${segment(id)}`,
  preference: () => '/preferences',
} as const;
type Op = { method: string; path: (id?: string) => string; send?: boolean };
const mutations: Record<string, Op> = {
  address_create: { method: 'POST', path: () => '/inbox/addresses' },
  address_delete: { method: 'DELETE', path: id => `/inbox/addresses/${segment(id)}` },
  domain_create: { method: 'POST', path: () => '/sender-domains' },
  domain_verify_inbound: { method: 'POST', path: id => `/sender-domains/${segment(id)}/verify-inbound` },
  domain_setup_outbound: { method: 'POST', path: id => `/sender-domains/${segment(id)}/setup-outbound` },
  domain_verify_outbound: { method: 'POST', path: id => `/sender-domains/${segment(id)}/verify-outbound` },
  settings_save: { method: 'PUT', path: () => '/marketing-settings' },
  delivery_webhook_save: { method: 'PUT', path: () => '/delivery-webhook' },
  delivery_webhook_disable: { method: 'DELETE', path: () => '/delivery-webhook' },
  inbox_webhook_save: { method: 'PUT', path: () => '/inbox/webhook' },
  inbox_webhook_disable: { method: 'DELETE', path: () => '/inbox/webhook' },
  contact_save: { method: 'PUT', path: id => `/contacts/${segment(id)}` },
  contact_suppress: { method: 'POST', path: id => `/contacts/${segment(id)}/suppress` },
  audience_create: { method: 'POST', path: () => '/audiences' },
  audience_update: { method: 'PUT', path: id => `/audiences/${segment(id)}` },
  audience_members: { method: 'POST', path: id => `/audiences/${segment(id)}/members` },
  template_create: { method: 'POST', path: () => '/templates' },
  template_save: { method: 'PUT', path: id => `/templates/${segment(id)}/draft` },
  template_publish: { method: 'POST', path: id => `/templates/${segment(id)}/publish` },
  template_archive: { method: 'POST', path: id => `/templates/${segment(id)}/archive` },
  campaign_pause: { method: 'POST', path: id => `/campaigns/${segment(id)}/pause` },
  campaign_resume: { method: 'POST', path: id => `/campaigns/${segment(id)}/resume`, send: true },
  campaign_cancel: { method: 'POST', path: id => `/campaigns/${segment(id)}/cancel` },
  campaign_complete: { method: 'POST', path: id => `/campaigns/${segment(id)}/complete` },
  workflow_publish: { method: 'POST', path: id => `/workflows/${segment(id)}/publish`, send: true },
  workflow_pause: { method: 'POST', path: id => `/workflows/${segment(id)}/pause` },
  workflow_resume: { method: 'POST', path: id => `/workflows/${segment(id)}/resume`, send: true },
  workflow_archive: { method: 'POST', path: id => `/workflows/${segment(id)}/archive` },
  agent_create: { method: 'POST', path: () => '/agents' },
  agent_save: { method: 'PATCH', path: id => `/agents/${segment(id)}` },
  agent_discard: { method: 'POST', path: id => `/agents/runs/${segment(id)}/discard` },
  preference_resubscribe: { method: 'POST', path: () => '/preferences/resubscribe' },
  message_release: { method: 'POST', path: id => `/inbox/messages/${segment(id)}/release` },
};
// Hosts with MCP Apps hide these tools from the model (`visibility: ['app']`) and read `_meta`; hosts without
// UI expose them to the model directly, so the same data is also returned as standard content/structuredContent.
const clientResult = (data: Record<string, any>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data, _meta: { 'mailly/client': data } });
const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Request failed' }] });
export function registerClientTools(server: McpServer, api: MaillyApi, principal: McpPrincipal) {
  const can = (scope: string) => principal.scopes.includes(scope);
  if (can(SCOPES.read)) server.registerTool('mailly_client_read', {
    title: 'Mailly client data', description: 'Read a workspace module by name (overview, addresses, outbox, contacts, audiences, templates, campaigns, workflows, domains, agents, events, logs, settings, webhooks, billing) or one record by id. Hosts with the Mailly app call this from the UI; other hosts can call it directly.',
    inputSchema: z.object({ operation: z.enum([...Object.keys(reads), ...Object.keys(details)] as [string, ...string[]]), id: key.optional(),
      query: z.object({ limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(), cursor: z.string().max(2000).optional(), q: z.string().max(500).optional(), status: z.string().max(64).optional(), type: z.string().max(64).optional(), since: z.number().int().optional(), include_unverified: z.number().optional(), email: z.string().email().optional(), agent_id: key.optional(), sampleLimit: z.number().int().min(1).max(100).optional() }).optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false }, _meta: { ui: { visibility: ['app'] } },
  }, async ({ operation, id, query }) => {
    try {
      if (['settings', 'delivery_webhook', 'inbox_webhook', 'entitlements', 'purchases', 'logs', 'agents', 'agent_runs', 'agent_memories', 'preference'].includes(operation) && !can(SCOPES.manage)) throw new Error('This page requires workspace management permission. Reconnect to grant access.');
      const path = reads[operation as keyof typeof reads] ?? details[operation as keyof typeof details](segmentRequired(id));
      return clientResult(await api('GET', path, { query: operation === 'overview' ? { since: Math.floor(Date.now() / 1000) - 86400, ...query } : query }));
    } catch (error) { return failure(error); }
  });
  if (can(SCOPES.manage)) server.registerTool('mailly_client_manage', {
    title: 'Manage Mailly workspace', description: 'Apply one enumerated workspace mutation (addresses, domains, settings, webhooks, contacts, audiences, templates, campaign/workflow lifecycle, agents, quarantine release). Only call with confirmed=true after the user has reviewed the exact change; resume and publish operations also require sending permission and workflow_publish needs the reviewed definition.',
    inputSchema: z.object({ operation: z.enum(Object.keys(mutations) as [string, ...string[]]), id: key.optional(), body: z.record(z.string(), z.unknown()).optional(), confirmed: z.literal(true) }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, _meta: { ui: { visibility: ['app'] } },
  }, async ({ operation, id, body }) => {
    try {
      const op = mutations[operation];
      if (op.send && !can(SCOPES.send)) throw new Error('This action requires sending permission');
      if (JSON.stringify(body ?? {}).length > 512 * 1024) throw new Error('Content too large');
      if (operation === 'workflow_publish') {
        const current = await api('GET', `/workflows/${segment(id)}`);
        if (!body?.reviewed_definition || JSON.stringify(current.workflow.draftDefinition) !== JSON.stringify(body.reviewed_definition)) throw new Error('Workflow draft changed. Refresh and review it again.');
        return clientResult(await api(op.method, op.path(id), { body: { inFlightPolicy: 'continue' } }));
      }
      return clientResult(await api(op.method, op.path(id), { body }));
    } catch (error) { return failure(error); }
  });
  if (can(SCOPES.send)) server.registerTool('mailly_client_send', {
    title: 'Compose and send email', description: 'Compose a new email (not a reply draft). Call with dry_run=true first to validate recipients and cost; send only with dry_run=false and confirmed=true after the user has reviewed the exact final sender, recipients, subject, and HTML body. This send has no server-side idempotency key: never retry an unknown outcome, check the outbox instead.',
    inputSchema: z.object({ dry_run: z.boolean(), confirmed: z.boolean(),
      mail: z.object({ fromEmail: z.string().email(), fromName: z.string().max(200).optional(), to: z.array(z.string().email()).min(1).max(1000).optional(), subject: z.string().min(1).max(998).refine(s => !/[\r\n]/.test(s)), html: z.string().min(1).max(512 * 1024),
        emailType: z.enum(['transactional', 'lifecycle', 'marketing']), topic: z.string().max(200).optional(), recipientReason: z.string().max(300).optional(), campaignKey: key.optional() }).refine(mail => !!mail.to?.length || !!mail.campaignKey, 'Enter recipients or use a campaign with a frozen audience') }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, _meta: { ui: { visibility: ['app'] } },
  }, async ({ dry_run, confirmed, mail }) => {
    try {
      if (!dry_run && !confirmed) throw new Error('Review and confirm the final email first');
      return clientResult(await api('POST', '/send-email', { body: { ...mail, ...(mail.to ? { to: mail.to.length === 1 ? mail.to[0] : mail.to } : {}), sourceApp: 'mailly_plugin', dryRun: dry_run } }));
    } catch (error) { return failure(error); }
  });
}
function segmentRequired(id?: string) { if (!id) throw new Error('Select a record'); return id; }
