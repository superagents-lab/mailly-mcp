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

## Use the hosted server

Add `https://api.mailly.site/mcp` as a remote MCP server and sign in with your Mailly account (OAuth). In
Claude Code you can install the plugin instead:

```
/plugin install mailly --marketplace superagents-lab/mailly-mcp
```

The hosted endpoint runs OAuth in Mailly's API Worker, then forwards each request to this Worker with the
caller's API key and granted scopes (`X-Mailly-Scopes`). Those headers can only narrow what the key allows.

## Run it yourself

```
npm install
npm run dev          # wrangler dev on http://localhost:8787/mcp
```

Call `/mcp` with `Authorization: Bearer <your Mailly API key>` (from https://mailly.site/app/developers).
Without the `MAILLY_API` service binding it calls `MAILLY_API_URL` (default `https://api.mailly.site`) over
the internet. The deployed `mailly-mcp` Worker has no public route; add one in `wrangler.jsonc` if you host
your own copy.

## Develop

```
npm run typecheck
npm test             # builds dist/worker.js and runs it in Miniflare against a stub API
```

The Mailly server repository runs its OAuth and end-to-end tests against `dist/worker.js` from a sibling
checkout of this repository.

## License

MIT
