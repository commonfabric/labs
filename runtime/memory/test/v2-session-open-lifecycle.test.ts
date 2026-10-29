import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { aclDocId } from "../acl.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionDescriptor,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  type WatchSetResult,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

describe("v2-session-open-lifecycle", () => {
  it("refuses a routed open whose authority ends during admission", async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const space = TEST_SESSION_OPEN_PRINCIPAL;
    const sessionId = "session:routed-admission";
    const server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://open-routed-admission"),
      acl: { mode: "enforce", serviceDids: [TEST_SESSION_OPEN_PRINCIPAL] },
      ownsSpace: (target) => target === space,
    });
    let owns = true;
    const messages: ServerMessage[] = [];
    const connection = server.connectRouted(
      (message) => messages.push(message),
      (target) => owns && target === space,
    );
    let opening: Promise<void> | undefined;
    try {
      await connection.receive(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: getMemoryProtocolFlags(),
      }));
      connection.admitRoutedPrincipal(space, server.nowSeconds() + 600);
      server.accessForTestingOnly.engineOpener = async (target, open) => {
        reached.resolve();
        await release.promise;
        return await open(target);
      };
      opening = connection.receive(encodeMemoryBoundary({
        type: "session.open",
        requestId: "routed-open",
        space,
        principal: space,
        session: { sessionId },
      }));
      await reached.promise;
      owns = false;
      release.resolve();
      await opening;
      expect(
        messages.find((message) =>
          message.type === "response" && message.requestId === "routed-open"
        ),
      ).toMatchObject({
        error: {
          name: "AuthorizationError",
          message: "Routed memory authority ended during admission",
        },
      });
      expect(connection.hasSession(space, sessionId)).toBe(false);
      expect(server.accessForTestingOnly.sessionsForSpace(space)).toEqual([]);
      expect(connection.closed).toBe(false);
    } finally {
      release.resolve();
      await opening;
      server.accessForTestingOnly.engineOpener = undefined;
      connection.close();
      await server.close();
    }
  });

  for (const mode of ["off", "enforce"] as const) {
    for (
      const outcome of ["closed", "failed", "failed-live", "replaced"] as const
    ) {
      const description = outcome === "replaced"
        ? "keeps a newer owner's delivery cache when an older opening connection closes during catch-up"
        : outcome === "failed-live"
        ? "detaches a failed resume while its connection stays live"
        : outcome === "failed"
        ? "detaches a session whose opening connection closes during failed catch-up"
        : "redelivers catch-up discarded by a closing connection";
      it(`${description} (${mode})`, async () => {
        // Ownership is registered before catch-up reads its engine. Closing
        // that connection starts its session's grace period even while the
        // read is pending, and cannot detach a replacement owner.
        const reached = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const server = new Server({
          ...testSessionOpenServerOptions,
          store: new URL(`memory://open-catchup-${mode}-${outcome}`),
          acl: { mode, serviceDids: [TEST_SESSION_OPEN_PRINCIPAL] },
          subscriptionRefreshDelayMs: "manual",
        });
        const messages: ServerMessage[] = [];
        const first = server.connect((message) => messages.push(message));
        const second = server.connect((message) => messages.push(message));
        const third = server.connect((message) => messages.push(message));
        const space = TEST_SESSION_OPEN_PRINCIPAL;
        const sessionId = "session:open-catchup";
        let opening: Promise<void> | undefined;

        /** Returns a connection's authorization metadata after its hello. */
        const hello = async (
          connection: typeof first,
        ): Promise<SessionOpenAuthMetadata> => {
          await connection.receive(encodeMemoryBoundary({
            type: "hello",
            protocol: MEMORY_PROTOCOL,
            flags: getMemoryProtocolFlags(),
          }));
          const reply = messages.pop();
          if (reply?.type !== "hello.ok" || reply.sessionOpen === undefined) {
            throw new Error("Expected hello authorization metadata");
          }
          return reply.sessionOpen;
        };

        /** Sends an open authenticated by the connection's hello challenge. */
        const sendOpen = (
          connection: typeof first,
          auth: SessionOpenAuthMetadata,
          requestId: string,
          session: SessionDescriptor,
        ) =>
          connection.receive(encodeMemoryBoundary({
            type: "session.open",
            requestId,
            space,
            session,
            invocation: { aud: auth.audience, challenge: auth.challenge.value },
            authorization: {},
          }));

        /** Returns the server's current retained session for this space. */
        const retainedSession = () =>
          server.accessForTestingOnly.sessionsForSpace(space)
            .find((session) => session.id === sessionId);

        /** Returns the successful result of the named request. */
        const result = <T>(requestId: string): T => {
          const response = messages.find((message) =>
            message.type === "response" && message.requestId === requestId
          ) as ResponseMessage<T> | undefined;
          expect(response?.error).toBeUndefined();
          expect(response?.ok).toBeDefined();
          if (response?.ok === undefined) throw new Error("Expected result");
          return response.ok;
        };

        try {
          await sendOpen(first, await hello(first), "open-first", {
            sessionId,
            resumeKey: "key",
            resumeAttempt: 1,
          });
          const original = retainedSession();
          expect(original).toBeDefined();
          if (original === undefined) {
            throw new Error("Expected mounted session");
          }
          const seed = await server.transact({
            type: "transact",
            requestId: "seed",
            space,
            sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: aclDocId(space),
                value: { value: { [space]: "OWNER" } },
              }],
            },
          });
          expect(seed.error).toBeUndefined();
          await server.writeDocument(space, "of:document", { version: 1 });
          await first.receive(encodeMemoryBoundary({
            type: "session.watch.set",
            requestId: "watch",
            space,
            sessionId,
            watches: [{
              id: "document",
              kind: "graph",
              query: {
                roots: [{
                  id: "of:document",
                  selector: { path: [], schema: false },
                }],
              },
            }],
          }));
          expect(result<WatchSetResult>("watch").sync.upserts).toMatchObject([
            { id: "of:document", doc: { value: { version: 1 } } },
          ]);
          first.close();
          await server.writeDocument(space, "of:document", { version: 2 });
          const secondAuth = await hello(second);
          let heldCatchup = false;
          server.accessForTestingOnly.engineOpener = async (target, open) => {
            // Admission sees the detached owner. Only the catch-up read
            // sees this new owner, so the gate holds the real read there.
            if (
              !heldCatchup &&
              server.isSessionAttached(space, sessionId, second.id)
            ) {
              heldCatchup = true;
              reached.resolve();
              await release.promise;
              if (outcome === "failed" || outcome === "failed-live") {
                throw new Error("catch-up read failed");
              }
            }
            return await open(target);
          };
          opening = sendOpen(second, secondAuth, "open-second", {
            sessionId,
            sessionToken: original.sessionToken,
            resumeKey: "key",
            resumeAttempt: 2,
          });
          await reached.promise;
          if (outcome === "replaced") {
            const held = retainedSession();
            expect(held).toBeDefined();
            if (held === undefined) {
              throw new Error("Expected resuming session");
            }
            await sendOpen(third, await hello(third), "open-third", {
              sessionId,
              sessionToken: held.sessionToken,
              resumeKey: "replacement-key",
              resumeAttempt: 1,
            });
          }
          if (outcome !== "failed-live") second.close();
          if (outcome === "closed" || outcome === "failed") {
            expect(retainedSession()).toMatchObject({
              ownerConnectionId: null,
              expiresAt: expect.any(Number),
            });
          }
          release.resolve();
          await opening;
          expect(server.isSessionAttached(space, sessionId, second.id)).toBe(
            false,
          );
          if (outcome === "replaced") {
            expect(server.isSessionAttached(space, sessionId, third.id)).toBe(
              true,
            );
            expect(retainedSession()).toMatchObject({
              ownerConnectionId: third.id,
              expiresAt: null,
            });
            expect(result<SessionOpenResult>("open-third").sync?.upserts)
              .toMatchObject([{
                id: "of:document",
                doc: { value: { version: 2 } },
              }]);
            expect(await server.syncSessionForConnection(space, sessionId))
              .toBeNull();
          } else {
            expect(retainedSession()).toMatchObject({
              ownerConnectionId: null,
              expiresAt: expect.any(Number),
            });
            if (outcome === "failed-live") {
              expect(second.closed).toBe(false);
              expect(second.hasSession(space, sessionId)).toBe(false);
              await server.flushSessions();
              expect(
                messages.some((message) => message.type === "session/effect"),
              ).toBe(false);
            }
            const detached = retainedSession();
            if (detached === undefined) throw new Error("Expected session");
            await sendOpen(third, await hello(third), "open-third", {
              sessionId,
              sessionToken: detached.sessionToken,
              resumeKey: "replacement-key",
              resumeAttempt: 1,
            });
            expect(result<SessionOpenResult>("open-third").sync?.upserts)
              .toMatchObject([{
                id: "of:document",
                doc: { value: { version: 2 } },
              }]);
          }
          const response = messages.find((message) =>
            message.type === "response" && message.requestId === "open-second"
          );
          expect(response).toMatchObject({
            error: outcome === "failed" || outcome === "failed-live"
              ? { name: "ProtocolError", message: "catch-up read failed" }
              : {
                name: "SessionError",
                message: "The connection closed during catch-up",
              },
          });
        } finally {
          release.resolve();
          await opening;
          server.accessForTestingOnly.engineOpener = undefined;
          first.close();
          second.close();
          third.close();
          await server.close();
        }
      });
    }
  }
});
