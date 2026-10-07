import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { createSession, Identity } from "@commonfabric/identity";
import {
  ACLManager,
  type Cell,
  type MemorySpace,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import * as ops from "../../src/ops/mod.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import { installCustomRoot } from "../install-custom-root.ts";
import {
  ensurePrivateInboxOf,
  type PrivateInboxEnsure,
} from "../../src/ops/private-inbox.ts";

const identity = await Identity.fromPassphrase("private inbox adoption");

/** A principal other than the test's, to own a foreign inbox's space. */
const someoneElse = (await Identity.fromPassphrase("someone else")).did();

// A Home pattern reduced to the fields the host reads and the stream it sends,
// whose handler records what it is sent.
const program: RuntimeProgram = {
  main: "/home.tsx",
  files: [{
    name: "/home.tsx",
    contents: `
import { type Cell, handler, pattern, Writable } from "commonfabric";

type Pointer = { piece?: Cell<{ name?: string }> };

const ensurePrivateInbox = handler<
  { adopt?: Cell<{ name?: string }> },
  { ensured: Writable<number>; adopted: Writable<Pointer> }
>((event, { ensured, adopted }) => {
  ensured.set(ensured.get() + 1);
  adopted.set(event?.adopt === undefined ? {} : { piece: event.adopt });
});

export default pattern(() => {
  const privateInbox = new Writable<Pointer>({}).for("privateInbox");
  const profiles = new Writable<{ inbox?: Pointer }[]>([]).for("profiles");
  const ensured = new Writable(0).for("ensured");
  const adopted = new Writable<Pointer>({}).for("adopted");
  return {
    privateInbox,
    profiles,
    ensured,
    adopted,
    ensurePrivateInbox: ensurePrivateInbox({ ensured, adopted }),
  };
});`,
  }],
};

/** The space and id a link names, which is what makes two links one. */
function addressOf(cell: Cell<unknown>): { space: string; id: string } {
  const { space, id } = cell.getAsNormalizedFullLink();
  return { space, id };
}

describe("ensurePrivateInboxOf()", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;
  let home: Cell<unknown>;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: identity });
    runtime = new Runtime({
      apiUrl: new URL("https://home.example"),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    controller = new PiecesController(
      createSession({ identity, spaceDid: identity.did() }),
      runtime,
    );
    await controller.synced();
    home = await installCustomRoot(runtime, controller, program);
  });

  afterEach(async () => {
    await controller.dispose();
    await storage.close();
  });

  /** A document in `space` holding `value`. */
  async function documentIn(
    space: MemorySpace,
    value: unknown,
  ): Promise<Cell<unknown>> {
    const cell = runtime.getCell<unknown>(space, crypto.randomUUID());
    await runtime.editWithRetry((tx) => cell.withTx(tx).set(value as never));
    return cell;
  }

  /**
   * What an inbox piece in `space` holds: a list of offers, and a link to a
   * `receive` stream, as a piece's result links to each stream it declares.
   */
  function inboxValue(space: MemorySpace): unknown {
    return {
      offers: [],
      receive: runtime.getCell(space, crypto.randomUUID(), {
        asCell: ["stream"],
      }),
    };
  }

  /** An inbox in a space of its own that grants every principal `WRITE`. */
  async function usableInbox(): Promise<Cell<unknown>> {
    const space = await runtime.createSpace({ grants: { "*": "WRITE" } });
    return await documentIn(space, inboxValue(space));
  }

  /** A profile, in a space of its own, whose stored pointer is `inbox`. */
  async function profilePointingAt(inbox: unknown): Promise<Cell<unknown>> {
    const space = await runtime.createSpace({ grants: { "*": "WRITE" } });
    return await documentIn(space, {
      inbox: inbox === undefined ? {} : { piece: inbox },
    });
  }

  /** Puts `profiles` in Home's profile list. */
  async function listProfiles(profiles: Cell<unknown>[]): Promise<void> {
    await runtime.editWithRetry((tx) =>
      home.withTx(tx).key("profiles" as never).set(profiles as never)
    );
  }

  /** Ensures Home's inbox, and waits for Home's handler to run. */
  async function ensure(): Promise<PrivateInboxEnsure> {
    const result = await ensurePrivateInboxOf(runtime, home, identity.did());
    await runtime.idle();
    return result;
  }

  /** The inbox Home's handler was last sent to adopt, if any. */
  async function adopted(): Promise<Cell<unknown> | undefined> {
    const pointer = await home.key("adopted" as never).asSchema({
      type: "object",
      properties: { piece: { type: "unknown", asCell: ["cell"] } },
    }).pull() as { piece?: Cell<unknown> } | undefined;
    return pointer?.piece;
  }

  /** How many adoption refusals have been logged. */
  function refusalsLogged(): number {
    return getLoggerCountsBreakdown()["piece.private-inbox"]
      ?.["adoption-refused"]?.warn ?? 0;
  }

  it("names a usable advertised inbox for Home to adopt", async () => {
    const inbox = await usableInbox();
    await listProfiles([await profilePointingAt(inbox)]);

    const result = await ensure();

    expect(result.outcome).toBe("adopt");
    const named = await adopted();
    expect(named === undefined ? undefined : addressOf(named)).toEqual(
      addressOf(inbox),
    );
  });

  it("vets the first profile in list order that points at an inbox", async () => {
    const first = await usableInbox();
    const second = await usableInbox();
    await listProfiles([
      await profilePointingAt(undefined),
      await profilePointingAt(first),
      await profilePointingAt(second),
    ]);

    const result = await ensure();

    expect(result.outcome).toBe("adopt");
    expect(
      result.outcome === "adopt" ? addressOf(result.inbox) : undefined,
    ).toEqual(addressOf(first));
  });

  it("passes over a profile whose stored pointer is not an object", async () => {
    const inbox = await usableInbox();
    await listProfiles([
      await documentIn(
        await runtime.createSpace({ grants: { "*": "WRITE" } }),
        { inbox: "broken-pointer-container" },
      ),
      await profilePointingAt(inbox),
    ]);

    const result = await ensure();

    expect(
      result.outcome === "adopt" ? addressOf(result.inbox) : undefined,
    ).toEqual(addressOf(inbox));
  });

  it("passes over a profile whose stored pointer holds no link", async () => {
    const inbox = await usableInbox();
    await listProfiles([
      await profilePointingAt("not a link"),
      await profilePointingAt(inbox),
    ]);

    const result = await ensure();

    expect(
      result.outcome === "adopt" ? addressOf(result.inbox) : undefined,
    ).toEqual(addressOf(inbox));
  });

  it("passes over an entry in Home's list that is not a profile", async () => {
    const inbox = await usableInbox();
    await listProfiles([
      null as unknown as Cell<unknown>,
      await profilePointingAt(inbox),
    ]);

    const result = await ensure();

    expect(
      result.outcome === "adopt" ? addressOf(result.inbox) : undefined,
    ).toEqual(addressOf(inbox));
  });

  it("names no inbox when no profile advertises one", async () => {
    await listProfiles([await profilePointingAt(undefined)]);

    const result = await ensure();

    expect(result).toEqual({ outcome: "none-advertised" });
    expect(await adopted()).toBeUndefined();
    expect(await home.key("ensured" as never).pull()).toBe(1);
  });

  it("names no inbox when Home holds one, and vets nothing", async () => {
    const held = await usableInbox();
    await runtime.editWithRetry((tx) =>
      home.withTx(tx).key("privateInbox" as never).set({ piece: held } as never)
    );
    await listProfiles([await profilePointingAt(await usableInbox())]);

    const result = await ensure();

    expect(result).toEqual({ outcome: "held" });
    expect(await adopted()).toBeUndefined();
  });

  it("is the function the package's ops entry point exports", () => {
    expect(ops.ensurePrivateInboxOf).toBe(ensurePrivateInboxOf);
  });

  it("leaves a Home with no `ensurePrivateInbox` as it is", async () => {
    const result = await ensurePrivateInboxOf(
      runtime,
      runtime.getCell<unknown>(identity.did(), "no ensure here"),
      identity.did(),
    );

    expect(result).toEqual({ outcome: "unavailable" });
  });

  describe("refusals", () => {
    /** Ensures Home's inbox over `inbox`, advertised by one profile. */
    async function ensureOver(
      inbox: Cell<unknown>,
      profile?: Cell<unknown>,
    ): Promise<PrivateInboxEnsure> {
      await listProfiles([profile ?? await profilePointingAt(inbox)]);
      return await ensure();
    }

    it("refuses an inbox in the Home space", async () => {
      const result = await ensureOver(
        await documentIn(identity.did(), inboxValue(identity.did())),
      );

      expect(result.outcome === "refused" && result.reason).toBe(
        "inbox-home-space",
      );
    });

    it("refuses an inbox in the advertising profile's own space", async () => {
      const space = await runtime.createSpace({ grants: { "*": "WRITE" } });
      const inbox = await documentIn(space, inboxValue(space));
      const profile = await documentIn(space, { inbox: { piece: inbox } });

      const result = await ensureOver(inbox, profile);

      expect(result.outcome === "refused" && result.reason).toBe(
        "inbox-profile-space",
      );
    });

    it("refuses an inbox whose space another principal owns", async () => {
      const space = await runtime.createSpace({
        owner: someoneElse,
        grants: { "*": "WRITE" },
      });

      const result = await ensureOver(
        await documentIn(space, inboxValue(space)),
      );

      expect(result.outcome === "refused" && result.reason).toBe(
        "inbox-adoption-acl-mismatch",
      );
    });

    it("refuses an inbox whose space does not grant every principal WRITE", async () => {
      const space = await runtime.createSpace();

      const result = await ensureOver(
        await documentIn(space, inboxValue(space)),
      );

      expect(result.outcome === "refused" && result.reason).toBe(
        "inbox-adoption-acl-mismatch",
      );
    });

    it("refuses an inbox whose offers are not a list", async () => {
      const space = await runtime.createSpace({ grants: { "*": "WRITE" } });

      const result = await ensureOver(
        await documentIn(space, {
          ...inboxValue(space) as object,
          offers: "not a list",
        }),
      );

      expect(result.outcome === "refused" && result.reason).toBe(
        "inbox-offers-invalid",
      );
    });

    it("refuses an inbox with no `receive` stream", async () => {
      const space = await runtime.createSpace({ grants: { "*": "WRITE" } });

      const result = await ensureOver(
        await documentIn(space, { offers: [], receive: "not a stream" }),
      );

      expect(result.outcome === "refused" && result.reason).toBe(
        "inbox-receive-missing",
      );
    });

    it("refuses an inbox in a space this identity is refused access to", async () => {
      // Emulated storage enforces no access list, so the refusal is the one a
      // memory server reports: the read fails, and the storage manager holds
      // the space's access error.
      const inbox = await usableInbox();
      const before = refusalsLogged();
      using _refused = stub(
        storage,
        "spaceAccessError",
        (space) =>
          space === inbox.space ? new Error("access refused") : undefined,
      );
      using _stored = stub(
        ACLManager.prototype,
        "getStored",
        () => Promise.reject(new Error("read refused")),
      );

      const result = await ensureOver(inbox);

      expect(result.outcome === "refused" && result.reason).toBe(
        "inbox-access-refused",
      );
      expect(await adopted()).toBeUndefined();
      expect(await home.key("ensured" as never).pull()).toBe(1);
      expect(refusalsLogged()).toBe(before + 1);
    });

    it("refuses an inbox in a space this identity is refused access to, when its reads return", async () => {
      // A refused read can complete without data rather than fail, leaving the
      // refusal with the storage manager alone.
      const inbox = await usableInbox();
      using _refused = stub(
        storage,
        "spaceAccessError",
        (space) =>
          space === inbox.space ? new Error("access refused") : undefined,
      );

      const result = await ensureOver(inbox);

      expect(result.outcome === "refused" && result.reason).toBe(
        "inbox-access-refused",
      );
    });

    it("refuses an inbox whose stored access list is malformed", async () => {
      const inbox = await usableInbox();
      using _stored = stub(
        ACLManager.prototype,
        "getStored",
        () => Promise.resolve("not an access list"),
      );

      const result = await ensureOver(inbox);

      expect(result.outcome === "refused" && result.reason).toBe(
        "inbox-adoption-acl-mismatch",
      );
    });

    it("refuses an inbox whose stored access list names no concrete owner", async () => {
      const inbox = await usableInbox();
      using _stored = stub(
        ACLManager.prototype,
        "getStored",
        () => Promise.resolve({ "*": "WRITE" }),
      );

      const result = await ensureOver(inbox);

      expect(result.outcome === "refused" && result.reason).toBe(
        "inbox-adoption-acl-mismatch",
      );
    });

    it("rejects, sending nothing, when reading the access list fails", async () => {
      const inbox = await usableInbox();
      await listProfiles([await profilePointingAt(inbox)]);
      using _stored = stub(
        ACLManager.prototype,
        "getStored",
        () => Promise.reject(new Error("transport failed")),
      );

      await expect(ensurePrivateInboxOf(runtime, home, identity.did())).rejects
        .toThrow("transport failed");
      await runtime.idle();
      expect(await home.key("ensured" as never).pull()).toBe(0);
    });

    it("names no inbox for Home to adopt, and logs the refusal", async () => {
      const before = refusalsLogged();

      await ensureOver(
        await documentIn(identity.did(), inboxValue(identity.did())),
      );

      expect(await adopted()).toBeUndefined();
      expect(await home.key("ensured" as never).pull()).toBe(1);
      expect(refusalsLogged()).toBe(before + 1);
    });
  });
});
