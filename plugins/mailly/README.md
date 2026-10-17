# Mailly for Claude

This plugin gives Claude a real email inbox through [Mailly](https://mailly.site).
Claude can search and read your mail, summarize what needs attention, draft
replies that wait for your review, wait for a verification code you are
expecting, and prepare templates, campaigns and workflows. Nothing is sent
until you have seen the exact text and recipients and approved it.

## What's inside

- **Mailly connector** (`.mcp.json`): the remote Mailly MCP server at
  `https://mcp.mailly.site/mcp`. You sign in with your Mailly account through
  OAuth and choose which permissions to grant: read, draft, send and manage.
- **`mailly` skill**: tells Claude how to triage mail, draft and send replies
  safely, wait for incoming mail, and set up automation.

## Use it

1. Install the plugin. In Claude Code:

   ```
   /plugin install mailly --marketplace superagents-lab/mailly-mcp
   ```

   Then connect the Mailly connector from the plugin's
   Connectors tab and sign in. No account yet? Claim an address at
   [mailly.site/onboard](https://mailly.site/onboard).
2. Ask things like:
   - "What in my inbox needs a reply today?"
   - "Draft a reply to the latest email from Acme and show it to me."
   - "Wait for the verification code from GitHub and tell me what it is."
   - "Prepare a campaign to my newsletter audience from the October template."

## Data

The plugin itself stores nothing and runs no code. Requests go only to
`api.mailly.site`, which handles your mail under Mailly's
[privacy policy](https://mailly.site/privacy) and [terms](https://mailly.site/terms).
Email content you ask about is returned to Claude so it can answer you.

## Support

Documentation: https://mailly.site/docs/clients/claude
Issues: https://github.com/superagents-lab/mailly-mcp/issues
