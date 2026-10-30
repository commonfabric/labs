/**
 * A space whose memory connection fails before its first handshake completes:
 * dialed again within the attempts the factory allows, and failed with an
 * error naming the address, the attempts and the last failure once they are
 * spent. A refusal here is real: the dial goes to a host that answers the
 * websocket handshake with a 403, so the native socket closes before it opens.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { isFirstHandshakeFailure } from "@commonfabric/memory/v2/client";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

import { createNativeMemorySocket } from "../src/storage/memory-socket.ts";
import {
  createStorageAddressResolver,
  MEMORY_FIRST_HANDSHAKE_ATTEMPTS,
  RemoteSessionFactory,
} from "../src/storage/v2-remote-session.ts";
import { type SessionFactory, StorageManager } from "../src/storage/v2.ts";

const user = await Identity.fromPassphrase("first-handshake user");
const SPACE = "did:key:z6Mk-first-handshake-space" as MemorySpace;

/** A manager over `factory`, whose constructor is otherwise protected. */
class TestStorageManager extends StorageManager {
  constructor(factory: SessionFactory) {
    super({ as: user, memoryHost: new URL("memory://") }, factory);
  }
}

describe("storage-first-handshake", () => {
  let cleanups: (() => Promise<void>)[];

  /** A host that refuses every websocket handshake. */
  let refuser: Deno.HttpServer<Deno.NetAddr>;

  beforeEach(() => {
    cleanups = [];
    refuser = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      () => new Response(null, { status: 403 }),
    );
    cleanups.push(() => refuser.shutdown());
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  /**
   * A factory whose dials go to the refusing host until `refusals` have been
   * refused, and to `host` after that, with the address of each dial.
   */
  const refusingFactory = (
    host: URL,
    refusals: number,
    shared: boolean,
  ): { factory: RemoteSessionFactory; dialed: URL[] } => {
    const dialed: URL[] = [];
    const factory = new RemoteSessionFactory(
      createStorageAddressResolver(host),
      user,
      (address) => {
        dialed.push(address);
        if (dialed.length > refusals) return createNativeMemorySocket(address);
        const refused = new URL(address);
        refused.port = String(refuser.addr.port);
        return createNativeMemorySocket(refused);
      },
    );
    factory.setSharedConnections(shared);
    cleanups.push(() => factory.close());
    return { factory, dialed };
  };

  describe("RemoteSessionFactory", () => {
    for (const shared of [false, true]) {
      describe(`with shared connections=${shared}`, () => {
        it("mounts a space whose dials are refused fewer times than it may dial, on the dial after the last refusal", async () => {
          const server = StandaloneMemoryServer.start({ connectionAuth: true });
          cleanups.push(() => server.close());
          const refusals = MEMORY_FIRST_HANDSHAKE_ATTEMPTS - 1;
          const { factory, dialed } = refusingFactory(
            server.url,
            refusals,
            shared,
          );
          const opened = await factory.create(SPACE);
          try {
            expect(dialed).toHaveLength(refusals + 1);
            expect(
              server.server.accessForTestingOnly.sessionsForSpace(SPACE)
                .map((session) => session.principal),
            ).toEqual([user.did()]);
          } finally {
            await opened.client.close();
          }
        });

        it("rejects a create once every dial it may make is refused, naming the address, the attempts and the last failure", async () => {
          const host = new URL(`http://127.0.0.1:${refuser.addr.port}`);
          const { factory, dialed } = refusingFactory(
            host,
            Infinity,
            shared,
          );
          const error = await factory.create(SPACE).then(
            () => undefined,
            (error: Error) => error,
          );
          expect(dialed).toHaveLength(MEMORY_FIRST_HANDSHAKE_ATTEMPTS);
          expect(isFirstHandshakeFailure(error)).toBe(true);
          expect(error?.message).toContain(dialed[0].href);
          expect(error?.message).toContain(
            `failed its first handshake ${MEMORY_FIRST_HANDSHAKE_ATTEMPTS} times`,
          );
          expect(error?.cause).toMatchObject({ name: "ConnectionError" });
        });
      });
    }
  });

  describe("StorageManager", () => {
    it("fails a load of a space whose every dial is refused, and reports the failure as the space's session error", async () => {
      const host = new URL(`http://127.0.0.1:${refuser.addr.port}`);
      const { factory, dialed } = refusingFactory(host, Infinity, false);
      const manager = new TestStorageManager(factory);
      cleanups.push(() => manager.close());
      // A load's result carries the error as a plain record, by its message.
      const failure = {
        name: "ConnectionError",
        message: expect.stringContaining(
          `failed its first handshake ${MEMORY_FIRST_HANDSHAKE_ATTEMPTS} times`,
        ),
      };
      const load = await manager.open(SPACE).sync(`of:${SPACE}`);
      expect(load.error).toMatchObject(failure);
      expect(isFirstHandshakeFailure(manager.spaceSessionError(SPACE)))
        .toBe(true);

      // A later load fails the same way, without dialing again.
      const again = await manager.open(SPACE).sync(`of:${SPACE}`);
      expect(again.error).toMatchObject(failure);
      expect(dialed).toHaveLength(MEMORY_FIRST_HANDSHAKE_ATTEMPTS);
    });
  });
});
