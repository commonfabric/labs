import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  inServingContext,
  runInServingContext,
  servingContextLoopback,
} from "../../src/executor/serving-context.ts";
import { newLoopbackServer } from "../../src/storage/v2-emulate.ts";

/**
 * Connects a client to a fresh loopback server through
 * `servingContextLoopback(server, serving)`, sending the handshake from the
 * serving context when `sendFromServing` is `true`, and returns whether each
 * server frame the client took was taken in the serving context.
 */
async function frameContexts(
  serving: boolean,
  sendFromServing: boolean,
): Promise<boolean[]> {
  const server = newLoopbackServer();
  const seen: boolean[] = [];
  const transport = servingContextLoopback(server, serving);
  const recording: MemoryClient.Transport = {
    ...transport,
    setReceiver: (next) =>
      transport.setReceiver((payload) => {
        seen.push(inServingContext());
        next(payload);
      }),
  };
  try {
    const client = await runInServingContext(
      sendFromServing,
      () => MemoryClient.connect({ transport: recording }),
    );
    await client.close();
  } finally {
    await server.close();
  }
  return seen;
}

describe("serving-context", () => {
  describe("inServingContext()", () => {
    it("returns `false` outside any serving run", () => {
      expect(inServingContext()).toBe(false);
    });

    it("returns what the innermost run set, across its awaits and timers", async () => {
      const seen = await runInServingContext(true, async () => {
        const before = inServingContext();
        await Promise.resolve();
        const afterAwait = inServingContext();
        const inTimer = await new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(inServingContext()), 0)
        );
        const nested = runInServingContext(false, () => inServingContext());
        return [before, afterAwait, inTimer, nested];
      });
      expect(seen).toStrictEqual([true, true, true, false]);
    });
  });

  describe("servingContextLoopback()", () => {
    it("takes each server frame in the serving context when asked to, whatever sent the request", async () => {
      const seen = await frameContexts(true, false);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((serving) => serving)).toBe(true);
    });

    it("takes each server frame outside the serving context when asked to, whatever sent the request", async () => {
      const seen = await frameContexts(false, true);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((serving) => !serving)).toBe(true);
    });
  });
});
