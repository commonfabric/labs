/**
 * The toolshed's indexed-collection host while server execution is off: the
 * one runtime of this process that keeps the indexed collections of every
 * space current, since no serving loop runs and the clients maintain none
 * (docs/features/indexed-collections.md, "Which runtime maintains"). Under
 * server execution each space's serving runtime maintains its collections,
 * and nothing here runs.
 */

import type { Identity } from "@commonfabric/identity";
import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import type { EnvReader } from "@commonfabric/runner";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import { IndexedCollectionHost } from "@commonfabric/runner/indexed-collection-host";
import type { env as ToolshedEnv } from "@/env.ts";
import { toolshedClientBuild } from "@/lib/build-info.ts";
import { serverExecutionEnabledFromEnv } from "@/lib/server-execution-flag.ts";
import { toolshedRuntimeOptions } from "@/runtime-options.ts";

let host: IndexedCollectionHost | undefined;

/**
 * Starts the host when server execution is off, and returns it; returns
 * `undefined` under server execution. Its runtime connects to `server` over
 * loopback sessions signed by `identity`, which the memory server lists as a
 * service principal while server execution is off. Called once from toolshed
 * startup, after the memory server exists.
 */
export function startIndexedCollectionHost(options: {
  server: MemoryServer;
  identity: Identity;
  config: Pick<ToolshedEnv, "MEMORY_URL" | "API_URL" | "API_INTERNAL_URL">;
  envGet?: EnvReader;
}): IndexedCollectionHost | undefined {
  const envGet = options.envGet ?? Deno.env.get;
  if (serverExecutionEnabledFromEnv(envGet)) return undefined;
  host = new IndexedCollectionHost({
    server: options.server,
    runtimeOptions: () =>
      toolshedRuntimeOptions(
        options.config,
        LoopbackStorageManager.connect(options.server, {
          as: options.identity,
          clientBuild: toolshedClientBuild(),
        }),
        envGet,
      ),
  });
  console.log(
    "Indexed collections: maintained by this process " +
      `(service ${options.identity.did()}), with server execution off`,
  );
  return host;
}

/** Stops the host, if one runs, and disposes its runtime. */
export async function stopIndexedCollectionHost(): Promise<void> {
  const running = host;
  host = undefined;
  await running?.close();
}
