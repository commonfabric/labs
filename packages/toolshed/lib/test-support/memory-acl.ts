// A real memory-v2 server with ACL enforcement, in-process.
//
// TEST SUPPORT ONLY. It exists because `StorageManager.emulate` — what the rest
// of the toolshed suite uses — constructs its server with no `acl` option at
// all, so `#aclMode()` is "off" and NOTHING is authorized. Any test of an
// authorization property written against the emulator proves nothing, and a
// regression would pass CI silently.
//
// Neither the loopback session factory nor the `overServer` constructor trick
// is exported by the runner package (the pattern lives, unexported, in
// packages/runner/test/memory-v2-acl-bootstrap.test.ts), so they are reproduced
// here rather than imported.

import type { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import { toDocumentPath } from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";

const TEST_AUDIENCE = "did:key:z6Mk-toolshed-acl-harness-audience";

/** Speaks the wire protocol in-process — no socket, no server process. */
export class LoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;
  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
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

/** `StorageManager`'s constructor is protected; a subclass may reach it. */
export class TestStorageManager extends StorageManager {
  static overServer(
    options: Omit<Options, "memoryHost">,
    factory: SessionFactory,
  ): TestStorageManager {
    return new TestStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      factory,
    );
  }
}

export const createAclServer = (
  label: string,
  mode: "off" | "observe" | "enforce" = "enforce",
): MemoryV2Server.Server =>
  new MemoryV2Server.Server({
    store: new URL(`memory://${label}`),
    // A signed open is verified; an unsigned one is trusted as the principal
    // it names. The ACL decision under test is downstream of authentication.
    authorizeSessionOpen: authorizeLoopbackSessionOpen,
    sessionOpenAuth: { audience: TEST_AUDIENCE },
    acl: { mode },
    subscriptionRefreshDelayMs: 0,
  });

/**
 * Write a space's genesis ACL as the space identity itself — the one principal
 * the memory server lets initialize a missing ACL (`principal === space`). This
 * lets a test pin an ARBITRARY ACL shape rather than accept the bootstrap
 * default, which names the owner alone, and is what makes the wildcard cases
 * testable.
 */
export const genesisAcl = async (
  factory: LoopbackSessionFactory,
  spaceIdentity: Identity,
  acl: Record<string, "READ" | "WRITE" | "OWNER">,
): Promise<void> => {
  const space = spaceIdentity.did() as MemorySpace;
  const { client, session } = await factory.create(space, spaceIdentity, {});
  try {
    const aclId = `of:${space}`;
    await session.transact({
      localSeq: 1,
      reads: {
        confirmed: [{ id: aclId, path: toDocumentPath([]), seq: 0 }],
        pending: [],
      },
      operations: [{ op: "set", id: aclId, value: { value: acl } }],
    });
  } finally {
    await client.close();
  }
};
