import type { Identity } from "@commonfabric/identity";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "../../src/storage/cache.deno.ts";

/** The storage a test of a compiled piece runs on. */
export type TestStorage = ReturnType<typeof StorageManager.emulate>;

/**
 * Whether the tests of a compiled piece run on a memory server reached over
 * a websocket of this process (`COMPILED_PIECE_STORAGE=socket`), in place of
 * the emulated storage, whose server shares the thread and the turn of its
 * client.
 */
export const overSocket = (): boolean =>
  Deno.env.get("COMPILED_PIECE_STORAGE") === "socket";

/**
 * Opens the storage of one test as `signer`. Over a socket, each call starts
 * a memory server of its own on an ephemeral localhost port, which the
 * returned manager closes behind itself.
 */
export const openStorage = (signer: Identity): TestStorage => {
  if (!overSocket()) return StorageManager.emulate({ as: signer });
  const server = StandaloneMemoryServer.start();
  const storageManager = StorageManager.open({
    as: signer,
    memoryHost: server.url,
  }) as TestStorage;
  const close = storageManager.close.bind(storageManager);
  storageManager.close = async () => {
    await close();
    await server.close();
  };
  return storageManager;
};

/** A memory server that several sessions of one test share. */
export type SharedStorage = {
  /** Opens a session of the server as `signer`. */
  open(signer: Identity): TestStorage;
  /** Closes the server, behind the sessions opened on it. */
  close(): Promise<void>;
};

/**
 * Starts a memory server for the sessions of one test: over a socket, one
 * that listens on an ephemeral localhost port, and otherwise one in this
 * thread that tells its sessions of a commit on the next turn.
 */
export const shareStorage = (): SharedStorage => {
  if (overSocket()) {
    const server = StandaloneMemoryServer.start();
    return {
      open: (signer) =>
        StorageManager.open({
          as: signer,
          memoryHost: server.url,
        }) as TestStorage,
      close: () => server.close(),
    };
  }
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  return {
    open: (signer) =>
      EmulatedStorageManager.connectTo(server, { as: signer }) as TestStorage,
    close: () => server.close(),
  };
};
