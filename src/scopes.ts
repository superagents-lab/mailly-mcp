// OAuth scopes a Mailly connection can be granted. Tools outside the grant are not registered.
export const SCOPES = {
  read: 'mail:read',
  draft: 'mail:draft',
  send: 'mail:send',
  manage: 'workspace:manage',
} as const;
export const MAIL_SCOPES: string[] = [SCOPES.read, SCOPES.draft, SCOPES.send, SCOPES.manage];
// What clients are told to request (401 challenge and protected resource metadata). offline_access grants no
// Mailly data; it is what makes the authorization server issue a refresh token. Clients such as ChatGPT request
// exactly these scopes, and without it they get only a 1-hour access token and must be reconnected by hand.
export const REQUESTED_SCOPES: string[] = [...MAIL_SCOPES, 'offline_access'];
