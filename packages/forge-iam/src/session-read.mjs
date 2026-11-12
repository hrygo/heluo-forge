import { summarizeGrant } from './record.mjs';

/** Shared token-free session projection for Host and read-only adapters. */
export function sessionView(grant, status) {
  const summary = grant ? summarizeGrant(grant) : {};
  return {
    status,
    signedIn: summary.signedIn === true && Boolean(summary.principal),
    principal: summary.principal
      ? { issuer: summary.issuer ?? null, subject: summary.principal }
      : undefined,
    accessExpiresAt: summary.accessExpiresAt ?? null,
    scope: summary.scope ?? null,
  };
}
