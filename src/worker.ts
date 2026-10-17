import { createMcpHandler } from 'agents/mcp/server';
import { bearerToken, resolvePrincipal } from './principal';
import { MaillyApiError, createApi, createMaillyMcpServer } from './server';
import { MAIL_SCOPES } from './scopes';
import { BRAND_VERSION } from './brand';

export interface Env {
  /** Service binding to the Mailly API Worker. Without it, requests go to MAILLY_API_URL over the internet. */
  MAILLY_API?: Fetcher;
  /** Defaults to https://api.mailly.site. */
  MAILLY_API_URL?: string;
  /** "1" serves the MCP Apps UI (ui:// resources and tool UI metadata). */
  MCP_APPS?: string;
}

const PUBLIC_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'MCP-Protocol-Version' };
const PROTECTED_RESOURCE = /^\/\.well-known\/oauth-protected-resource(\/mcp)?$/;
const AUTHORIZATION_SERVER = /^\/\.well-known\/(oauth-authorization-server|openid-configuration)(\/.*)?$/;

const FAVICONS = new Set(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']);

async function favicon(path: string) {
  const upstream = await fetch(`https://mailly.site${path}?v=${BRAND_VERSION}`);
  if (!upstream.ok) return new Response('Not found', { status: 404 });
  return new Response(upstream.body, { headers: {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
  } });
}

const apiBase = (env: Env) => (env.MAILLY_API_URL || 'https://api.mailly.site').replace(/\/+$/, '');
const fetchApi = (env: Env) => env.MAILLY_API ? (inner: Request) => env.MAILLY_API!.fetch(inner) : (inner: Request) => fetch(inner);

// RFC 9728 metadata: this server is the resource; Mailly's API is the authorization server.
function protectedResource(origin: string, env: Env) {
  return Response.json({
    resource: `${origin}/mcp`,
    authorization_servers: [`${apiBase(env)}/api/auth`],
    scopes_supported: MAIL_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Mailly',
    resource_documentation: 'https://mailly.site/docs/clients',
  }, { headers: { ...PUBLIC_CORS, 'Cache-Control': 'public, max-age=300' } });
}

// Clients that look for authorization server metadata on the MCP host get Mailly's own document.
async function authorizationServer(env: Env) {
  const response = await fetchApi(env)(new Request(`${apiBase(env)}/.well-known/oauth-authorization-server/api/auth`));
  return new Response(response.body, { status: response.status, headers: { ...PUBLIC_CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
}

// The 401 that starts sign-in: clients read the metadata URL and request these scopes.
function challenge(origin: string, error?: string) {
  const params = [`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`, `scope="${MAIL_SCOPES.join(' ')}"`];
  if (error) params.unshift(`error="${error}"`);
  const message = error ? 'The Mailly credential is invalid or expired.' : 'Sign in to Mailly, or send Authorization: Bearer <Mailly API key>.';
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer ${params.join(', ')}` },
  });
}

/**
 * Mailly MCP server at `/mcp`, an OAuth protected resource. Each request carries a Mailly OAuth access token or
 * API key, which every tool passes unchanged to Mailly's REST API; the API checks it and the scopes it carries.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname !== '/mcp') return new Response(null, { status: 204, headers: PUBLIC_CORS });
    if (PROTECTED_RESOURCE.test(url.pathname)) return protectedResource(url.origin, env);
    if (AUTHORIZATION_SERVER.test(url.pathname)) return authorizationServer(env);
    if (url.pathname === '/') return Response.redirect('https://mailly.site/docs/clients', 302);
    // Connector UIs look up the icon from the MCP host's own favicon, so serve Mailly's current one here.
    if (FAVICONS.has(url.pathname)) return favicon(url.pathname);
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return createMcpHandler(() => { throw new Error('unreachable'); }, { route: '/mcp' }).fetch(request);

    const credential = bearerToken(request.headers.get('authorization'));
    if (!credential) return challenge(url.origin);
    const api = createApi(fetchApi(env), credential, apiBase(env));
    let principal;
    try {
      principal = await resolvePrincipal(api, credential);
    } catch (error) {
      const status = error instanceof MaillyApiError && error.status === 403 ? 403 : 502;
      const message = error instanceof Error ? error.message : 'Mailly is unavailable';
      return Response.json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }, { status });
    }
    if (!principal) return challenge(url.origin, 'invalid_token');
    // Stateless: one server per request, scoped to the caller's grant; tools outside the grant are not listed.
    const handler = createMcpHandler(() => createMaillyMcpServer(api, principal, { apps: env.MCP_APPS === '1', serverUrl: `${url.origin}/mcp` }), {
      route: '/mcp',
      onerror: (error) => console.error('[mcp] handler error', error.message),
    });
    return handler.fetch(request);
  },
};
