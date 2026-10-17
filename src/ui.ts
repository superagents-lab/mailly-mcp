import type { McpServer } from '@modelcontextprotocol/server';
import html from '../dist/ui.html';

// Two inline cards: an email thread and a reply draft. Everything else is plain tools.
export const MAIL = 'ui://mailly/thread-card';
export const DRAFT = 'ui://mailly/draft-card';
export function uiMeta(uri: string) {
  return { ui: { resourceUri: uri }, 'openai/ui': { preferredModelDisplayMode: 'inline' } };
}

/** Claude serves each MCP app from a per-server origin: the first 32 hex characters of sha256(server URL). */
export async function claudeUiDomain(serverUrl: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serverUrl)));
  return `${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32)}.claudemcpcontent.com`;
}

export function registerMaillyUi(server: McpServer, serverUrl: string) {
  for (const [uri, surface] of [[MAIL, 'mail'], [DRAFT, 'draft']]) {
    server.registerResource(`Mailly ${surface}`, uri, { mimeType: 'text/html;profile=mcp-app' }, async () => ({ contents: [{
      uri, mimeType: 'text/html;profile=mcp-app', text: html.replace('<html lang="en">', `<html lang="en" data-surface="${surface}" data-remote="true">`),
      _meta: {
        ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] }, domain: await claudeUiDomain(serverUrl) },
        'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'inline' },
      },
    }] }));
  }
}
/**
 * With MCP Apps off (production default while the UI is in development), tools are registered without UI
 * `_meta`, so every host gets the plain tool set that hosts without MCP Apps already receive. Applied to the
 * server before any tool is registered, so newly added tools are covered too.
 */
export function withoutAppUi(server: McpServer) {
  const register = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => unknown;
  (server as { registerTool: unknown }).registerTool = (name: string, { _meta: _ui, ...config }: Record<string, unknown>, cb: unknown) => register(name, config, cb);
}
// Directory reviewers read the display title from annotations.title; mirror each tool's title there.
export function withTitleAnnotations(server: McpServer) {
  const register = server.registerTool.bind(server) as (name: string, config: Record<string, any>, cb: unknown) => unknown;
  (server as { registerTool: unknown }).registerTool = (name: string, config: Record<string, any>, cb: unknown) =>
    register(name, config.title ? { ...config, annotations: { title: config.title, ...config.annotations } } : config, cb);
}
export function uiResult(value: Record<string, any>) {
  const bodies: Record<string, string> = {};
  const data = value.messages ? { ...value, messages: value.messages.map(({ body_html, html_body, ...message }: Record<string, any>) => {
    if (body_html || html_body) bodies[message.id] = body_html || html_body;
    return message;
  }) } : value;
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data, _meta: { 'mailly/html': bodies } };
}
