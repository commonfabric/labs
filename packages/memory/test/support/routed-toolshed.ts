/** Disposable real toolshed protocol fixture for the Rust router exercise. */

import { Identity } from "@commonfabric/identity";
import { toFileUrl } from "@std/path";

import { setModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import type { MemorySpace } from "../../interface.ts";
import { verifyConnectionAuthorization } from "../../v2/connection-auth.ts";
import * as Engine from "../../v2/engine.ts";
import { RoutedEpochStore } from "../../v2/routed-epochs.ts";
import { RoutedMemoryHost } from "../../v2/routed-host.ts";
import { listenRoutedMemory } from "../../v2/routed-listener.ts";
import { verifySessionOpenAuthorization } from "../../v2/session-open-auth.ts";
import { Server } from "../../v2/server.ts";
import { resolveSpaceStoreUrl } from "../../v2/storage-path.ts";

/** Tracked fixture inputs; identities are throwaway local test keys. */
export interface RoutedToolshedFixture {
  port: number;
  seed: number;
  certificate: string;
  key: string;
  directory: string;
  store: string;
  router: string;
  space: string;
  principals: string[];
}

/** Seeds an existing ACL-backed space, then starts the actual private protocol. */
export async function startRoutedToolshed(config: RoutedToolshedFixture) {
  setModernCellRepConfig(true);
  const identity = await Identity.fromRaw(new Uint8Array(32).fill(config.seed));
  const store = toFileUrl(`${config.store}/`);
  Deno.mkdirSync(`${config.store}/engine-v3`, { recursive: true });
  const engine = await Engine.open({
    url: resolveSpaceStoreUrl(store, config.space as MemorySpace),
  });
  if (Engine.serverSeq(engine) === 0) {
    Engine.applyCommit(engine, {
      sessionId: "fixture-seed",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "set",
            id: `of:${config.space}`,
            value: {
              value: Object.fromEntries(
                config.principals.map((did) => [did, "OWNER"]),
              ),
            },
          },
          {
            op: "set",
            id: "of:fixture-data",
            value: {
              value: {
                message: "existing space",
                principalCount: config.principals.length,
              },
            },
          },
        ],
      },
    });
  }
  Engine.close(engine);
  const ownership = (space: string): number | undefined => {
    const directory = JSON.parse(Deno.readTextFileSync(config.directory));
    const entry = directory.spaces[space];
    return entry !== undefined &&
        directory.toolsheds[entry.toolshed].did === identity.did()
      ? entry.epoch
      : undefined;
  };
  const server = new Server({
    store,
    acl: { mode: "enforce" },
    requireExplicitAcl: true,
    ownsSpace: (space) => ownership(space) !== undefined,
    authorizeSessionOpen: verifySessionOpenAuthorization,
    authorizeConnection: verifyConnectionAuthorization,
    sessionOpenAuth: { audience: identity.did() },
    subscriptionRefreshDelayMs: "manual",
  });
  const epochs = new RoutedEpochStore(`${config.store}/router-epochs.jsonl`);
  const host = new RoutedMemoryHost({
    server,
    identity,
    deployment: "local-mode-a",
    epochs,
    ownership,
    routers: new Map([[config.router, new Set(["127.0.0.1"])]]),
  });
  const listener = await listenRoutedMemory({
    hostname: "127.0.0.1",
    port: config.port,
    certificate: Deno.readTextFileSync(config.certificate),
    key: Deno.readTextFileSync(config.key),
    host,
  });
  return {
    server,
    host,
    port: listener.port,
    close: async () => {
      await listener.close();
      await server.close();
      epochs.close();
    },
  };
}

if (import.meta.main) {
  const service = await startRoutedToolshed(
    JSON.parse(Deno.readTextFileSync(Deno.args[0])),
  );
  console.log(JSON.stringify({ ready: true, port: service.port }));
  const decoder = new TextDecoderStream();
  const lines = Deno.stdin.readable.pipeThrough(decoder);
  let held = "";
  for await (const chunk of lines) {
    held += chunk;
    let newline: number;
    while ((newline = held.indexOf("\n")) >= 0) {
      const command = JSON.parse(held.slice(0, newline));
      held = held.slice(newline + 1);
      if (command.revoke !== undefined) {
        service.host.revokeRouter(command.revoke);
      }
      if (command.fence === true) service.host.fenceOwnership();
      console.log(JSON.stringify({ acknowledged: true }));
    }
  }
  await service.close();
}
