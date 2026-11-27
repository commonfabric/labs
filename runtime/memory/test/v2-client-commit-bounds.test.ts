import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/api";

import {
  type ClientCommit,
  decodeMemoryBoundary,
  MAX_UNTRUSTED_MESSAGE_SLOTS,
} from "../v2.ts";
import { connect, loopback, type Transport } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const SPACE = "did:key:z6Mk-client-commit-bounds";

/** The bound, in bytes, the test connection holds one whole request to. */
const WHOLE_BYTES = 4096;

/** A commit of `localSeq` setting the document `id` to `value`. */
const commitOf = (
  localSeq: number,
  id: string,
  value: string,
): ClientCommit => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: [{ op: "set", id, value: { value } }],
});

describe("SpaceSession", () => {
  let server: Server;
  let sentCommits: number[];
  let transport: Transport;

  beforeEach(() => {
    server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL(`memory://client-commit-bounds-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: 0,
    });
    sentCommits = [];
    const inner = loopback(server, {
      messageLimits: { bytes: 1024, values: null, whole: WHOLE_BYTES },
    });
    transport = {
      ...inner,
      send: (payload: string) => {
        const message = decodeMemoryBoundary(payload) as {
          type?: string;
          commit?: ClientCommit;
        };
        if (message.type === "transact") {
          sentCommits.push(message.commit!.localSeq);
        }
        return inner.send(payload);
      },
      close: () => inner.close(),
      setReceiver: (receiver: (payload: string) => void) =>
        inner.setReceiver(receiver),
    };
  });

  afterEach(async () => {
    await server.close();
  });

  describe("transact()", () => {
    it("throws a `MessageTooLargeError` without sending a commit past the bound its connection holds one request to, and sends the next commit", async () => {
      const client = await connect({ transport });
      try {
        const session = await client.mount(
          SPACE,
          {},
          testSessionOpenAuthFactory,
        );

        await expect(
          session.transact(
            commitOf(1, "of:too-large", "x".repeat(WHOLE_BYTES)),
          ),
        ).rejects.toMatchObject({ name: "MessageTooLargeError" });
        await session.transact(commitOf(2, "of:fits", "fits"));

        expect(sentCommits).toEqual([2]);
        expect((await server.readDocument(SPACE, "of:too-large"))?.value)
          .toBeUndefined();
        expect((await server.readDocument(SPACE, "of:fits"))?.value)
          .toBe("fits");
      } finally {
        await client.close();
      }
    });

    for (
      const [name, untrustedMessageSlots, sent] of [
        ["the default slot limit", undefined, false],
        ["a slot limit it raised", MAX_UNTRUSTED_MESSAGE_SLOTS * 2, true],
      ] as const
    ) {
      it(
        `${
          sent ? "sends" : "does not send"
        } a commit past the default slot limit to a server holding clients to ${name}`,
        async () => {
          const held = new Server({
            ...testSessionOpenServerOptions,
            store: new URL(
              `memory://client-commit-bounds-${crypto.randomUUID()}`,
            ),
            subscriptionRefreshDelayMs: 0,
            ...(untrustedMessageSlots === undefined
              ? {}
              : { untrustedMessageSlots }),
          });
          const inner = loopback(held);
          let transacts = 0;
          const client = await connect({
            transport: {
              ...inner,
              send: (payload: string) => {
                if (payload.includes('"transact"')) transacts++;
                return inner.send(payload);
              },
              close: () => inner.close(),
              setReceiver: (receiver: (payload: string) => void) =>
                inner.setReceiver(receiver),
            },
          });
          try {
            const session = await client.mount(
              SPACE,
              {},
              testSessionOpenAuthFactory,
            );
            // One value more than the default limit, written out.
            const items: FabricValue[] = new Array(MAX_UNTRUSTED_MESSAGE_SLOTS)
              .fill(0);
            const commit: ClientCommit = {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: "of:wide",
                value: { value: items },
              }],
            };

            if (sent) {
              await session.transact(commit);
              const stored = (await held.readDocument(SPACE, "of:wide"))
                ?.value as FabricValue[] | undefined;
              expect(stored?.length).toBe(MAX_UNTRUSTED_MESSAGE_SLOTS);
            } else {
              await expect(session.transact(commit)).rejects.toMatchObject({
                name: "MessageTooLargeError",
              });
            }
            expect(transacts).toBe(sent ? 1 : 0);
          } finally {
            await client.close();
            await held.close();
          }
        },
      );
    }
  });
});
