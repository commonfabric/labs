import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type * as MemoryClient from "@commonfabric/memory/v2/client";
import { delegatingTransport } from "../src/executor/loopback-storage.ts";

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
});
