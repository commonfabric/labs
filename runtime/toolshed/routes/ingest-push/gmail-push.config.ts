/**
 * This deployment's Gmail push settings, read from the environment. Gmail
 * push ingest is on when at least one service account is configured, and off
 * otherwise; with none, no push token could be accepted.
 */

import { createRemoteJWKSet } from "@panva/jose";

import env from "@/env.ts";
import { ingestServiceSpace } from "@/routes/ingest/service-space.ts";
import { GOOGLE_OIDC_JWKS_URL } from "./gmail-push.utils.ts";

/** A deployment's resolved Gmail push settings. */
export interface GmailPushSettings {
  /** Whether Gmail push ingest is on. */
  enabled: boolean;

  /** The audience a push token has to carry. */
  audience: string;

  /** The service accounts whose push tokens are accepted. */
  serviceAccounts: readonly string[];
}

/**
 * Resolves the Gmail push settings from their two environment values.
 *
 * An unset audience is `serviceSpace`, the DID of the space the deployment
 * keeps its ingest registry in. That DID is already in the push URL a
 * subscription is given, and it differs between deployments, so a token
 * minted for one is refused by another without anything being configured. It
 * also depends on no hostname, which matters where a deployment is reached
 * under more than one.
 */
export function resolveGmailPushSettings(
  configured: { audience: string; serviceAccounts: string },
  serviceSpace: string,
): GmailPushSettings {
  const serviceAccounts = configured.serviceAccounts
    .split(",")
    .map((account) => account.trim())
    .filter((account) => account.length > 0);
  return {
    enabled: serviceAccounts.length > 0,
    audience: configured.audience.trim() || serviceSpace,
    serviceAccounts,
  };
}

const settings = resolveGmailPushSettings(
  {
    audience: env.INGEST_GMAIL_PUSH_AUDIENCE,
    serviceAccounts: env.INGEST_GMAIL_PUSH_SERVICE_ACCOUNTS,
  },
  ingestServiceSpace,
);

/** The service accounts whose push tokens are accepted. */
export const gmailPushServiceAccounts: readonly string[] =
  settings.serviceAccounts;

/** The audience a push token has to carry. */
export const gmailPushAudience: string = settings.audience;

/** Whether Gmail push ingest is configured on this deployment. */
export const gmailPushEnabled: boolean = settings.enabled;

/**
 * The OAuth client ids whose ID tokens a mint accepts as proof of a mailbox.
 * Empty, a mint proves a mailbox with an access token only.
 */
export const gmailOAuthClientIds: readonly string[] = env
  .INGEST_GMAIL_OAUTH_CLIENT_IDS
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);

// Google's signing keys, fetched on first use and cached; `jose` refetches
// when a token names a key id the cache does not hold. One set serves the
// push route and the mailbox proof.
export const googleSigningKeys = createRemoteJWKSet(
  new URL(GOOGLE_OIDC_JWKS_URL),
);
