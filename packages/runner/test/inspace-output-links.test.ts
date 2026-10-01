import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import type { Cell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const AUDIENCE = "did:key:z6Mk-inspace-output-links-audience";

/** Opens each session as the principal its signer is, over one server. */
class PrincipalSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;

  readonly #server: MemoryV2Server.Server;

  /** Constructs an instance which opens its sessions on `server`. */
  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  /** @inheritDoc */
  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    try {
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
    } catch (error) {
      await client.close();
      throw error;
    }
  }
}

/** A storage manager over a server the test holds. */
class TestStorageManager extends StorageManager {
  /** Constructs an instance which opens its sessions through `factory`. */
  constructor(options: Options, factory: SessionFactory) {
    super(options, factory);
  }
}

/**
 * Runs, as `runtime`'s own principal in that principal's home space, a
 * handler which creates two children in `target`, the second taking an output
 * of the first as its argument. Returns the second child.
 */
async function createRoom(
  runtime: Runtime,
  home: MemorySpace,
  target: MemorySpace,
): Promise<Cell<{ policy: string }>> {
  const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;
  const Policy = pattern<{ value: string }>(({ value }) => ({ value }));
  const Room = pattern<{ policy: Cell<string> }>(
    ({ policy }) => ({ policy }),
    {
      type: "object",
      properties: { policy: { type: "string", asCell: ["cell"] } },
      required: ["policy"],
    },
  );
  const create = handler<Record<string, never>, { room: Cell<unknown> }>(
    { type: "object" },
    {
      type: "object",
      properties: { room: { asCell: ["cell"] } },
      required: ["room"],
    },
    (_event, { room }) => {
      const policy = Policy.inSpace(target)({ value: "shared policy" });
      const child = Room.inSpace(target)({ policy: policy.value });
      // Naming the output here, with a node already holding it as an input,
      // is what a handler is free to do until it returns.
      (policy as unknown as Cell<{ value: string }>).for("policy");
      room.set(child);
    },
  );
  const Root = pattern<{ room: Cell<unknown> }>(
    ({ room }) => ({ create: create({ room }) }),
    {
      type: "object",
      properties: { room: { asCell: ["cell"] } },
      required: ["room"],
    },
  );
  const tx = runtime.edit();
  const room = runtime.getCell(home, "room-reference", undefined, tx);
  const root = runtime.getCell(home, "creator", undefined, tx);
  const result = runtime.run(tx, Root, { room }, root);
  runtime.prepareTxForCommit(tx);
  expect((await tx.commit()).error).toBeUndefined();
  await runtime.idle();
  await result.pull();
  result.key("create").send({});
  await runtime.idle();
  await runtime.storageManager.synced();
  await room.pull();
  return room.resolveAsCell() as Cell<{ policy: string }>;
}

describe("inspace-output-links", () => {
  // A handler creates two children with `inSpace()`, both in one space other
  // than its own, and hands an output of the first to the second as an
  // argument.

  it("stores, in the second child's argument, a link into the space both children are in", async () => {
    const creator = await Identity.fromPassphrase("inspace-output-links-home");
    const target = (await Identity.fromPassphrase("inspace-output-links-room"))
      .did();
    const storage = EmulatedStorageManager.emulate({ as: creator });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const child = await createRoom(runtime, creator.did(), target);
      expect(child.space).toBe(target);
      const argument = child.getArgumentCell<{ policy: string }>()!;
      // The stored link is what the assertion reads: resolving it would
      // follow it through whichever space it names.
      const policyLink = parseLink(argument.key("policy").getRaw(), argument);
      expect(policyLink?.space).toBe(target);
      expect(await child.key("policy").pull()).toBe("shared policy");
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  it("returns the output to a principal who may read the children's space and not the handler's", async () => {
    const creator = await Identity.fromPassphrase(
      "inspace-output-links-creator",
    );
    const member = await Identity.fromPassphrase("inspace-output-links-member");
    const server = new MemoryV2Server.Server({
      store: new URL("memory://inspace-output-links"),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: AUDIENCE },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
    const factory = new PrincipalSessionFactory(server);
    const memoryHost = new URL("memory://");
    const creatorStorage = new TestStorageManager(
      { as: creator, memoryHost },
      factory,
    );
    const memberStorage = new TestStorageManager(
      { as: member, memoryHost },
      factory,
    );
    const creatorRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: creatorStorage,
    });
    const memberRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: memberStorage,
    });
    try {
      const target = await creatorStorage.createSpace({
        [creator.did()]: "OWNER",
        [member.did()]: "READ",
      });
      const child = await createRoom(creatorRuntime, creator.did(), target);
      expect(await child.key("policy").pull()).toBe("shared policy");

      const memberChild = memberRuntime.getCellFromLink(
        child.getAsNormalizedFullLink(),
      );
      await memberChild.sync();
      expect(await memberChild.key("policy").pull()).toBe("shared policy");
      // The server refuses the member any read of the creator's home space,
      // and no such refusal happened on the way to the value.
      expect(memberStorage.spaceAccessError(creator.did())).toBeUndefined();
    } finally {
      await memberRuntime.dispose();
      await creatorRuntime.dispose();
      await memberStorage.close();
      await creatorStorage.close();
      await server.close();
    }
  });
});
