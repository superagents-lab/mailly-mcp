// OAuth scopes a Mailly connection can be granted. Tools outside the grant are not registered.
export const SCOPES = {
  read: 'mail:read',
  draft: 'mail:draft',
  send: 'mail:send',
  manage: 'workspace:manage',
} as const;
export const MAIL_SCOPES: string[] = [SCOPES.read, SCOPES.draft, SCOPES.send, SCOPES.manage];
