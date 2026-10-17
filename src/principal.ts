import { MAIL_SCOPES } from './scopes';

// Who the MCP server acts as: a Mailly API key, narrowed to the scopes the connection was granted.
export interface McpPrincipal {
  apiKey: string;
  email: string;
  scopes: string[];
  via: 'api_key' | 'oauth';
  clientId?: string;
}

// Headers the hosted gateway sets after it has verified an OAuth token. They can only narrow what the API key
// already allows, so a caller that sends them directly gains nothing.
export const PRINCIPAL_HEADERS = { scopes: 'X-Mailly-Scopes', email: 'X-Mailly-Account', via: 'X-Mailly-Via', client: 'X-Mailly-Client' } as const;

const bearer = (value: string | null) => /^Bearer\s+(\S+)$/i.exec(value ?? '')?.[1];

/** Reads the caller from a request: `Authorization: Bearer <Mailly API key>` plus the optional gateway headers. */
export function principalFromRequest(request: Request): Omit<McpPrincipal, 'email'> & { email?: string } | null {
  const apiKey = bearer(request.headers.get('authorization'));
  if (!apiKey) return null;
  const granted = request.headers.get(PRINCIPAL_HEADERS.scopes);
  const scopes = granted === null ? MAIL_SCOPES : granted.split(/\s+/).filter((scope) => MAIL_SCOPES.includes(scope));
  const via = request.headers.get(PRINCIPAL_HEADERS.via) === 'oauth' ? 'oauth' : 'api_key';
  return {
    apiKey, scopes, via,
    email: request.headers.get(PRINCIPAL_HEADERS.email) || undefined,
    clientId: request.headers.get(PRINCIPAL_HEADERS.client) || undefined,
  };
}
