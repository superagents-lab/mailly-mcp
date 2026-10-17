import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { MaillyApi } from './server';
import type { McpPrincipal } from './principal';
import { SCOPES } from './scopes';
import { confirmed, DESTRUCTIVE, email, GUARD, key, limit, path, READ, run, WRITE } from './common';

const contactId = key.describe('External contact ID (letters, digits, . _ : -)');
const audienceKey = key.describe('Audience key (letters, digits, . _ : -)');
const condition = z.object({
  field: z.string().min(1).max(200).describe('email, name, locale, status, createdAt, updatedAt, tag, or customFields.<name>'),
  operator: z.enum(['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'exists', 'gt', 'gte', 'lt', 'lte', 'before', 'after']),
  value: z.unknown().optional().describe('in/not_in take an array (max 50); before/after take ISO-8601 or Unix seconds; exists takes an optional boolean'),
});
// One nesting level keeps the JSON Schema free of $ref recursion, which some hosts cannot render.
const group = z.object({ operator: z.enum(['all', 'any']), conditions: z.array(condition).min(1).max(50) });
const filter = z.object({ operator: z.enum(['all', 'any']), conditions: z.array(z.union([condition, group])).min(1).max(50) })
  .describe('Dynamic audience filter, e.g. {operator:"all",conditions:[{field:"tag",operator:"eq",value:"beta"},{operator:"any",conditions:[{field:"customFields.plan",operator:"in",value:["pro","team"]}]}]}');

// Contacts, subscription state and audiences, backed by the same REST routes as the CLI.
export function registerContactTools(server: McpServer, api: MaillyApi, principal: McpPrincipal) {
  const can = (scope: string) => principal.scopes.includes(scope);

  if (can(SCOPES.read)) {
    server.registerTool('mailly_preview_audience', {
      title: 'Preview audience',
      description: 'Count and sample who an audience selection reaches, without saving or sending anything. Pass audience_key for one saved audience, or include/exclude audience keys plus direct recipients to preview a campaign selection.',
      inputSchema: z.object({
        audience_key: audienceKey.optional(),
        include: z.array(audienceKey).max(100).optional(), exclude: z.array(audienceKey).max(100).optional(),
        recipients: z.array(email).max(1000).optional(),
        sample_limit: limit(100).describe('Sample size, default 20'),
      }),
      annotations: READ,
    }, ({ audience_key, include, exclude, recipients, sample_limit }) => run(async () => {
      if (audience_key) {
        if (include || exclude || recipients) throw new Error('Use audience_key alone, or a selection without it');
        return api('GET', `/audiences/${path(audience_key)}/preview`, { query: { sampleLimit: sample_limit } });
      }
      if (!include?.length && !recipients?.length) throw new Error('Specify audience_key, include, or recipients');
      return api('POST', '/audiences/preview', { body: { include, exclude, recipients, sampleLimit: sample_limit } });
    }));
  }

  if (!can(SCOPES.manage)) return;

  server.registerTool('mailly_get_subscription_status', {
    title: 'Recipient subscription status',
    description: 'Read whether a recipient email is subscribed, unsubscribed or suppressed in this workspace, with its preference records.',
    inputSchema: z.object({ email }),
    annotations: READ,
  }, ({ email }) => run(() => api('GET', '/preferences', { query: { email } })));

  server.registerTool('mailly_save_contact', {
    title: 'Create or update contact',
    description: `Upsert a contact by external ID. email is required. Omitted name/locale/tags keep their current values; tags replace the whole list; custom_fields are merged (set a field to null to remove it). status only switches between active and inactive: use mailly_suppress_contact to stop mail. ${GUARD}`,
    inputSchema: z.object({
      external_contact_id: contactId, email,
      name: z.string().max(200).nullable().optional(), locale: z.string().max(35).nullable().optional(),
      status: z.enum(['active', 'inactive']).optional(),
      tags: z.array(z.string().min(1).max(100)).max(100).optional(),
      custom_fields: z.record(z.string(), z.unknown()).optional(),
      confirmed,
    }),
    annotations: { ...WRITE, idempotentHint: true },
  }, ({ external_contact_id, custom_fields, confirmed: _, ...body }) => run(() => api('PUT', `/contacts/${path(external_contact_id)}`, {
    body: { ...body, ...(custom_fields ? { customFields: custom_fields } : {}) },
  })));

  server.registerTool('mailly_suppress_contact', {
    title: 'Suppress contact',
    description: `Stop all workspace mail to a contact by adding a workspace suppression for its email (reason defaults to manual). Only reason=unsubscribed can later be lifted (with the recipient's consent, via mailly_resubscribe_recipient); manual, hard_bounce and complaint suppressions cannot be lifted through these tools. ${GUARD}`,
    inputSchema: z.object({
      external_contact_id: contactId,
      reason: z.enum(['unsubscribed', 'hard_bounce', 'complaint', 'manual']).optional(),
      source: z.string().min(1).max(100).optional().describe('Where the request came from, e.g. "support ticket 123"'),
      confirmed,
    }),
    annotations: DESTRUCTIVE,
  }, ({ external_contact_id, reason, source }) => run(() => api('POST', `/contacts/${path(external_contact_id)}/suppress`, { body: { reason, source } })));

  server.registerTool('mailly_resubscribe_recipient', {
    title: 'Resubscribe recipient',
    description: `Lift a workspace-level unsubscribe for an email (manual, bounce and complaint suppressions stay in place). Requires real consent evidence from the recipient: when and how they opted back in. Never invent consent. ${GUARD}`,
    inputSchema: z.object({
      email,
      source: z.string().min(1).max(100).describe('Where the opt-in happened, e.g. "signup form"'),
      consent_at: z.union([z.string().max(64), z.number().int().positive()]).describe('When the recipient consented: ISO-8601 or Unix seconds, after the opt-out and not in the future'),
      consent_reference: z.string().min(1).max(200).describe('Evidence reference, e.g. a form submission or ticket ID'),
      confirmed,
    }),
    annotations: WRITE,
  }, ({ email, source, consent_at, consent_reference }) => run(() => api('POST', '/preferences/resubscribe', {
    body: { email, scope: 'workspace', source, consentAt: consent_at, consentReference: consent_reference },
  })));

  server.registerTool('mailly_save_audience', {
    title: 'Create or update audience',
    description: `mode=create makes a static audience (optional members by external contact ID) or a dynamic one (filter required); the key and type cannot change later. mode=update changes name/description, the filter of a dynamic audience, or the members of a static one (members_mode add, default, replace or remove). Removing members never deletes the contacts. Preview with mailly_preview_audience first when the user wants to check who matches. ${GUARD}`,
    inputSchema: z.object({
      mode: z.enum(['create', 'update']),
      audience_key: audienceKey,
      name: z.string().min(1).max(200).optional().describe('Required for create'),
      description: z.string().max(1000).nullable().optional(),
      type: z.enum(['static', 'dynamic']).optional().describe('Required for create'),
      filter: filter.optional(),
      members: z.array(contactId).max(1000).optional().describe('External contact IDs (static audiences)'),
      members_mode: z.enum(['add', 'replace', 'remove']).optional().describe('update only; replace removes everyone not listed, remove takes out only the listed members (at most 100)'),
      confirmed,
    }),
    annotations: DESTRUCTIVE,
  }, ({ mode, audience_key, name, description, type, filter, members, members_mode }) => run(async () => {
    if (mode === 'create') {
      if (!name || !type) throw new Error('mode=create needs name and type');
      if (members_mode) throw new Error('members_mode is only valid with mode=update');
      return api('POST', '/audiences', { body: { key: audience_key, name, description: description ?? undefined, type, filter, members } });
    }
    if (type) throw new Error('An audience type cannot change; create a new audience instead');
    if (members_mode && !members) throw new Error('members_mode needs members');
    const profile = name !== undefined || description !== undefined || filter !== undefined;
    if (!profile && !members) throw new Error('Nothing to update');
    const updated = profile ? await api('PUT', `/audiences/${path(audience_key)}`, { body: { name, description, filter } }) : {};
    if (members_mode === 'remove') {
      if (members!.length > 100) throw new Error('Remove at most 100 members per call, or use members_mode=replace');
      const removed: string[] = [];
      // One DELETE per member; report partial progress if a later one fails.
      for (const member of members!) {
        try { await api('DELETE', `/audiences/${path(audience_key)}/members/${path(member)}`); removed.push(member); }
        catch (error) { throw new Error(`${error instanceof Error ? error.message : 'Request failed'} (removed before the failure: ${removed.join(', ') || 'none'}; failed at ${member})`); }
      }
      return { success: true, ...updated, audienceKey: audience_key, removed };
    }
    const membership = members ? await api('POST', `/audiences/${path(audience_key)}/members`, { body: { externalIds: members, mode: members_mode ?? 'add' } }) : {};
    return { success: true, ...updated, ...membership };
  }));

  server.registerTool('mailly_import_contacts', {
    title: 'Import contacts',
    description: `Create or update many contacts at once, matched by external ID (same rules as mailly_save_contact). Pass contacts (up to 1000 structured entries) or csv (raw CSV text, up to 10000 rows and 5 MB; header external_id,email plus optional name,locale,status,tags,custom_fields where tags is a JSON array or semicolon list and custom_fields a JSON object). Each row succeeds or fails on its own: report the failed rows from results to the user. ${GUARD}`,
    inputSchema: z.object({
      contacts: z.array(z.object({
        external_contact_id: contactId, email,
        name: z.string().max(200).nullable().optional(), locale: z.string().max(35).nullable().optional(),
        status: z.enum(['active', 'inactive']).optional(),
        tags: z.array(z.string().min(1).max(100)).max(100).optional(),
        custom_fields: z.record(z.string(), z.unknown()).optional(),
      })).min(1).max(1000).optional(),
      csv: z.string().min(1).max(5_000_000).optional(),
      confirmed,
    }),
    annotations: { ...WRITE, idempotentHint: true },
  }, ({ contacts, csv }) => run(() => {
    if (!contacts === !csv) throw new Error('Pass either contacts or csv');
    if (csv) return api('POST', '/contacts/import', { text: csv, headers: { 'Content-Type': 'text/csv' } });
    return api('POST', '/contacts/batch', { body: { contacts: contacts!.map(({ external_contact_id, custom_fields, ...contact }) => ({
      ...contact, externalId: external_contact_id, ...(custom_fields ? { customFields: custom_fields } : {}),
    })) } });
  }));

  server.registerTool('mailly_delete_contact', {
    title: 'Delete contact',
    description: `Delete a contact (it is marked deleted and removed from static audiences) and add a manual workspace suppression for its email, so this workspace will not mail that address again; the suppression cannot be lifted with mailly_resubscribe_recipient. To only stop marketing, prefer mailly_suppress_contact with reason=unsubscribed. State this to the user and get an explicit yes first. ${GUARD}`,
    inputSchema: z.object({ external_contact_id: contactId, confirmed }),
    annotations: DESTRUCTIVE,
  }, ({ external_contact_id }) => run(() => api('DELETE', `/contacts/${path(external_contact_id)}`)));

  server.registerTool('mailly_delete_audience', {
    title: 'Delete audience',
    description: `Permanently delete a saved audience and its membership list. The contacts themselves are kept. Cannot be undone. ${GUARD}`,
    inputSchema: z.object({ audience_key: audienceKey, confirmed }),
    annotations: DESTRUCTIVE,
  }, ({ audience_key }) => run(() => api('DELETE', `/audiences/${path(audience_key)}`)));
}
