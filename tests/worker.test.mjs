// Runs the built Worker (dist/worker.js) in Miniflare against a stub Mailly API bound as MAILLY_API.
// End-to-end coverage against the real API lives in the Mailly server repo, which runs both Workers together.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

const ORIGIN = 'http://mcp.localhost';
// Stub credentials: an API key, and an OAuth token whose grant lacks mail:send and workspace:manage.
const IDENTITIES = {
  'Bearer good-key': { email: 'owner@example.com', credential_type: 'api_key', scopes: ['mail:read', 'mail:draft', 'mail:send', 'workspace:manage'], client_id: null },
  'Bearer draft-token': { email: 'owner@example.com', credential_type: 'oauth', scopes: ['mail:read', 'mail:draft', 'not-a-scope'], client_id: 'client-1' },
};

async function worker(t, { apps = false } = {}) {
  const calls = [];
  const mf = new Miniflare({
    modules: true, scriptPath: new URL('../dist/worker.js', import.meta.url).pathname,
    compatibilityDate: '2026-04-01', compatibilityFlags: ['nodejs_compat'],
    bindings: { MCP_APPS: apps ? '1' : '0', MAILLY_API_URL: 'http://api.localhost' },
    serviceBindings: {
      MAILLY_API: async (request) => {
        const url = new URL(request.url);
        calls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: request.headers.get('authorization') });
        if (url.pathname === '/.well-known/oauth-authorization-server/api/auth') return Response.json({ issuer: 'http://api.localhost/api/auth' });
        const identity = IDENTITIES[request.headers.get('authorization')];
        if (!identity) return Response.json({ success: false, error: 'Invalid API key' }, { status: 401 });
        if (url.pathname === '/me') return Response.json({ success: true, ...identity });
        if (url.pathname === '/balance') return Response.json({ success: true, balance: 5 });
        if (url.pathname === '/mail-drafts') return Response.json({ success: true, drafts: [{ id: 'd1', text: 'Hi', revision: 1, review_url: 'https://mailly.site/review#secret', review_expires_at: 1 }] });
        return Response.json({ success: true });
      },
    },
    outboundService: (request) => { throw new Error(`External network calls are forbidden in tests: ${request.url}`); },
  });
  t.after(() => mf.dispose());
  return { mf, calls };
}

function rpcClient(mf, headers) {
  let id = 0;
  return async (method, params = {}) => {
    const response = await mf.dispatchFetch(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const payload = text.startsWith('{') ? text : text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5)).at(-1);
    const message = JSON.parse(payload);
    assert.ok(!message.error, JSON.stringify(message.error));
    return message.result;
  };
}

test('without a credential: the OAuth challenge points at this server\'s metadata, before any API call', async (t) => {
  const { mf, calls } = await worker(t);
  const response = await mf.dispatchFetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer resource_metadata="http://mcp.localhost/.well-known/oauth-protected-resource/mcp", scope="mail:read mail:draft mail:send workspace:manage"');
  assert.equal((await mf.dispatchFetch(`${ORIGIN}/other`)).status, 404);
  assert.equal(calls.length, 0);

  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const prm = await mf.dispatchFetch(`${ORIGIN}${path}`);
    assert.equal(prm.headers.get('Access-Control-Allow-Origin'), '*');
    assert.deepEqual(await prm.json(), {
      resource: 'http://mcp.localhost/mcp', authorization_servers: ['http://api.localhost/api/auth'],
      scopes_supported: ['mail:read', 'mail:draft', 'mail:send', 'workspace:manage'], bearer_methods_supported: ['header'],
      resource_name: 'Mailly', resource_documentation: 'https://mailly.site/docs/clients',
    });
  }
  const asMeta = await mf.dispatchFetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
  assert.equal((await asMeta.json()).issuer, 'http://api.localhost/api/auth');

  const rejected = await mf.dispatchFetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer expired' }, body: '{}' });
  assert.equal(rejected.status, 401);
  assert.match(rejected.headers.get('WWW-Authenticate'), /^Bearer error="invalid_token", resource_metadata=/);
});

test('an API key gets every tool, and each call reaches the API with that key', async (t) => {
  const { mf, calls } = await worker(t);
  const rpc = rpcClient(mf, { Authorization: 'Bearer good-key' });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.serverInfo.name, 'mailly');
  const tools = (await rpc('tools/list')).tools;
  const names = tools.map((tool) => tool.name);
  for (const name of ['mailly_list_threads', 'mailly_save_draft', 'mailly_approve_draft', 'mailly_send_email', 'mailly_manage_workflow', 'mailly_wait_for_mail']) assert.ok(names.includes(name), name);
  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} has a title`);
    assert.ok(tool.annotations && ('readOnlyHint' in tool.annotations || 'destructiveHint' in tool.annotations), `${tool.name} is annotated`);
    assert.ok(tool.name.length <= 64, tool.name);
  }
  assert.ok(!names.some((name) => name.startsWith('mailly_client_') || name === 'mailly_open'), 'app-only tools stay off without MCP Apps');

  const account = await rpc('tools/call', { name: 'mailly_account', arguments: {} });
  assert.equal(account.structuredContent.balance, 5);
  assert.deepEqual(calls.at(-1), { method: 'GET', path: '/balance', query: {}, auth: 'Bearer good-key' });
  assert.equal(account.structuredContent.email, 'owner@example.com');
  const drafts = await rpc('tools/call', { name: 'mailly_list_drafts', arguments: { thread_id: 't' } });
  assert.equal(drafts.structuredContent.drafts[0].review_url, 'https://mailly.site/review#secret');
});

test('an OAuth grant narrows the tool set, passes the token through and withholds review links without send', async (t) => {
  const { mf, calls } = await worker(t);
  const rpc = rpcClient(mf, { Authorization: 'Bearer draft-token' });
  const names = (await rpc('tools/list')).tools.map((tool) => tool.name);
  assert.ok(names.includes('mailly_save_draft'));
  for (const name of ['mailly_approve_draft', 'mailly_send_email', 'mailly_manage_workflow']) assert.ok(!names.includes(name), name);
  const account = await rpc('tools/call', { name: 'mailly_account', arguments: {} });
  assert.equal(account.structuredContent.email, 'owner@example.com');
  assert.deepEqual(account.structuredContent.scopes, ['mail:read', 'mail:draft']);
  assert.ok(calls.every((call) => call.auth === 'Bearer draft-token'), 'the token reaches the API unchanged');
  const drafts = await rpc('tools/call', { name: 'mailly_list_drafts', arguments: { thread_id: 't' } });
  assert.equal(drafts.structuredContent.drafts[0].review_url, undefined);
});

test('MCP Apps on: only the thread and draft cards are served, with Claude\'s sandbox domain', async (t) => {
  const { mf } = await worker(t, { apps: true });
  const rpc = rpcClient(mf, { Authorization: 'Bearer good-key' });
  const resources = (await rpc('resources/list')).resources.map((resource) => resource.uri).sort();
  assert.deepEqual(resources, ['ui://mailly/draft-card', 'ui://mailly/thread-card'], 'only the two inline cards; no fullscreen workspace');
  const card = await rpc('resources/read', { uri: 'ui://mailly/thread-card' });
  assert.match(card.contents[0].text, /data-surface="mail"/);
  const domain = createHash('sha256').update('http://mcp.localhost/mcp').digest('hex').slice(0, 32);
  assert.equal(card.contents[0]._meta.ui.domain, `${domain}.claudemcpcontent.com`, 'Claude sandbox origin derives from the server URL');
  const names = (await rpc('tools/list')).tools.map((tool) => tool.name);
  assert.ok(!names.some((name) => name.startsWith('mailly_client_') || name === 'mailly_open' || name === 'mailly_browse'), 'no workspace or catch-all tools');
  assert.ok(names.includes('mailly_read_thread'));
});
