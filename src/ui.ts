import type { McpServer } from '@modelcontextprotocol/server';
import html from '../dist/ui.html';

export const WORKSPACE = 'ui://mailly/workspace';
export const MAIL = 'ui://mailly/thread-card';
export const DRAFT = 'ui://mailly/draft-card';
export function uiMeta(uri: string, entrypoint = false) {
  return { ui: { resourceUri: uri }, 'openai/ui': {
    preferredModelDisplayMode: uri === WORKSPACE ? 'fullscreen' : 'inline',
    ...(entrypoint ? { entrypoints: [{ type: 'global' }, { type: 'thread' }] } : {}),
  } };
}
export function registerMaillyUi(server: McpServer) {
  for (const [uri, surface] of [[WORKSPACE, 'workspace'], [MAIL, 'mail'], [DRAFT, 'draft']]) {
    server.registerResource(`Mailly ${surface}`, uri, { mimeType: 'text/html;profile=mcp-app' }, async () => ({ contents: [{
      uri, mimeType: 'text/html;profile=mcp-app', text: html.replace('<html lang="en">', `<html lang="en" data-surface="${surface}" data-remote="true">`),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } }, 'openai/ui': {
        availableDisplayModes: surface === 'workspace' ? ['fullscreen'] : ['inline', 'fullscreen'],
        preferredDisplayMode: surface === 'workspace' ? 'fullscreen' : 'inline',
      } },
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
export function uiResult(value: Record<string, any>) {
  const bodies: Record<string, string> = {};
  const data = value.messages ? { ...value, messages: value.messages.map(({ body_html, html_body, ...message }: Record<string, any>) => {
    if (body_html || html_body) bodies[message.id] = body_html || html_body;
    return message;
  }) } : value;
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data, _meta: { 'mailly/html': bodies } };
}
