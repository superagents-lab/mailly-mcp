import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { MaillyApi } from './server';
import type { McpPrincipal } from './principal';
import { SCOPES } from './scopes';
import { confirmed, DESTRUCTIVE, email, GUARD, key, OUTWARD, path, READ, run, WRITE } from './common';

const templateKey = key.describe('Template key (letters, digits, . _ : -)');
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const definition = z.object({
  defaultLocale: z.string().min(2).max(50).describe('Must be one of the locales keys, e.g. "en"'),
  emailType: z.enum(['transactional', 'lifecycle', 'marketing']),
  from: z.object({ email: email.describe('On a domain with verified sending (required to publish)'), name: z.string().max(200).optional() }),
  topic: z.string().max(200).optional().describe('Required for lifecycle and marketing'),
  recipientReason: z.string().max(300).optional().describe('Required for marketing'),
  frequencyCap: z.object({ days: z.number().int().min(1).max(3650), max: z.number().int().min(1).max(10000) }).optional().describe('Marketing only'),
  variables: z.record(z.string(), z.object({
    type: z.enum(['string', 'number', 'boolean']), required: z.boolean().optional(), sensitive: z.boolean().optional(), default: scalar.optional(),
  })).describe('Declared {{variable}} names; every token used in subject/html/text must be declared'),
  locales: z.record(z.string(), z.object({
    subject: z.string().min(1).max(300), html: z.string().min(1).max(256_000), text: z.string().min(1).max(256_000),
  })).describe('Content per locale, at most 25'),
});
const which = {
  draft: z.boolean().optional().describe('Use the unpublished draft'),
  version: z.number().int().positive().optional().describe('Published version; defaults to the active one'),
  locale: z.string().max(50).optional(),
  variables: z.record(z.string(), scalar).optional(),
};

// Versioned email templates: draft editing, preview, lifecycle and test sends.
export function registerTemplateTools(server: McpServer, api: MaillyApi, principal: McpPrincipal) {
  const can = (scope: string) => principal.scopes.includes(scope);
  const target = (draft?: boolean, version?: number) => {
    if (draft && version) throw new Error('Use draft or version, not both');
    return { ...(draft ? { draft: true } : {}), ...(version ? { version } : {}) };
  };

  if (can(SCOPES.read)) server.registerTool('mailly_render_template', {
    title: 'Render template preview',
    description: 'Render a template draft or published version with sample variables and return the final subject, HTML and text. Nothing is sent or saved.',
    inputSchema: z.object({ template_key: templateKey, ...which }),
    annotations: READ,
  }, ({ template_key, draft, version, locale, variables }) => run(() => api('POST', `/templates/${path(template_key)}/render`, {
    body: { ...target(draft, version), locale, variables },
  })));

  if (can(SCOPES.manage)) {
    server.registerTool('mailly_save_template_draft', {
      title: 'Create or edit template draft',
      description: `mode=create adds a template (name and definition required); mode=update replaces the draft definition (read it with mailly_get_template first and keep everything the user did not ask to change). Saving never changes the published version that workflows and sends use; publishing is a separate step. ${GUARD}`,
      inputSchema: z.object({ mode: z.enum(['create', 'update']), template_key: templateKey, name: z.string().min(1).max(200).optional(), definition, confirmed }),
      annotations: WRITE,
    }, ({ mode, template_key, name, definition }) => run(() => {
      if (mode === 'create') {
        if (!name) throw new Error('mode=create needs name');
        return api('POST', '/templates', { body: { templateKey: template_key, name, definition } });
      }
      return api('PUT', `/templates/${path(template_key)}/draft`, { body: { name, definition } });
    }));

    server.registerTool('mailly_manage_template', {
      title: 'Publish or archive template',
      description: `publish turns the current draft into a new immutable version (the sender domain must be verified for sending, and marketing needs the brand footer); existing workflows keep the version they reference. archive retires the template so it can no longer be edited or published. ${GUARD}`,
      inputSchema: z.object({ template_key: templateKey, action: z.enum(['publish', 'archive']), confirmed }),
      annotations: DESTRUCTIVE,
    }, ({ template_key, action }) => run(() => api('POST', `/templates/${path(template_key)}/${action}`)));
  }

  if (can(SCOPES.send)) server.registerTool('mailly_send_template_test', {
    title: 'Send template test email',
    description: `Send one real test email of a template to a single address through the normal governed send path (it costs credits and is recorded as a template test). Render with mailly_render_template first; send only to an address the user named. ${GUARD}`,
    inputSchema: z.object({ template_key: templateKey, to: email, ...which, confirmed }),
    annotations: OUTWARD,
  }, ({ template_key, to, draft, version, locale, variables }) => run(() => api('POST', `/templates/${path(template_key)}/test-send`, {
    body: { to, ...target(draft, version), locale, variables },
  })));
}
