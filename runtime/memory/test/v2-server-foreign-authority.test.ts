import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import type { FabricPlainObject } from "@commonfabric/api";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { Server } from "../v2/server.ts";
import { connectPeer, openSession, request } from "./support/wire-peer.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-foreign-authority-space";
const ALICE = "did:key:z6Mk-foreign-authority-alice";

describe("Server", () => {
  describe("foreignReadAuthorityFor()", () => {
    describe("over a memory store", () => {
      let server: Server;

      beforeEach(() => {
        server = new Server({
          ...testSessionOpenServerOptions,
          store: new URL(`memory://foreign-authority-${crypto.randomUUID()}`),
          subscriptionRefreshDelayMs: "manual",
        });
      });

      afterEach(async () => {
        await server.close();
      });

      /** Opens a session on the space, which opens its store, and commits
       * `acl` as its ACL document unless it is `undefined`. */
      const openSpace = async (acl?: FabricPlainObject) => {
        const peer = await connectPeer(server);
        const { sessionId } = await openSession(peer, SPACE);
        if (acl === undefined) return;
        const written = await request(peer, {
          type: "transact",
          space: SPACE,
          sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: `of:${SPACE}`,
              value: { value: acl },
            }],
          },
        });
        expect(written.error).toBeUndefined();
      };

      it("returns a grant for a principal the space's ACL grants READ", async () => {
        await openSpace({ [ALICE]: "OWNER" });

        expect(await server.foreignReadAuthorityFor(SPACE, ALICE)).toEqual({
          granted: true,
        });
      });

      it("returns a refusal naming the missing ACL for a space whose store holds none", async () => {
        await openSpace();

        expect(await server.foreignReadAuthorityFor(SPACE, ALICE)).toEqual({
          granted: false,
          reason: `${SPACE} exists with no ACL document — the serving plane ` +
            "fails closed (protocol.md §2's interim; the client path's " +
            "legacy compat arm is a rollout accommodation, not a grant)",
        });
      });

      it("returns a refusal naming the malformed ACL for a space whose ACL names no owner", async () => {
        await openSpace({ [ALICE]: "READ" });

        expect(await server.foreignReadAuthorityFor(SPACE, ALICE)).toEqual({
          granted: false,
          reason: `${SPACE} has a malformed, ownerless, or retracted ACL`,
        });
      });
    });

    describe("over a file store", () => {
      it("returns a refusal naming no space when the store's path runs through a file", async () => {
        const directory = await Deno.makeTempDir({
          prefix: "memory-foreign-authority-",
        });
        // The store directory is a regular file, so looking for a space's
        // store file beneath it fails with an error other than "not found".
        const file = `${directory}/not-a-directory`;
        await Deno.writeTextFile(file, "");
        const server = new Server({
          ...testSessionOpenServerOptions,
          store: toFileUrl(`${file}/`),
          subscriptionRefreshDelayMs: "manual",
        });
        try {
          expect(await server.foreignReadAuthorityFor(SPACE, ALICE)).toEqual({
            granted: false,
            reason: `no space has the DID ${SPACE} — a space exists once ` +
              "its genesis ACL commit lands (protocol.md §2)",
          });
        } finally {
          await server.close();
          await Deno.remove(directory, { recursive: true });
        }
      });
    });
  });
});
