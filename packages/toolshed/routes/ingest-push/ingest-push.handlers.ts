/**
 * The push handlers: thin transport wrappers over `gmail-push.utils.ts`, where
 * the verification and delivery rules live and are tested against a real
 * runtime.
 */

import { createRemoteJWKSet } from "@panva/jose";

import type { AppRouteHandler } from "@/lib/types.ts";
import { runtime } from "@/index.ts";
import { ingestServiceSpace } from "@/routes/ingest/service-space.ts";
import { GOOGLE_OIDC_JWKS_URL, processGmailPush } from "./gmail-push.utils.ts";
import {
  gmailPushAudience,
  gmailPushServiceAccounts,
} from "./gmail-push.config.ts";
import type { GmailPushRoute } from "./ingest-push.routes.ts";

// Google's signing keys, fetched on first use and cached; `jose` refetches
// when a token names a key id the cache does not hold.
const googleKeys = createRemoteJWKSet(new URL(GOOGLE_OIDC_JWKS_URL));

/** Handles one Gmail notification delivered by a Pub/Sub push subscription. */
export const gmail: AppRouteHandler<GmailPushRoute> = async (c) => {
  // A push addressed to another registry is one this deployment cannot
  // deliver, and saying so with a 404 has Pub/Sub redeliver it; acknowledging
  // it would lose the notification.
  if (c.req.valid("param").space !== ingestServiceSpace) {
    return c.json({ error: "Not found" }, 404);
  }
  const result = await processGmailPush(
    {
      runtime,
      serviceSpace: ingestServiceSpace,
      keys: googleKeys,
      audience: gmailPushAudience,
      serviceAccounts: gmailPushServiceAccounts,
      logger: c.get("logger"),
    },
    c.req.header("Authorization"),
    await c.req.text(),
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};
