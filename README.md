# mailly-mcp

The MCP server behind [Mailly](https://mailly.site)'s connector, plus the Mailly plugin for Claude and Codex.

- [`src/`](src): the MCP server, a Cloudflare Worker. It offers typed tools for Mailly mail, drafts, sending,
  domains, contacts, templates, campaigns, workflows and webhooks. Every tool calls the
  [Mailly REST API](https://mailly.site/docs) with the caller's Mailly API key, so authentication, billing and
  workspace isolation all stay in the API.
- [`ui/`](ui): the MCP Apps UI (email and draft cards), bundled into `ui://` resources. It is off unless
  `MCP_APPS=1`.
- [`plugins/mailly`](plugins/mailly): the plugin for Claude (claude.ai, Cowork and Claude Code) and Codex. It
  points at the hosted server and adds a skill for working with email safely.
- [`plugins/openai/mailly`](plugins/openai/mailly): the public ChatGPT/Codex update package, based on the
  published 0.3.1 release, with its existing listing, review cases, demo link, skill, and PNG icon retained.

## Use the hosted server

Add `https://mcp.mailly.site/mcp` as a remote MCP server and sign in with your Mailly account (OAuth). In
ChatGPT, add the published [Mailly plugin](https://chatgpt.com/plugins/plugin_asdk_app_6ad4b5fb74c0819197bc99e0927f15ab).
In Claude Code you can install the plugin instead:

```
/plugin install mailly --marketplace superagents-lab/mailly-mcp
```

This server is an OAuth protected resource. Mailly's API (`https://api.mailly.site/api/auth`) is the authorization
server: clients find it through `/.well-known/oauth-protected-resource`, sign the user in there, and send the
access token here. The server passes the token, or an API key, unchanged to Mailly's REST API, which checks it and
the scopes it carries. The tool list is narrowed to the same scopes (`GET /me`).

### Keep ChatGPT and Codex connections authorized

The public OpenAI configuration in `plugins/openai/mailly/mcp.json` and the Codex compatibility
configuration in `plugins/mailly/.codex-plugin/mcp.json` request
`offline_access` in `extensions.com.openai.auth.baseScopes`. Mailly issues a refresh token only when
that scope is granted. Resource discovery and tool scopes describe Mailly data permissions; they do not
request offline access on the client's behalf. Without it, sign-in succeeds but access ends when the
one-hour access token expires.

For a published OpenAI plugin, upload the updated plugin package to the existing plugin, confirm that
the saved MCP authentication settings include `offline_access`, then reconnect the account and rescan.
Deploying the Worker alone does not update those saved settings. Reconnecting with the old settings
will still produce a connection without a refresh token. For manually configured clients, include
`offline_access` alongside the desired Mailly scopes when starting OAuth authorization.

Package the contents of `plugins/openai/mailly` as the upload root. Do not include the repository,
marketplace, or the installed plugin's Portal-generated `.app.json` and `apps` binding in a public
upload. Keep those generated bindings in the installed release; the submission portal owns them.
The package version is 0.3.2. Separately, the Worker declares all three tool annotation booleans
explicitly, including `destructiveHint: false` for read-only tools; that server update requires a
Worker deployment and rescan. The MCP Registry listing is unchanged.

## Run it yourself

```
npm install
npm run dev          # wrangler dev on http://localhost:8787/mcp
```

Call `/mcp` with `Authorization: Bearer <your Mailly API key>` (from https://mailly.site/app/developers).
Without the `MAILLY_API` service binding it calls `MAILLY_API_URL` (default `https://api.mailly.site`) over
the internet. To host your own copy, change the `mcp.mailly.site` route in `wrangler.jsonc`. OAuth sign-in only
works at `https://mcp.mailly.site/mcp`, because Mailly issues tokens for that resource; elsewhere use an API key.

## Develop

```
npm run typecheck
npm test             # builds dist/worker.js and runs it in Miniflare against a stub API
```

The Mailly server repository runs its OAuth and end-to-end tests against `dist/worker.js` from a sibling
checkout of this repository.

`server.json` is the listing in the [MCP Registry](https://registry.modelcontextprotocol.io) as
`site.mailly/mcp`. The `site.mailly` namespace is proven by a DNS TXT record on mailly.site, so publish with
`mcp-publisher login dns --domain mailly.site --private-key <key>` and `mcp-publisher publish` from a machine that
holds the key. Bump `version` for each release.

## License

MIT
