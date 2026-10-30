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

  describe("a deleted space", () => {
    it("terminates a session revoked as `deleted` with an `AuthorizationError` marked `deleted`", async () => {
      // The revocation goes out through the server's connection, so the frame
      // crosses the wire encoding and the client's frame validation. The
      // connection delivers frames in order, so once the response to a later
      // request has arrived, so has the revocation.
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://session-revoked-deleted"),
      });
      let connection: ReturnType<Server["connect"]> | undefined;
      const client = await connect({
        transport: loopback({
          connect: (send, syncParts) =>
            connection = server.connect(send, syncParts),
        }),
      });
      try {
        const space = "did:key:z6Mk-revoked-deleted";
        const session = await client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const observed: Error[] = [];
        session.subscribeTermination((error) => observed.push(error));
        connection!.revokeSession(space, session.sessionId, "deleted");
        await client.mount(
          "did:key:z6Mk-revoked-deleted-later",
          {},
          testSessionOpenAuthFactory,
        );
        expect(observed).toHaveLength(1);
        expect(observed[0].name).toBe("AuthorizationError");
        expect((observed[0] as Error & { deleted?: unknown }).deleted).toBe(
          true,
        );
        expect(session.closeError).toBe(observed[0]);
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("marks no other revocation `deleted`", async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://session-revoked-not-deleted"),
      });
      const client = await connect({ transport: loopback(server) });
      try {
        for (const reason of ["taken-over", "unauthorized"] as const) {
          const session = await client.mount(
            `did:key:z6Mk-revoked-${reason}`,
            {},
            testSessionOpenAuthFactory,
          );
          session.handleRevoked(reason);
          expect(session.closeError).toBeDefined();
          expect(Object.hasOwn(session.closeError!, "deleted")).toBe(false);
        }
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("rejects a request the server refuses as `deleted` with an error carrying the server's markers", async () => {
      // The server's refusal of a deleted space is stood in for by rewriting
      // the response to the query, so the client's own copying is what is
      // under test.
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://request-refused-deleted"),
      });
      const space = "did:key:z6Mk-request-refused-deleted";
      let refuseNext = false;
      const client = await connect({
        transport: loopback({
          connect: (send, syncParts) =>
            server.connect((message, payload) => {
              if (refuseNext && message.type === "response") {
                refuseNext = false;
                send({
                  type: "response",
                  requestId: message.requestId,
                  error: {
                    name: "AuthorizationError",
                    message: `Space ${space} is deleted`,
                    permanentEvidence: true,
                    aclRevision: 3,
                    deleted: true,
                  },
                });
              } else {
                send(message, payload);
              }
            }, syncParts),
        }),
      });
      try {
        const session = await client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        refuseNext = true;
        const refusal = await session.queryGraph({ roots: [] }).then(
          () => undefined,
          (error: Error) => error,
        ) as
          | Error & {
            permanentEvidence?: unknown;
            aclRevision?: unknown;
            deleted?: unknown;
          }
          | undefined;
        expect(refusal).toBeInstanceOf(Error);
        expect(refusal!.name).toBe("AuthorizationError");
        expect(refusal!.message).toBe(`Space ${space} is deleted`);
        expect(refusal!.permanentEvidence).toBe(true);
        expect(refusal!.aclRevision).toBe(3);
        expect(refusal!.deleted).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    });
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
