import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { describe, it } from "@commonfabric/test-support/test";

import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MAX_UNTRUSTED_MESSAGE_SLOTS,
} from "../../v2.ts";
import { connect, type Transport } from "../../v2/client.ts";

/**
 * Constructs a direct peer whose `hello.ok` carries `messageSlots`, or none
 * when it is `undefined`.
 */
async function peer(messageSlots: unknown): Promise<Transport> {
  const identity = await Identity.fromRaw(new Uint8Array(32).fill(152));
  let receiver = (_: string) => {};
  return {
    setReceiver: (callback) => receiver = callback,
    reset: () => {},
    close: () => Promise.resolve(),
    send: () => {
      receiver(`fvj1:${
        JSON.stringify({
          type: "hello.ok",
          protocol: "memory",
          flags: { ...getMemoryProtocolFlags(), connectionAuth: true },
          sessionOpen: {
            audience: identity.did(),
            challenge: {
              value: "11".repeat(32),
              expiresAt: Math.floor(Date.now() / 1000) + 60,
            },
          },
          ...(messageSlots === undefined ? {} : { messageSlots }),
        })
      }`);
      return Promise.resolve();
    },
  };
}

/**
 * A request holding more than `values` values and no more than `values + 3`:
 * an array of that many numbers in a record. The client counts the values a
 * request writes out.
 */
const requestPast = (values: number): string =>
  encodeMemoryBoundary({ items: new Array(values).fill(0) });

describe("client-message-slots", () => {
  it("holds a request to the default slot limit when the server advertises none", async () => {
    const client = await connect({ transport: await peer(undefined) });
    try {
      expect(client.fitsOneRequest(requestPast(1000))).toBe(true);
      expect(client.fitsOneRequest(requestPast(MAX_UNTRUSTED_MESSAGE_SLOTS)))
        .toBe(false);
    } finally {
      await client.close();
    }
  });

  it("holds a request to the slot limit the server advertises", async () => {
    const limit = MAX_UNTRUSTED_MESSAGE_SLOTS * 2;
    const client = await connect({ transport: await peer(limit) });
    try {
      expect(client.fitsOneRequest(requestPast(MAX_UNTRUSTED_MESSAGE_SLOTS)))
        .toBe(true);
      expect(client.fitsOneRequest(requestPast(limit))).toBe(false);
    } finally {
      await client.close();
    }
  });

  for (
    const limit of [
      null,
      false,
      true,
      0,
      -1,
      1,
      MAX_UNTRUSTED_MESSAGE_SLOTS - 1,
      MAX_UNTRUSTED_MESSAGE_SLOTS + 0.5,
      2 ** 53,
      "2000000",
      {},
      [],
    ]
  ) {
    it(`rejects the invalid advertised slot limit ${JSON.stringify(limit)}`, async () => {
      await expect(connect({ transport: await peer(limit) })).rejects.toThrow(
        "memory handshake expected hello.ok",
      );
    });
  }
});
