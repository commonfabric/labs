/**
 * This deployment's Gmail push settings, read from the environment. Gmail
 * push ingest is on when both an audience and at least one service account
 * are configured, and off otherwise; with either missing, no push token could
 * be accepted.
 */

import env from "@/env.ts";

/** The service accounts whose push tokens are accepted. */
export const gmailPushServiceAccounts: readonly string[] = env
  .INGEST_GMAIL_PUSH_SERVICE_ACCOUNTS
  .split(",")
  .map((account) => account.trim())
  .filter((account) => account.length > 0);

/** The audience the push subscriptions put on their tokens. */
export const gmailPushAudience: string = env.INGEST_GMAIL_PUSH_AUDIENCE.trim();

/** Whether Gmail push ingest is configured on this deployment. */
export const gmailPushEnabled: boolean = gmailPushAudience !== "" &&
  gmailPushServiceAccounts.length > 0;
