import { setModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import * as FS from "@std/fs";

import { normalizeInviteHost } from "@commonfabric/memory/space-invites";
import { verifyConnectionAuthorization } from "@commonfabric/memory/v2/connection-auth";
import * as MemoryServer from "@commonfabric/memory/v2/server";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import type { EnvReader } from "@commonfabric/runner";
import { experimentalOptionsWithFollowedPosture } from "@commonfabric/runner/experimental-posture";

import { MemoryRouterPolicy } from "./memory-router.ts";
import { memoryEngineStoreUrl } from "./memory-store-url.ts";
import env from "@/env.ts";
import { buildInfo } from "@/lib/build-info.ts";
import { experimentalPosture } from "@/lib/experimental-posture.ts";
import { identity } from "@/lib/identity.ts";
import {
  memoryAclPrincipalsFor,
  serverExecutionEnabledFromEnv,
} from "@/lib/server-execution-flag.ts";

/** The environment settings the memory server is configured from. */
export type MemoryEnvironment = Pick<
  typeof env,
  | "MEMORY_ROUTER_CONFIG_FILE"
  | "MEMORY_ACL_MODE"
  | "DB_PATH"
  | "MEMORY_DIR"
  | "MEMORY_SERVICE_DIDS"
  | "MEMORY_MINIMUM_CLIENT_GENERATION"
  | "API_URL"
  | "MEMORY_SYNC_CID_REFERENCES"
  | "MEMORY_ACL_DELEGATIONS"
  | "MEMORY_DOCUMENT_CACHE_BUDGET_BYTES"
  | "MEMORY_DOCUMENT_CACHE_MAX_ENTRIES"
  | "MEMORY_DOCUMENT_CACHE_TOTAL_BUDGET_BYTES"
>;

/** A memory server and the handle that closes it with its private listener. */
export interface OpenedMemory {
  server: MemoryServer.Server;
  memory: { close(): Promise<void> };
}

/**
 * Closes `routedListener`, when there is one, and then `server`. A server is
 * closed even when its listener fails to close, and the listener's failure is
 * thrown, aggregated with the server's when that fails too.
 */
export async function closeMemory(
  server: { close(): Promise<void> },
  routedListener: { close(): Promise<void> } | undefined,
): Promise<void> {
  try {
    await routedListener?.close();
  } catch (error) {
    try {
      await server.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Memory cleanup failed");
    }
    throw error;
  }
  await server.close();
}

/**
 * Builds this process's memory server over the store at `store`, configured
 * from `environment`, as this process's `identity`, with the experimental
 * flags `getEnv` reads, and starts its private Mode A listener when
 * `MEMORY_ROUTER_CONFIG_FILE` names one.
 *
 * @throws If Mode A is configured without directory storage and enforced
 * explicit ACLs.
 */
export async function openMemory(
  environment: MemoryEnvironment,
  getEnv: EnvReader,
  store: URL,
): Promise<OpenedMemory> {
  const memoryAudience = identity.did();
  const routerPolicy = environment.MEMORY_ROUTER_CONFIG_FILE === ""
    ? undefined
    : new MemoryRouterPolicy(environment.MEMORY_ROUTER_CONFIG_FILE);
  if (
    routerPolicy !== undefined &&
    (environment.MEMORY_ACL_MODE !== "enforce" || environment.DB_PATH)
  ) {
    throw new Error(
      "Mode A requires directory storage and enforced explicit ACLs",
    );
  }

  if (routerPolicy !== undefined) {
    // Mode A runs at the cell representation the deployment configures, which
    // its clients must share: a hello at the other one fails the handshake.
    // Runtime startup later reads the same flag; initialize the Memory
    // encoder before the private listener advertises its capabilities.
    setModernCellRepConfig(
      experimentalOptionsWithFollowedPosture(getEnv).modernCellRep === true,
    );
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
  const serverExecutionOn = serverExecutionEnabledFromEnv(getEnv);
  const memoryAclPrincipals = memoryAclPrincipalsFor({
    configured: environment.MEMORY_SERVICE_DIDS
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
  // requires the signed invocation to carry its audience DID and the
  // challenge issued to this WebSocket connection.
  const authorizeSessionOpen = (
    message: Parameters<typeof verifySessionOpenAuthorization>[0],
    context: Parameters<typeof verifySessionOpenAuthorization>[1],
  ): Promise<string> => verifySessionOpenAuthorization(message, context);

  // Under `sharedMemoryConnection` a key authenticates once for a whole
  // connection, which may then carry the sessions of several spaces. Without
  // the flag the server verifies no `connection.auth` and does not advertise
  // the capability, so its clients sign each `session.open`.
  const sharedMemoryConnection =
    experimentalOptionsWithFollowedPosture(getEnv).sharedMemoryConnection ===
      true;

  // The store URL is derived in memory-store-url.ts (DB_PATH single-file mode
  // or MEMORY_DIR directory mode). Log which mode is active for this server.
  if (environment.DB_PATH) {
    console.log(`Memory: Using single database file: ${environment.DB_PATH}`);
  } else {
    console.log(`Memory: Using directory mode: ${environment.MEMORY_DIR}`);
  }

  await FS.ensureDir(store);

  const server = new MemoryServer.Server({
    serverBuild: buildInfo.commitSha ?? undefined,
    minimumClientGeneration: environment.MEMORY_MINIMUM_CLIENT_GENERATION,
    store,
    authorizeSessionOpen,
    ...(sharedMemoryConnection || routerPolicy !== undefined
      ? { authorizeConnection: verifyConnectionAuthorization }
      : {}),
    // Invitations issued here name this deployment's public origin, so the
    // HTTP routes and `space.invite` requests check codes against the same
    // host.
    inviteHost: normalizeInviteHost(environment.API_URL),
    // Offered unless the deployment turns it off; a client takes it only when
    // it opts in.
    syncCidReferences: environment.MEMORY_SYNC_CID_REFERENCES,
    // The posture this process publishes on `/api/meta`, read when an open
    // asks rather than now: it is published once the Runtime exists, after
    // this server is constructed, and until then it names no instances.
    namesInstances: () => experimentalPosture()?.instanceNames === true,
    sessionOpenAuth: {
      audience: memoryAudience,
    },
    acl: {
      mode: environment.MEMORY_ACL_MODE,
      serviceDids: memoryAclPrincipals.serviceDids,
      delegatingDids: memoryAclPrincipals.delegatingDids,
      delegations: environment.MEMORY_ACL_DELEGATIONS,
    },
    ...(routerPolicy !== undefined
      ? {
        ownsSpace: (space: string) => routerPolicy.owns(space),
        createsSpace: (space: string) => routerPolicy.creates(space),
        requireExplicitAcl: true,
      }
      : {}),
    documentCacheBudgetBytes: environment.MEMORY_DOCUMENT_CACHE_BUDGET_BYTES,
    documentCacheMaxEntries: environment.MEMORY_DOCUMENT_CACHE_MAX_ENTRIES,
    documentCacheTotalBudgetBytes:
      environment.MEMORY_DOCUMENT_CACHE_TOTAL_BUDGET_BYTES,
  });
  const routedListener = await routerPolicy?.start(server).catch(
    async (error) => {
      await server.close();
      throw error;
    },
  );
  return {
    server,
    memory: { close: () => closeMemory(server, routedListener) },
  };
}

export { memoryEngineStoreUrl };

export const { server: memoryServer, memory } = await openMemory(
  env,
  Deno.env.get,
  memoryEngineStoreUrl,
);
console.log("Memory: Provider initialized successfully");
