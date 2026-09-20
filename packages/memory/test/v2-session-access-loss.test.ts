import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

describe("memory session access loss", () => {
  it("notifies current and late observers once for an unauthorized revocation", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://session-access-loss"),
    });
    const client = await connect({ transport: loopback(server) });
    try {
      const session = await client.mount(
        "did:key:z6Mk-access-loss",
        {},
        testSessionOpenAuthFactory,
      );
      const observed: Error[] = [];
      const cancelled: Error[] = [];
      session.subscribeAccessLoss((error) => observed.push(error));
      session.subscribeAccessLoss((error) => cancelled.push(error))();
      session.handleRevoked("unauthorized");
      session.handleRevoked("unauthorized");
      expect(observed).toHaveLength(1);
      expect(observed[0].name).toBe("AuthorizationError");
      expect(session.closeError).toBe(observed[0]);
      expect(cancelled).toEqual([]);
      const late: Error[] = [];
      session.subscribeAccessLoss((error) => late.push(error));
      expect(late).toEqual(observed);
      await expect(session.queryGraph({ roots: [] })).rejects.toBe(observed[0]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not label takeover, connection failure, or normal close as access loss", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://session-non-access-closure"),
    });
    const client = await connect({ transport: loopback(server) });
    try {
      for (const reason of ["takeover", "connection", "challenge", "normal"]) {
        const session = await client.mount(
          `did:key:z6Mk-${reason}`,
          {},
          testSessionOpenAuthFactory,
        );
        const observed: Error[] = [];
        session.subscribeAccessLoss((error) => observed.push(error));
        if (reason === "takeover") session.handleRevoked("taken-over");
        else if (reason === "connection") {
          session.handleConnectionFailure(new Error("connection failed"));
        } else if (reason === "challenge") {
          session.handleConnectionFailure(
            Object.assign(new Error("expired challenge"), {
              name: "AuthorizationError",
              retriable: true,
            }),
          );
        } else await session.close();
        session.subscribeAccessLoss((error) => observed.push(error));
        expect(observed).toEqual([]);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports a permanent authorization failure during session restoration", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://session-reopen-access-loss"),
    });
    const client = await connect({ transport: loopback(server) });
    try {
      const session = await client.mount(
        "did:key:z6Mk-reopen-access-loss",
        {},
        testSessionOpenAuthFactory,
      );
      const error = Object.assign(new Error("access denied"), {
        name: "AuthorizationError",
      });
      const observed: Error[] = [];
      session.subscribeAccessLoss((cause) => observed.push(cause));
      session.handleConnectionFailure(error);
      expect(observed).toEqual([error]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
