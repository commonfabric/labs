import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { decodeMemoryBoundary, encodeMemoryBoundary } from "../v2.ts";
import {
  connect,
  isClientUpdateRequiredError,
  loopback,
  type Transport,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/**
 * Wraps a loopback transport to `server`, so that a test can hand the client
 * a server frame of its own and count the `session.open` requests sent.
 */
const injectingTransport = (server: Server) => {
  const transport = loopback(server);
  let receiver = (_payload: string) => {};
  let opens = 0;
  const wrapped: Transport = {
    ...transport,
    setReceiver(next) {
      receiver = next;
      transport.setReceiver(next);
    },
    send(payload) {
      const message = decodeMemoryBoundary(payload) as { type: string };
      if (message.type === "session.open") opens++;
      return transport.send(payload);
    },
  };
  return {
    transport: wrapped,
    inject: (message: Record<string, string>) =>
      receiver(encodeMemoryBoundary(message)),
    opens: () => opens,
  };
};

describe("memory session termination", () => {
  for (const name of ["AuthorizationError", "ClientUpdateRequiredError"]) {
    it(`terminates a marked ${name} without reconnecting again`, async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL(`memory://update-required-${name}`),
      });
      const client = await connect({ transport: loopback(server) });
      try {
        const session = await client.mount(
          "did:key:z6Mk-update-required",
          {},
          testSessionOpenAuthFactory,
        );
        const refusal = Object.assign(new Error("Update this runtime"), {
          name,
          clientUpdateRequired: true,
        });
        const reopen = stub(
          client,
          "openSession",
          () => Promise.reject(refusal),
        );
        try {
          await session.restore();
          await session.restore();
          expect(session.closeError).toBe(refusal);
          expect(reopen.calls).toHaveLength(1);
        } finally {
          reopen.restore();
        }
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  it("preserves the server's reason when a restored session is revoked", async () => {
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://session-refusal-reason"),
    });
    const client = await connect({ transport: loopback(server) });
    try {
      const session = await client.mount(
        "did:key:z6Mk-refusal-reason",
        {},
        testSessionOpenAuthFactory,
      );
      const refusal = Object.assign(
        new Error("The session resume authority has ended"),
        { name: "SessionRevokedError" },
      );
      const reopen = stub(client, "openSession", () => Promise.reject(refusal));
      try {
        await session.restore();
        expect(session.closeError).toBe(refusal);
      } finally {
        reopen.restore();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

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

  describe("a revocation's reason", () => {
    it("ends the session with an update-required refusal naming the space", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://instance-names-revocation"),
      });
      const injecting = injectingTransport(server);
      const client = await connect({ transport: injecting.transport });
      const space = "did:key:z6Mk-instance-names-revocation";
      try {
        const session = await client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const observed: Error[] = [];
        session.subscribeTermination((error) => observed.push(error));
        injecting.inject({
          type: "session/revoked",
          space,
          sessionId: session.sessionId,
          reason: "instance-names",
        });
        expect(observed).toEqual([session.closeError]);
        const error = observed[0];
        expect(isClientUpdateRequiredError(error)).toBe(true);
        expect(error.name).toBe("SessionRevokedError");
        expect(error.message).toBe(
          `Space ${space} now holds data written with instance names, ` +
            "which this runtime does not use",
        );
        await expect(session.queryGraph({ roots: [] })).rejects.toBe(error);
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("refuses every later mount on the client with the same refusal, sending no open", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://instance-names-revocation-kept"),
      });
      const injecting = injectingTransport(server);
      const client = await connect({ transport: injecting.transport });
      const space = "did:key:z6Mk-instance-names-revocation-kept";
      try {
        const session = await client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        injecting.inject({
          type: "session/revoked",
          space,
          sessionId: session.sessionId,
          reason: "instance-names",
        });
        const opens = injecting.opens();
        await expect(client.mount(space, {}, testSessionOpenAuthFactory))
          .rejects.toBe(session.closeError);
        await expect(
          client.mount(
            "did:key:z6Mk-instance-names-other-space",
            {},
            testSessionOpenAuthFactory,
          ),
        ).rejects.toBe(session.closeError);
        expect(injecting.opens()).toBe(opens);
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("leaves a takeover revocation unmarked, so a later mount opens a session", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://takeover-revocation-unmarked"),
      });
      const injecting = injectingTransport(server);
      const client = await connect({ transport: injecting.transport });
      const space = "did:key:z6Mk-takeover-revocation-unmarked";
      try {
        const session = await client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        injecting.inject({
          type: "session/revoked",
          space,
          sessionId: session.sessionId,
          reason: "taken-over",
        });
        expect(session.closeError?.name).toBe("SessionRevokedError");
        expect(isClientUpdateRequiredError(session.closeError)).toBe(false);
        const opens = injecting.opens();
        await client.mount(space, {}, testSessionOpenAuthFactory);
        expect(injecting.opens()).toBe(opens + 1);
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("leaves the session open for a revocation reason the client does not know", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://unknown-revocation-reason"),
      });
      const injecting = injectingTransport(server);
      const client = await connect({ transport: injecting.transport });
      const space = "did:key:z6Mk-unknown-revocation-reason";
      try {
        const session = await client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        injecting.inject({
          type: "session/revoked",
          space,
          sessionId: session.sessionId,
          reason: "a-reason-no-build-sends",
        });
        expect(session.closeError).toBeUndefined();
        await session.queryGraph({ roots: [] });
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
