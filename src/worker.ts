import { createMcpHandler } from 'agents/mcp/server';
import { principalFromRequest } from './principal';
import { createApi, createMaillyMcpServer } from './server';

export interface Env {
  /** Service binding to the Mailly API Worker. Without it, requests go to MAILLY_API_URL over the internet. */
  MAILLY_API?: Fetcher;
  /** Defaults to https://api.mailly.site. */
  MAILLY_API_URL?: string;
  /** "1" serves the MCP Apps UI (ui:// resources and tool UI metadata). */
  MCP_APPS?: string;
}

const unauthorized = () => new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing Mailly API key: send Authorization: Bearer <key>' }, id: null }), {
  status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
});

/**
 * Mailly MCP server at `/mcp`. Each request carries a Mailly API key; every tool calls Mailly's REST API with it.
 * The hosted connector at https://api.mailly.site/mcp runs OAuth in front of this Worker and forwards here.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return createMcpHandler(() => { throw new Error('unreachable'); }, { route: '/mcp' }).fetch(request);
    // The account email only labels results; the API key alone decides what the caller can reach.
    const caller = principalFromRequest(request);
    if (!caller) return unauthorized();
    const base = (env.MAILLY_API_URL || 'https://api.mailly.site').replace(/\/+$/, '');
    const fetchApi = env.MAILLY_API ? (inner: Request) => env.MAILLY_API!.fetch(inner) : (inner: Request) => fetch(inner);
    const api = createApi(fetchApi, caller.apiKey, base);
    // Stateless: one server per request, scoped to the caller's grant; tools outside the grant are not listed.
    const handler = createMcpHandler(() => createMaillyMcpServer(api, { ...caller, email: caller.email ?? '' }, { apps: env.MCP_APPS === '1' }), {
      route: '/mcp',
      onerror: (error) => console.error('[mcp] handler error', error.message),
    });
    return handler.fetch(request);
  },
};
