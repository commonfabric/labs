import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { ACL } from "@commonfabric/memory/acl";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import { Runtime } from "@commonfabric/runner";
import type { SessionFactory } from "@commonfabric/runner/storage/v2";

import { TestStorageManager } from "../../runner/test/memory-v2-test-utils.ts";
import { leaveAcl } from "../lib/acl.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr } from "./utils.ts";

const AUDIENCE = "did:key:z6Mk-cli-acl-memory-server-audience";

const alice = await Identity.fromPassphrase("cli acl memory-server alice");
const bob = await Identity.fromPassphrase("cli acl memory-server bob");

/** Opens loopback sessions on `server`, authenticated as the signer given. */
class LoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;
  readonly #server: Server;

  constructor(server: Server) {
    this.#server = server;
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    const session = await client.mount(
      space,
      requested,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    return { client, session };
  }
}

describe("acl, against an `enforce` memory server", () => {
  let server: Server;
  let cleanups: (() => Promise<void>)[];
  let serverCount = 0;

  beforeEach(() => {
    cleanups = [];
    server = new Server({
      store: new URL(`memory://cli-acl-memory-server-${++serverCount}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: AUDIENCE },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  /** Returns a runtime acting as `user` over `server`. */
  function runtimeAs(user: Identity): Runtime {
    const storageManager = TestStorageManager.create(
      { as: user, memoryHost: new URL("memory://") },
      new LoopbackSessionFactory(server),
    );
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await storageManager.close();
    });
    return runtime;
  }

  /** Has alice create a space whose genesis list is `acl`. */
  async function createSpace(acl: ACL): Promise<MemorySpace> {
    return await runtimeAs(alice).storageManager.createSpace!(acl);
  }

  /** Runs `leaveAcl()` for `space` as `user`. */
  async function leaveAs(user: Identity, space: MemorySpace) {
    const runtime = runtimeAs(user);
    resetWriteReceipts();
    let outcome: unknown;
    await captureStderr(async () => {
      outcome = await leaveAcl(
        { apiUrl: "http://unused.test", space, identity: "/unused/key" },
        {
          loadPieces: () =>
            Promise.resolve({ runtime, getSpace: () => space } as never),
        },
      );
    });
    return outcome;
  }

  describe("leaveAcl()", () => {
    for (const level of ["READ", "WRITE"] as const) {
      it(`removes a \`${level}\` member's own entry, which the server's ACL then lacks, and returns \`"left"\``, async () => {
        const space = await createSpace({
          [alice.did()]: "OWNER",
          [bob.did()]: level,
        });

        expect(await leaveAs(bob, space)).toBe("left");

        expect((await server.readDocument(space, `of:${space}`))?.value)
          .toEqual({ [alice.did()]: "OWNER" });
      });
    }

    it("removes an `OWNER`'s own entry beside another concrete `OWNER`", async () => {
      const space = await createSpace({
        [alice.did()]: "OWNER",
        [bob.did()]: "OWNER",
      });

      expect(await leaveAs(bob, space)).toBe("left");

      expect((await server.readDocument(space, `of:${space}`))?.value)
        .toEqual({ [alice.did()]: "OWNER" });
    });
  });
});
