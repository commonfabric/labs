import { setModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import * as FS from "@std/fs";

import { verifyConnectionAuthorization } from "@commonfabric/memory/v2/connection-auth";
import * as MemoryServer from "@commonfabric/memory/v2/server";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import { experimentalOptionsFromEnv } from "@commonfabric/runner/experimental-posture";

import { MemoryRouterPolicy } from "./memory-router.ts";
import { memoryEngineStoreUrl } from "./memory-store-url.ts";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import {
  memoryAclPrincipalsFor,
  serverExecutionEnabledFromEnv,
} from "@/lib/server-execution-flag.ts";

const memoryAudience = identity.did();
const routerPolicy = env.MEMORY_ROUTER_CONFIG_FILE === ""
  ? undefined
  : new MemoryRouterPolicy(env.MEMORY_ROUTER_CONFIG_FILE);
if (
  routerPolicy !== undefined &&
  (env.MEMORY_ACL_MODE !== "enforce" || env.DB_PATH)
) {
  throw new Error(
    "Mode A requires directory storage and enforced explicit ACLs",
  );
}

if (routerPolicy !== undefined) {
  if (experimentalOptionsFromEnv(Deno.env.get).modernCellRep !== true) {
    throw new Error(
      "Mode A requires EXPERIMENTAL_MODERN_CELL_REP=true in tracked configuration",
    );
  }
  // Runtime startup later reads the same required flag; initialize the Memory
  // encoder before the private listener advertises its capabilities.
  setModernCellRepConfig(true);
}

// Server-execution v2 (OW31, RULED 2026-08-18/19): under the flag this
// process's own identity is a DELEGATING principal — the serving loop's
// loopback sessions carry the `actingAs: "space-owner"` READ binding, so
// their reads run as the space's OWNER (the user whose space it is), and
// the service identity itself reads a space's ACL only. It is NOT an
// OWNER-class memory service principal: the operator's
// `MEMORY_SERVICE_DIDS` list is used verbatim on both arms, and the
// Phase-7 implicit-OWNER blanket is retired (the serving identity never
// writes into users' home spaces; served writes ride the wave's §2b
// delegated carriage under the acting user). OFF the flag the delegating
// list is empty — byte-identical ACL decisions.
const serverExecutionOn = serverExecutionEnabledFromEnv(Deno.env.get);
const memoryAclPrincipals = memoryAclPrincipalsFor({
  configured: env.MEMORY_SERVICE_DIDS
    .split(",")
    .map((did) => did.trim())
    .filter((did) => did.length > 0),
  processIdentityDid: identity.did(),
  serverExecution: serverExecutionOn,
});
if (serverExecutionOn) {
  console.log(
    `Memory: server-execution v2 ON — process identity ${identity.did()} ` +
      "is a DELEGATING memory principal (ACL-only service reads; every " +
      "other served read runs under the acting user via the " +
      "actingAs binding; docs/specs/server-side-execution/protocol.md §2b)",
  );
  if (memoryAclPrincipals.serviceDids.includes(identity.did())) {
    console.log(
      "Memory: NOTE — the operator's MEMORY_SERVICE_DIDS also lists the " +
        "process identity, which keeps OWNER-class service semantics by " +
        "explicit configuration (OW31 scope report flag F1); the " +
        "delegating listing is then moot",
    );
  }
}

// Session.open verification is shared with the standalone server. Toolshed
// requires the signed invocation to carry its audience DID and the challenge
// issued to this WebSocket connection.
const authorizeSessionOpen = (
  message: Parameters<typeof verifySessionOpenAuthorization>[0],
  context: Parameters<typeof verifySessionOpenAuthorization>[1],
): Promise<string> => verifySessionOpenAuthorization(message, context);

// Under `sharedMemoryConnection` a key authenticates once for a whole
// connection, which may then carry the sessions of several spaces. Without
// the flag the server verifies no `connection.auth` and does not advertise
// the capability, so its clients sign each `session.open`.
const sharedMemoryConnection =
  experimentalOptionsFromEnv(Deno.env.get).sharedMemoryConnection === true;

// The store URL is derived in memory-store-url.ts (DB_PATH single-file mode or
// MEMORY_DIR directory mode). Log which mode is active for this server.
if (env.DB_PATH) {
  console.log(`Memory: Using single database file: ${env.DB_PATH}`);
} else {
  console.log(`Memory: Using directory mode: ${env.MEMORY_DIR}`);
}

export { memoryEngineStoreUrl };
await FS.ensureDir(memoryEngineStoreUrl);

export const memoryServer = new MemoryServer.Server({
  store: memoryEngineStoreUrl,
  authorizeSessionOpen,
  ...(sharedMemoryConnection || routerPolicy !== undefined
    ? { authorizeConnection: verifyConnectionAuthorization }
    : {}),
  sessionOpenAuth: {
    audience: memoryAudience,
  },
  acl: {
    mode: env.MEMORY_ACL_MODE,
    serviceDids: memoryAclPrincipals.serviceDids,
    delegatingDids: memoryAclPrincipals.delegatingDids,
  },
  ...(routerPolicy !== undefined
    ? {
      ownsSpace: (space: string) => routerPolicy.owns(space),
      requireExplicitAcl: true,
    }
    : {}),
  documentCacheBudgetBytes: env.MEMORY_DOCUMENT_CACHE_BUDGET_BYTES,
  documentCacheMaxEntries: env.MEMORY_DOCUMENT_CACHE_MAX_ENTRIES,
  documentCacheTotalBudgetBytes: env.MEMORY_DOCUMENT_CACHE_TOTAL_BUDGET_BYTES,
});
const routedListener = await routerPolicy?.start(memoryServer);
export const memory = {
  async close(): Promise<
    { ok: Record<PropertyKey, never> } | { error: unknown }
  > {
    try {
      await routedListener?.close();
    } catch (error) {
      try {
        await memoryServer.close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Memory cleanup failed");
      }
      throw error;
    }
    await memoryServer.close();
    return { ok: {} };
  },
};
console.log("Memory: Provider initialized successfully");
