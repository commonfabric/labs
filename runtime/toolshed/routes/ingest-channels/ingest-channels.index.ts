import env from "@/env.ts";
import { runtime } from "@/index.ts";
import { identity } from "@/lib/identity.ts";
import { hostsSpaceInStore } from "@/lib/space-authority.ts";
import { ingestServiceSpace } from "@/routes/ingest/service-space.ts";
import { gmailMailboxProof } from "@/routes/ingest-push/gmail-push.utils.ts";
import {
  gmailOAuthClientIds,
  gmailPushEnabled,
  googleSigningKeys,
} from "@/routes/ingest-push/gmail-push.config.ts";
import { memoryEngineStoreUrl } from "@/routes/storage/memory-store-url.ts";
import { createIngestChannelsRouter } from "./ingest-channels.handlers.ts";

export default createIngestChannelsRouter({
  runtime: () => runtime,
  serviceSpace: ingestServiceSpace,
  operatorDid: identity.did(),
  serviceDids: env.MEMORY_SERVICE_DIDS
    .split(",")
    .map((did) => did.trim())
    .filter((did) => did.length > 0),
  hostsSpace: hostsSpaceInStore(memoryEngineStoreUrl),
  aclMode: env.MEMORY_ACL_MODE,
  apiUrl: env.API_URL,
  // Absent where Gmail push is off, and a mint carrying a proof is then
  // refused.
  gmail: gmailMailboxProof(
    gmailPushEnabled,
    googleSigningKeys,
    gmailOAuthClientIds,
  ),
});
