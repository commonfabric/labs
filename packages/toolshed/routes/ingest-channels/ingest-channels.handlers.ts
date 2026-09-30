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
import { fetchGmailMailbox } from "@/routes/ingest-push/gmail-push.utils.ts";
import { processGmailBind, processGmailUnbind } from "./gmail-binding.utils.ts";
import {
  type ControlDeps,
  processList,
  processMint,
  processRevoke,
  processRotate,
} from "./ingest-channels.utils.ts";
import type {
  GmailBindRoute,
  GmailUnbindRoute,
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
  serviceSpace: identity.did(),
  operatorDid: identity.did(),
  serviceDids,
  hostsSpace,
  aclMode: env.MEMORY_ACL_MODE,
  apiUrl: env.API_URL,
  logger,
});

export const mint: AppRouteHandler<MintRoute> = async (c) => {
  const callerDid = c.get("verifiedUserDid");
  if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
  const result = await processMint(
    deps(c.get("logger")),
    callerDid,
    c.req.valid("json"),
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
    c.req.valid("json"),
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
    c.req.valid("json"),
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
    c.req.valid("json"),
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};

export const gmailBind: AppRouteHandler<GmailBindRoute> = async (c) => {
  const callerDid = c.get("verifiedUserDid");
  if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
  const result = await processGmailBind(
    { ...deps(c.get("logger")), fetchMailbox: fetchGmailMailbox },
    callerDid,
    c.req.valid("json"),
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};

export const gmailUnbind: AppRouteHandler<GmailUnbindRoute> = async (c) => {
  const callerDid = c.get("verifiedUserDid");
  if (!callerDid) return c.json({ error: "Unauthorized" }, 401);
  const result = await processGmailUnbind(
    deps(c.get("logger")),
    callerDid,
    c.req.valid("json"),
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};
