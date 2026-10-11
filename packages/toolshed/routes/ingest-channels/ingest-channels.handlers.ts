// Thin transport wrappers over ingest-channels.utils.ts, mirroring how
// ingest.handlers.ts wraps processIngest: everything security-relevant lives in
// the utils module and is tested against a real runtime. Rate limiting is
// middleware (see .index.ts), so what is left here is the verified caller DID
// and the call itself.

import type { AppRouteHandler } from "@/lib/types.ts";
import { runtime } from "@/index.ts";
import { identity } from "@/lib/identity.ts";
import env from "@/env.ts";
import { memoryEngineStoreUrl } from "@/routes/storage/memory-store-url.ts";
import { hostsSpaceInStore } from "@/lib/space-authority.ts";
import { ingestServiceSpace } from "@/routes/ingest/service-space.ts";
import {
  fetchGmailMailbox,
  verifyGmailIdToken,
} from "@/routes/ingest-push/gmail-push.utils.ts";
import {
  gmailOAuthClientIds,
  gmailPushEnabled,
  googleSigningKeys,
} from "@/routes/ingest-push/gmail-push.config.ts";
import {
  type ControlDeps,
  processList,
  processMint,
  processRevoke,
  processRotate,
} from "./ingest-channels.utils.ts";
import type {
  ListOwnRoute,
  ListRoute,
  MintRoute,
  RevokeRoute,
  RotateRoute,
} from "./ingest-channels.routes.ts";

const serviceDids = env.MEMORY_SERVICE_DIDS
  .split(",")
  .map((did) => did.trim())
  .filter((did) => did.length > 0);

const hostsSpace = hostsSpaceInStore(memoryEngineStoreUrl);

const deps = (logger: ControlDeps["logger"]): ControlDeps => ({
  runtime,
  serviceSpace: ingestServiceSpace,
  operatorDid: identity.did(),
  serviceDids,
  hostsSpace,
  aclMode: env.MEMORY_ACL_MODE,
  apiUrl: env.API_URL,
  // Absent where Gmail push is off: a mailbox nothing will ever deliver to is
  // not worth binding, and the mint says so.
  ...(gmailPushEnabled
    ? {
      gmail: {
        fetchMailbox: fetchGmailMailbox,
        verifyIdToken: (idToken: string) =>
          verifyGmailIdToken(googleSigningKeys, gmailOAuthClientIds, idToken),
      },
    }
    : {}),
  logger,
});

export const mint: AppRouteHandler<MintRoute> = async (c) => {
  const callerDid = c.get("verifiedUserDid");
  if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
  const result = await processMint(
    deps(c.get("logger")),
    callerDid,
    { ...c.req.valid("json"), space: c.req.valid("param").space },
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};

export const rotate: AppRouteHandler<RotateRoute> = async (c) => {
  const callerDid = c.get("verifiedUserDid");
  if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
  const result = await processRotate(
    deps(c.get("logger")),
    callerDid,
    { ...c.req.valid("json"), space: c.req.valid("param").space },
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};

export const revoke: AppRouteHandler<RevokeRoute> = async (c) => {
  const callerDid = c.get("verifiedUserDid");
  if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
  const result = await processRevoke(
    deps(c.get("logger")),
    callerDid,
    { ...c.req.valid("json"), space: c.req.valid("param").space },
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const callerDid = c.get("verifiedUserDid");
  if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
  const result = await processList(
    deps(c.get("logger")),
    callerDid,
    { space: c.req.valid("param").space },
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};

export const listOwn: AppRouteHandler<ListOwnRoute> = async (c) => {
  const callerDid = c.get("verifiedUserDid");
  if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
  const result = await processList(deps(c.get("logger")), callerDid, {});
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};
