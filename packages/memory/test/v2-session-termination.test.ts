import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { connect, loopback } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

describe("memory session termination", () => {
  it("isolates throwing current and late observers from revocation delivery", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://throwing-session-access-observer"),
    });
    const client = await connect({ transport: loopback(server) });
    const reported = stub(console, "error");
    const failure = new Error("observer failure");
    try {
      const session = await client.mount(
        "did:key:z6Mk-throwing-access-observer",
        {},
        testSessionOpenAuthFactory,
      );
      session.subscribeTermination(() => {
        throw failure;
      });
      const observed: Error[] = [];
      session.subscribeTermination((error) => observed.push(error));
      expect(() => session.handleRevoked("unauthorized")).not.toThrow();
      expect(observed).toEqual([session.closeError]);
      expect(observed[0].name).toBe("AuthorizationError");
      expect(() =>
        session.subscribeTermination(() => {
          throw failure;
        })
      )
        .not.toThrow();
      const late: Error[] = [];
      session.subscribeTermination((error) => late.push(error));
      expect(late).toEqual(observed);
      // The client also logs the session's end through `console.error`.
      expect(
        reported.calls.map((call) => call.args).filter((args) =>
          args[0] === "session-termination subscriber threw:"
        ),
      ).toEqual([
        ["session-termination subscriber threw:", failure],
        ["session-termination subscriber threw:", failure],
      ]);
    } finally {
      reported.restore();
      await client.close();
      await server.close();
    }
  });

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
      session.subscribeTermination((error) => observed.push(error));
      session.subscribeTermination((error) => cancelled.push(error))();
      session.handleRevoked("unauthorized");
      session.handleRevoked("unauthorized");
      expect(observed).toHaveLength(1);
      expect(observed[0].name).toBe("AuthorizationError");
      expect(session.closeError).toBe(observed[0]);
      expect(cancelled).toEqual([]);
      const late: Error[] = [];
      session.subscribeTermination((error) => late.push(error));
      expect(late).toEqual(observed);
      await expect(session.queryGraph({ roots: [] })).rejects.toBe(observed[0]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("notifies current and late observers of takeover and connection failure", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://session-termination-causes"),
    });
    const client = await connect({ transport: loopback(server) });
    try {
      for (const reason of ["takeover", "connection", "challenge"]) {
        const session = await client.mount(
          `did:key:z6Mk-${reason}`,
          {},
          testSessionOpenAuthFactory,
        );
        const observed: Error[] = [];
        session.subscribeTermination((error) => observed.push(error));
        if (reason === "takeover") session.handleRevoked("taken-over");
        else if (reason === "connection") {
          session.handleConnectionFailure(new Error("connection failed"));
        } else {
          session.handleConnectionFailure(
            Object.assign(new Error("expired challenge"), {
              name: "AuthorizationError",
              retriable: true,
            }),
          );
        }
        session.subscribeTermination((error) => observed.push(error));
        expect(observed).toHaveLength(2);
        expect(observed[0]).toBe(session.closeError);
        expect(observed[1]).toBe(session.closeError);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not report normal close as termination", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://session-normal-close"),
    });
    const client = await connect({ transport: loopback(server) });
    try {
      const session = await client.mount(
        "did:key:z6Mk-normal-close",
        {},
        testSessionOpenAuthFactory,
      );
      const observed: Error[] = [];
      session.subscribeTermination((error) => observed.push(error));
      await session.close();
      session.subscribeTermination((error) => observed.push(error));
      expect(session.closeError?.message).toBe("memory session closed");
      expect(observed).toEqual([]);
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
      session.subscribeTermination((cause) => observed.push(cause));
      session.handleConnectionFailure(error);
      expect(observed).toEqual([error]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
