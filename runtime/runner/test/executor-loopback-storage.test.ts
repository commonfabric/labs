import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import type * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { hostTransport } from "../../memory/test/support/host-transport.ts";
import {
  delegatingTransport,
  LoopbackStorageManager,
} from "../src/executor/loopback-storage.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

/**
 * Every member of the transport type. A member the type gains and this list
 * leaves out fails the type check below, which is what holds the delegation
 * to the type.
 */
const MEMBERS = [
  "supportsMessageCompression",
  "supportsRouterStreaming",
  "messageLimits",
  "send",
  "close",
  "reset",
  "setReceiver",
  "setCloseReceiver",
  "setMessageCompressionEnabled",
  "setRoutedMessagesEnabled",
  "delivered",
] as const satisfies readonly (keyof MemoryClient.Transport)[];

type Unlisted = Exclude<keyof MemoryClient.Transport, typeof MEMBERS[number]>;
const everyMemberListed: [Unlisted] extends [never] ? true : Unlisted = true;

/**
 * A transport that is a class instance with every optional member, whose
 * methods record their calls and read their own private state, so a call
 * that reaches a method with the wrong `this` throws.
 */
class RecordingTransport implements MemoryClient.Transport {
  readonly supportsMessageCompression = true;
  readonly supportsRouterStreaming = true;
  readonly messageLimits: MemoryClient.Transport["messageLimits"] = {
    bytes: 7,
    values: null,
  };
  readonly #calls: string[] = [];
  #receiver: ((payload: string) => void) | undefined;

  get calls(): readonly string[] {
    return this.#calls;
  }

  send(payload: string): Promise<void> {
    this.#calls.push(`send ${payload}`);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#calls.push("close");
    return Promise.resolve();
  }

  reset(): void {
    this.#calls.push("reset");
  }

  setReceiver(receiver: (payload: string) => void): void {
    this.#calls.push("setReceiver");
    this.#receiver = receiver;
  }

  setCloseReceiver(_receiver: (error?: Error) => void): void {
    this.#calls.push("setCloseReceiver");
  }

  setMessageCompressionEnabled(enabled: boolean): void {
    this.#calls.push(`setMessageCompressionEnabled ${enabled}`);
  }

  setRoutedMessagesEnabled(
    enabled: boolean,
    transportVersion?: number,
    uploadWindow?: number,
    frameSlots?: number | null,
    compressedBodies?: boolean,
  ): void {
    this.#calls.push(
      `setRoutedMessagesEnabled ${
        [enabled, transportVersion, uploadWindow, frameSlots, compressedBodies]
          .join(",")
      }`,
    );
  }

  delivered(): Promise<void> {
    this.#calls.push("delivered");
    return Promise.resolve();
  }

  /** Hands `payload` to the receiver the wrapper installed. */
  receive(payload: string): void {
    this.#receiver?.(payload);
  }
}

describe("loopback-storage", () => {
  describe("delegatingTransport()", () => {
    it("exposes every member of a class-instance transport and forwards each call to it", async () => {
      expect(everyMemberListed).toBe(true);
      const inner = new RecordingTransport();
      const seen: string[] = [];
      const transport = delegatingTransport(
        inner,
        (next) => (payload) => next(`wrapped ${payload}`),
      );

      for (const member of MEMBERS) {
        expect(member in transport).toBe(true);
      }
      expect(transport.supportsMessageCompression).toBe(true);
      expect(transport.supportsRouterStreaming).toBe(true);
      expect(transport.messageLimits).toBe(inner.messageLimits);

      await transport.send("hello");
      transport.setReceiver((payload) => seen.push(payload));
      inner.receive("frame");
      transport.setCloseReceiver!(() => {});
      transport.setMessageCompressionEnabled!(true);
      transport.setRoutedMessagesEnabled!(true, 2, 3, null, false);
      await transport.delivered!();
      transport.reset!();
      await transport.close();

      expect(seen).toEqual(["wrapped frame"]);
      expect(inner.calls).toEqual([
        "send hello",
        "setReceiver",
        "setCloseReceiver",
        "setMessageCompressionEnabled true",
        "setRoutedMessagesEnabled true,2,3,,false",
        "delivered",
        "reset",
        "close",
      ]);
    });

    it("lacks the optional members the transport it wraps lacks", () => {
      const transport = delegatingTransport(
        {
          send: () => Promise.resolve(),
          close: () => Promise.resolve(),
          setReceiver: () => {},
        },
        (next) => next,
      );

      expect(Object.keys(transport).sort()).toEqual([
        "close",
        "send",
        "setReceiver",
      ]);
    });
  });

  describe("LoopbackStorageManager", () => {
    it("reads a routed space whose connection dropped while its session's open was being signed, once the connection is back", async () => {
      // A space the serving runtime does not hold is reached over the
      // network, as the routed plane reaches one. A mount whose connection
      // drops before the open is sent is made again, so the read that opened
      // the space is answered rather than failed.

      const server = new Server(TEST_MEMORY_SERVER_AUTH);
      const host = hostTransport(server);
      const identity = await Identity.fromPassphrase("loopback-routed-mount");
      const signing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let first = true;
      const signer: Signer = {
        did: () => identity.did(),
        verifier: identity.verifier,
        async sign(bytes) {
          if (first) {
            first = false;
            signing.resolve();
            await release.promise;
          }
          return await identity.sign(bytes);
        },
      };
      const storage = LoopbackStorageManager.connect(server, {
        as: signer,
        servingHomeSpace: "did:key:z6Mk-loopback-routed-mount-home",
        route: { createTransport: () => host.transport },
      });
      try {
        const reading = storage.open("did:key:z6Mk-loopback-routed-mount")
          .serverHeadSeq!();
        await signing.promise;
        host.drop();
        release.resolve();

        expect(await reading).toBe(0);
        expect(host.sentOfType("session.open")).toBe(1);
      } finally {
        release.resolve();
        await storage.closeNow();
        await server.close();
      }
    });

    for (const method of ["close", "closeNow"] as const) {
      it(`closes the connection to a routed space whose mount is waiting for an owner that stays down, on \`${method}()\``, async () => {
        // The connection drops while the mount's open is being signed, so
        // the mount is never sent and waits for the owner. Destroying the
        // storage ends that wait and closes the connection, rather than
        // leaving it dialing an owner nobody is waiting for any more.

        const server = new Server(TEST_MEMORY_SERVER_AUTH);
        const host = hostTransport(server);
        const identity = await Identity.fromPassphrase("loopback-routed-close");
        const signing = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let redialed = Promise.withResolvers<void>();
        let first = true;
        let closes = 0;
        const signer: Signer = {
          did: () => identity.did(),
          verifier: identity.verifier,
          async sign(bytes) {
            if (first) {
              first = false;
              signing.resolve();
              await release.promise;
            }
            return await identity.sign(bytes);
          },
        };
        const transport = {
          ...host.transport,
          async send(payload: string) {
            try {
              await host.transport.send(payload);
            } catch (error) {
              redialed.resolve();
              throw error;
            }
          },
          close() {
            closes++;
            return host.transport.close();
          },
        };
        const storage = LoopbackStorageManager.connect(server, {
          as: signer,
          servingHomeSpace: "did:key:z6Mk-loopback-routed-close-home",
          route: { createTransport: () => transport },
        });
        const reading = storage.open("did:key:z6Mk-loopback-routed-close")
          .serverHeadSeq!().then(() => "read", () => "failed");
        let closing: Promise<void> | undefined;
        try {
          await signing.promise;
          host.hostDown();
          release.resolve();
          // The mount has failed as never sent, and the client has tried
          // the owner again and found it down.
          await redialed.promise;
          if (method === "closeNow") {
            await storage.closeNow();

            expect(closes).toBeGreaterThan(0);
          } else {
            redialed = Promise.withResolvers<void>();
            closing = storage.close();
            const outcome = await Promise.race([
              closing.then(() => "closed"),
              redialed.promise.then(() => "dialed again"),
            ]);

            expect(outcome).toBe("closed");
          }
          expect(await reading).toBe("failed");
        } finally {
          // A close left waiting for the owner ends once the owner is back.
          release.resolve();
          host.hostUp();
          await reading;
          await closing;
          await storage.closeNow();
          await server.close();
        }
      });
    }
  });
});
