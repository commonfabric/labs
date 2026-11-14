/**
 * The router for push deliveries into ingest channels. Mounted on every
 * deployment, and answering 404 to every request on one where Gmail push is
 * not configured.
 */

import { runtime } from "@/index.ts";
import { ingestServiceSpace } from "@/routes/ingest/service-space.ts";
import { createIngestPushRouter } from "./ingest-push.handlers.ts";
import {
  gmailPushAudience,
  gmailPushEnabled,
  gmailPushServiceAccounts,
  googleSigningKeys,
} from "./gmail-push.config.ts";

export default createIngestPushRouter({
  runtime: () => runtime,
  serviceSpace: ingestServiceSpace,
  keys: googleSigningKeys,
  audience: gmailPushAudience,
  serviceAccounts: gmailPushServiceAccounts,
  enabled: gmailPushEnabled,
});
