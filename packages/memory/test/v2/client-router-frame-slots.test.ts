import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { getMemoryProtocolFlags } from "../../v2.ts";
import { connect, type Transport } from "../../v2/client.ts";

/** Constructs a peer that advertises one slot limit per handshake. */
async function peer(limits: unknown[], routed = true) {
  const identity = await Identity.fromRaw(new Uint8Array(32).fill(151));
  const selections: Parameters<
    NonNullable<Transport["setRoutedMessagesEnabled"]>
  >[] = [];
  let receiver = (_: string) => {};
  let hellos = 0;
  const transport: Transport = {
    setReceiver: (callback) => receiver = callback,
    setRoutedMessagesEnabled: (...args) => selections.push(args),
    reset: () => {},
    close: () => Promise.resolve(),
    send: () => {
      const routerFrameSlots = limits[hellos++];
      receiver(`fvj1:${
        JSON.stringify({
          type: "hello.ok",
          protocol: "memory",
          flags: {
            ...getMemoryProtocolFlags(),
            routedAuthV1: routed,
            connectionAuth: true,
          },
          sessionOpen: {
            audience: identity.did(),
            ...(routed ? { deployment: "sdk-unit" } : {}),
            challenge: {
              value: "11".repeat(32),
              expiresAt: Math.floor(Date.now() / 1000) + 60,
            },
          },
          ...(routerFrameSlots === undefined ? {} : { routerFrameSlots }),
        })
      }`);
      return Promise.resolve();
    },
  };
  return { transport, selections };
}

describe("client-router-frame-slots", () => {
  for (const limit of [undefined, null, 1, 9876, Number.MAX_SAFE_INTEGER]) {
    it(`forwards the routed slot limit ${String(limit)} without collapsing absence and null`, async () => {
      const p = await peer([limit]);
      const client = await connect({ transport: p.transport });
      try {
        expect(p.selections).toEqual([
          [false],
          [true, undefined, undefined, limit],
        ]);
      } finally {
        await client.close();
      }
    });
  }

  for (
    const limit of [false, true, 0, -1, 1.5, 2 ** 53, "150000", {}, []]
  ) {
    it(`rejects the invalid advertised slot limit ${JSON.stringify(limit)}`, async () => {
      const p = await peer([limit]);
      await expect(connect({ transport: p.transport })).rejects.toThrow(
        "memory handshake expected hello.ok",
      );
      expect(p.selections).toEqual([[false]]);
    });
  }

  it("omits the advertised slot limit for a direct deployment", async () => {
    const p = await peer([null], false);
    const client = await connect({ transport: p.transport });
    try {
      expect(p.selections).toEqual([
        [false],
        [false, undefined, undefined, undefined],
      ]);
    } finally {
      await client.close();
    }
  });

  it("replaces a null slot limit with an old server's omitted limit after reconnect", async () => {
    const p = await peer([null, undefined, 97]);
    const client = await connect({ transport: p.transport });
    try {
      client.restartConnection(new Error("replace null-limit connection"));
      await client.restoreConnection();
      client.restartConnection(new Error("replace old-server connection"));
      await client.restoreConnection();
      expect(p.selections).toEqual([
        [false],
        [true, undefined, undefined, null],
        [false],
        [true, undefined, undefined, undefined],
        [false],
        [true, undefined, undefined, 97],
      ]);
    } finally {
      await client.close();
    }
  });
});
