/**
 * Signed `session.open` requests take turns: each signs the connection's one
 * current challenge and is answered with the next. These cases cover a mount
 * whose caller cancels it while it is in that queue, waiting for its turn or
 * holding it.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  connect,
  type SessionOpenAuthFactory,
  type SessionPrincipal,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { ServerTransport } from "./support/server-transport.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/** A client of a server of its own for the case named `name`. */
async function connected(name: string) {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://client-signed-open-turns-${name}`),
  });
  const transport = new ServerTransport(server);
  const client = await connect({ transport });
  const close = async () => {
    await client.close();
    await server.close();
  };
  return { transport, client, close };
}

/** The space of the case named `name` that `which` mount opens. */
const spaceFor = (name: string, which: string) =>
  `did:key:z6Mk-client-signed-open-turns-${name}-${which}`;

/**
 * A signer that reports through `asked` when it is asked to sign, and signs
 * once `release` resolves.
 */
const signerHeldUntil = (
  asked: PromiseWithResolvers<void>,
  release: Promise<void>,
): SessionOpenAuthFactory =>
async (space, session, context) => {
  asked.resolve();
  await release;
  return await testSessionOpenAuthFactory(space, session, context);
};

describe("client", () => {
  describe("signed opens", () => {
    it("asks no signature and sends no `session.open` for a mount its caller cancelled while it waited its turn", async () => {
      const t = await connected("cancelled-waiting");
      try {
        const signing = Promise.withResolvers<void>();
        const signed = Promise.withResolvers<void>();
        const ahead = t.client.mount(
          spaceFor("cancelled-waiting", "ahead"),
          {},
          signerHeldUntil(signing, signed.promise),
        );
        await signing.promise;
        const cancel = new AbortController();
        let asked = 0;
        // The mount's proofs are asked for in the step that queues it behind
        // the first one's signing.
        const queued = Promise.withResolvers<void>();
        const principal: SessionPrincipal = {
          did: "did:key:z6Mk-client-signed-open-turns-cancelled-key",
          authorizeConnection: () => {
            throw new Error("this server verifies each session.open");
          },
          authorizeSessionOpen: (space, session, context) => {
            asked++;
            return testSessionOpenAuthFactory(space, session, context);
          },
          proofs: () => {
            queued.resolve();
            return undefined;
          },
        };
        const cancelled = t.client.mount(
          spaceFor("cancelled-waiting", "cancelled"),
          {},
          principal,
          cancel.signal,
        );
        await queued.promise;
        const behind = t.client.mount(
          spaceFor("cancelled-waiting", "behind"),
          {},
          testSessionOpenAuthFactory,
        );
        cancel.abort(new Error("test cancels the mount"));
        await expect(cancelled).rejects.toThrow("test cancels the mount");
        signed.resolve();
        // The mount behind the cancelled one has had its turn once it is
        // mounted, so the cancelled one's turn has passed.
        await ahead;
        await behind;

        expect(asked).toBe(0);
        expect(
          t.transport.sentTypes.filter((type) => type === "session.open"),
        ).toHaveLength(2);
      } finally {
        await t.close();
      }
    });

    it("mounts the space behind a mount whose caller cancelled it while its signer held the turn", async () => {
      // A signer that never returns must not keep the turn of a mount nobody
      // is waiting for any more.

      const t = await connected("cancelled-signing");
      const neverSigned = Promise.withResolvers<void>();
      try {
        const signing = Promise.withResolvers<void>();
        const cancel = new AbortController();
        const stuck = t.client.mount(
          spaceFor("cancelled-signing", "stuck"),
          {},
          signerHeldUntil(signing, neverSigned.promise),
          cancel.signal,
        );
        await signing.promise;
        const behind = t.client.mount(
          spaceFor("cancelled-signing", "behind"),
          {},
          testSessionOpenAuthFactory,
        );
        cancel.abort(new Error("test cancels the mount"));
        await expect(stuck).rejects.toThrow("test cancels the mount");

        expect((await behind).space).toBe(
          spaceFor("cancelled-signing", "behind"),
        );
        expect(
          t.transport.sentTypes.filter((type) => type === "session.open"),
        ).toHaveLength(1);
      } finally {
        await t.close();
      }
    });

    it("sends no `session.open` for a mount its caller cancelled in the step its signer returned", async () => {
      // The signature arrives first and the cancellation right behind it, so
      // the wait for the signer ends with a signature for a mount that is
      // already cancelled.

      const t = await connected("cancelled-signed");
      try {
        const signing = Promise.withResolvers<void>();
        const signature = Promise.withResolvers<
          Awaited<ReturnType<SessionOpenAuthFactory>>
        >();
        let sign = (): void => {};
        const cancel = new AbortController();
        const cancelled = t.client.mount(
          spaceFor("cancelled-signed", "cancelled"),
          {},
          (space, session, context) => {
            sign = () =>
              signature.resolve(
                testSessionOpenAuthFactory(space, session, context),
              );
            signing.resolve();
            return signature.promise;
          },
          cancel.signal,
        );
        await signing.promise;
        const behind = t.client.mount(
          spaceFor("cancelled-signed", "behind"),
          {},
          testSessionOpenAuthFactory,
        );
        sign();
        cancel.abort(new Error("test cancels the mount"));
        await expect(cancelled).rejects.toThrow("test cancels the mount");
        // The mount behind the cancelled one has had its turn once it is
        // mounted, so the cancelled one's turn has passed.
        await behind;

        expect(
          t.transport.sentTypes.filter((type) => type === "session.open"),
        ).toHaveLength(1);
      } finally {
        await t.close();
      }
    });
  });
});
