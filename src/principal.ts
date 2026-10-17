import { MaillyApiError, type MaillyApi } from './server';
import { MAIL_SCOPES } from './scopes';

// Who the MCP server acts as: the caller's Mailly credential (an OAuth access token or an API key), passed unchanged
// to Mailly's REST API, which enforces the same scopes. The tool list is narrowed to match.
export interface McpPrincipal {
  credential: string;
  email: string;
  scopes: string[];
  via: 'api_key' | 'oauth';
  clientId?: string;
}

export const bearerToken = (value: string | null) => /^Bearer\s+(\S+)$/i.exec(value ?? '')?.[1];

/** Resolves the credential through `GET /me`; null when Mailly rejects it. */
export async function resolvePrincipal(api: MaillyApi, credential: string): Promise<McpPrincipal | null> {
  let me: any;
  try { me = await api('GET', '/me'); } catch (error) {
    if (error instanceof MaillyApiError && error.status === 401) return null;
    throw error;
  }
  if (typeof me?.email !== 'string') return null;
  const via = me.credential_type === 'oauth' ? 'oauth' : 'api_key';
  const scopes = Array.isArray(me.scopes) ? me.scopes.filter((scope: unknown) => MAIL_SCOPES.includes(String(scope))) : [];
  return { credential, email: me.email, scopes, via, clientId: typeof me.client_id === 'string' ? me.client_id : undefined };
}
