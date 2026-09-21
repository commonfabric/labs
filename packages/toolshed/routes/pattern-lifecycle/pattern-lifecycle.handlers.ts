// Thin transport wrappers over pattern-lifecycle.utils.ts, the shape the
// ingest-channels handlers set: the verified caller DID, the deployment's
// dependencies, and the call.

import env from "@/env.ts";
import { runtime } from "@/index.ts";
import { identity } from "@/lib/identity.ts";
import { aclDocId } from "@commonfabric/memory/acl";
import { serverExecutionHost } from "@/lib/server-execution.ts";
import { hostsSpaceInStore } from "@/lib/space-authority.ts";
import type { AppRouteHandler } from "@/lib/types.ts";
import { memoryEngineStoreUrl } from "@/routes/storage/memory-store-url.ts";
import { memoryServer } from "@/routes/storage/memory.ts";
import type {
  InstantiateRoute,
  SetSourceRoute,
  UploadRoute,
} from "./pattern-lifecycle.routes.ts";
import {
  type LifecycleDeps,
  processInstantiate,
  processSetSource,
  processUpload,
} from "./pattern-lifecycle.utils.ts";

const serviceDids = env.MEMORY_SERVICE_DIDS
  .split(",")
  .map((did) => did.trim())
  .filter((did) => did.length > 0);

const hostsSpace = hostsSpaceInStore(memoryEngineStoreUrl);

const deps = (logger: LifecycleDeps["logger"]): LifecycleDeps => ({
  authority: {
    runtime,
    operatorDid: identity.did(),
    serviceDids,
    hostsSpace,
    aclMode: env.MEMORY_ACL_MODE,
    readAcl: async (space) =>
      (await memoryServer.readDocument(space, aclDocId(space)))?.value,
  },
  host: serverExecutionHost,
  serviceIdentity: identity,
  append: (entry) => memoryServer.commitDelegatedAppend(entry),
  readDocument: (space, id) => memoryServer.readDocument(space, id),
  watchAdmittedCommits: (watcher) => memoryServer.watchAdmittedCommits(watcher),
  logger,
});

/**
 * The DID the first-party proof verified. The router mounts that middleware
 * ahead of every handler here, so an absent DID is a mount error rather
 * than a caller's failure.
 */
const verifiedCaller = (
  c: { get(key: "verifiedUserDid"): unknown },
): string => {
  const callerDid = c.get("verifiedUserDid");
  if (typeof callerDid !== "string") {
    throw new Error("pattern-lifecycle handler reached without a verified DID");
  }
  return callerDid;
};

export const upload: AppRouteHandler<UploadRoute> = async (c) => {
  const result = await processUpload(
    deps(c.get("logger")),
    verifiedCaller(c),
    c.req.valid("json"),
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};

export const instantiate: AppRouteHandler<InstantiateRoute> = async (c) => {
  const result = await processInstantiate(
    deps(c.get("logger")),
    verifiedCaller(c),
    c.req.valid("json"),
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};

export const setsrc: AppRouteHandler<SetSourceRoute> = async (c) => {
  const result = await processSetSource(
    deps(c.get("logger")),
    verifiedCaller(c),
    c.req.valid("json"),
  );
  if (result.status === 200) return c.json(result.body, 200);
  return c.json(result.body, result.status);
};
