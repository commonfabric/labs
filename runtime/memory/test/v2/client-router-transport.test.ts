import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { getMemoryProtocolFlags } from "../../v2.ts";
import { connect, type Transport } from "../../v2/client.ts";

/** Constructs a streaming-capable peer whose hello advertises one transport. */
async function peer(
  routerTransport: unknown,
  routerUploadWindow = 262_144,
  { compression = false, offered = false } = {},
) {
  const identity = await Identity.fromRaw(new Uint8Array(32).fill(152));
  const selections: Parameters<
    NonNullable<Transport["setRoutedMessagesEnabled"]>
  >[] = [];
  let receiver = (_: string) => {};
  const transport: Transport = {
    supportsRouterStreaming: true,
    supportsMessageCompression: compression,
    setReceiver: (callback) => receiver = callback,
    setRoutedMessagesEnabled: (...args) => selections.push(args),
    reset: () => {},
    close: () => Promise.resolve(),
    send: () => {
      receiver(`fvj1:${
        JSON.stringify({
          type: "hello.ok",
          protocol: "memory",
          flags: {
            ...getMemoryProtocolFlags(),
            routedAuthV1: true,
            connectionAuth: true,
            routedCompressionV1: offered,
          },
          sessionOpen: {
            audience: identity.did(),
            deployment: "sdk-unit",
            challenge: {
              value: "11".repeat(32),
              expiresAt: Math.floor(Date.now() / 1000) + 60,
            },
          },
          ...(routerTransport === undefined ? {} : { routerTransport }),
          routerUploadWindow,
        })
      }`);
      return Promise.resolve();
    },
  };
  return { transport, selections };
}

describe("client-router-transport", () => {
  it("selects streaming for private transport version 1", async () => {
    const p = await peer(1);
    const client = await connect({ transport: p.transport });
    try {
      expect(p.selections).toEqual([
        [false],
        [true, 1, 262_144, undefined, false],
      ]);
    } finally {
      await client.close();
    }
  });

  // End-to-end compression needs this client's compression and the router's
  // offer of `routedCompressionV1`; either alone selects text bodies.
  for (
    const [compression, offered, expected] of [
      [true, true, true],
      [true, false, false],
      [false, true, false],
    ] as const
  ) {
    it(`selects compressed bodies \`${expected}\` for compression \`${compression}\` and an offer \`${offered}\``, async () => {
      const p = await peer(1, 262_144, { compression, offered });
      const client = await connect({ transport: p.transport });
      try {
        expect(p.selections).toEqual([
          [false],
          [true, 1, 262_144, undefined, expected],
        ]);
      } finally {
        await client.close();
      }
    });
  }

  // A router may offer a version this build predates. That is no streaming
  // for this client, not a failed handshake: routed framing stays legacy.
  for (const routerTransport of [2, 0, "1", true, {}]) {
    it(
      `keeps legacy routed framing for routerTransport ${
        JSON.stringify(routerTransport)
      }`,
      async () => {
        const p = await peer(routerTransport);
        const client = await connect({ transport: p.transport });
        try {
          expect(client.isConnected()).toBe(true);
          expect(p.selections).toEqual([
            [false],
            [true, undefined, 262_144, undefined, false],
          ]);
        } finally {
          await client.close();
        }
      },
    );
  }
});
