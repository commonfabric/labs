/**
 * A request whose send the transport refuses outright (not a lost
 * connection) gets no response, so the client must drop its pending entry
 * when the send rejects rather than keep it until the connection closes.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { decodeMemoryBoundary } from "../v2.ts";
import { connect, loopback, type Transport } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

describe("client refused sends", () => {
  it("drops the pending entry of a request whose send the transport refused", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://client-refused-send"),
    });
    const inner = loopback(server);
    let refuse = false;
    const transport: Transport = {
      ...inner,
      send(payload) {
        const message = decodeMemoryBoundary(payload);
        if (refuse && (message as { type?: string }).type === "test.refused") {
          // The connection is open; this payload alone is refused.
          return Promise.reject(new Error("Router socket output limit"));
        }
        return inner.send(payload);
      },
    };
    const client = await connect({ transport });
    try {
      refuse = true;
      await expect(client.request({
        type: "test.refused",
        requestId: "refused-1",
      })).rejects.toThrow("Router socket output limit");
      expect(client.pendingRequestCount).toBe(0);
      expect(client.isConnected()).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
