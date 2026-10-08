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
// whose handler records what it is sent: the inbox to adopt, the deciding
// profile, and the refusal, its reason and inbox. `defaultProfile` is a slot
// holding the default under `profile`, as Home's is.
const program: RuntimeProgram = {
  main: "/home.tsx",
  files: [{
    name: "/home.tsx",
    contents: `
import { type Cell, handler, pattern, Writable } from "commonfabric";

type Pointer = { piece?: Cell<{ name?: string }> };

type Named = { piece?: Cell<{ inbox?: Pointer }> };

type Refused = { reason?: string; piece?: Cell<{ name?: string }> };

const ensurePrivateInbox = handler<
  {
    adopt?: Cell<{ name?: string }>;
    from?: Cell<{ inbox?: Pointer }>;
    refused?: { reason: string; inbox: Cell<{ name?: string }> };
  },
  {
    ensured: Writable<number>;
    adopted: Writable<Pointer>;
    decidedBy: Writable<Named>;
    refused: Writable<Refused>;
  }
>((event, { ensured, adopted, decidedBy, refused }) => {
  ensured.set(ensured.get() + 1);
  adopted.set(event?.adopt === undefined ? {} : { piece: event.adopt });
  decidedBy.set(event?.from === undefined ? {} : { piece: event.from });
  refused.set(
    event?.refused === undefined
      ? {}
      : { reason: event.refused.reason, piece: event.refused.inbox },
  );
});

export default pattern(() => {
  const privateInbox = new Writable<Pointer>({}).for("privateInbox");
  const profiles = new Writable<{ inbox?: Pointer }[]>([]).for("profiles");
  const defaultProfile = new Writable<
    { profile?: Cell<{ inbox?: Pointer }> }
  >({}).for("defaultProfileSlot");
  const mru = new Writable<Cell<{ inbox?: Pointer }>[]>([]).for("mru");
  const ensured = new Writable(0).for("ensured");
  const adopted = new Writable<Pointer>({}).for("adopted");
  const decidedBy = new Writable<Named>({}).for("decidedBy");
  const refused = new Writable<Refused>({}).for("refused");
  return {
    privateInbox,
    profiles,
    defaultProfile,
    mru,
    ensured,
    adopted,
    decidedBy,
    refused,
    ensurePrivateInbox: ensurePrivateInbox({
      ensured,
      adopted,
      decidedBy,
      refused,
    }),
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

  /** Makes `profile` Home's default profile. */
  async function setDefault(profile: Cell<unknown>): Promise<void> {
    await runtime.editWithRetry((tx) =>
      home.withTx(tx).key("defaultProfile" as never).key("profile" as never)
        .set(profile as never)
    );
  }

  /** Puts `profiles` in Home's MRU list, most recent first. */
  async function listRecent(profiles: Cell<unknown>[]): Promise<void> {
    await runtime.editWithRetry((tx) =>
      home.withTx(tx).key("mru" as never).set(profiles as never)
    );
  }

  /** The profile the event Home's handler was last sent names, if any. */
  async function decidedBy(): Promise<Cell<unknown> | undefined> {
    const named = await home.key("decidedBy" as never).asSchema({
      type: "object",
      properties: { piece: { type: "unknown", asCell: ["cell"] } },
    }).pull() as { piece?: Cell<unknown> } | undefined;
    return named?.piece;
  }

  /** The inbox Home's handler was last sent to adopt, if any. */
  async function adopted(): Promise<Cell<unknown> | undefined> {
    const pointer = await home.key("adopted" as never).asSchema({
      type: "object",
      properties: { piece: { type: "unknown", asCell: ["cell"] } },
    }).pull() as { piece?: Cell<unknown> } | undefined;
    return pointer?.piece;
  }

  /**
   * The refusal the event Home's handler was last sent names, as its reason
   * and the address of the inbox refused, if any.
   */
  async function refusedSent(): Promise<
    { reason?: string; inbox?: { space: string; id: string } } | undefined
  > {
    const sent = await home.key("refused" as never).asSchema({
      type: "object",
      properties: {
        reason: { type: "string" },
        piece: { type: "unknown", asCell: ["cell"] },
      },
    }).pull() as { reason?: string; piece?: Cell<unknown> } | undefined;
    if (sent?.reason === undefined && sent?.piece === undefined) {
      return undefined;
    }
    return {
      reason: sent.reason,
      inbox: sent.piece === undefined ? undefined : addressOf(sent.piece),
    };
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
    expect(await refusedSent()).toBeUndefined();
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

  describe("which profile decides", () => {
    /** The address of the inbox Home's handler was last sent to adopt. */
    async function adoptedAddress() {
      const named = await adopted();
      return named === undefined ? undefined : addressOf(named);
    }

    /** The address of the profile the handler's last event named. */
    async function deciderAddress() {
      const decider = await decidedBy();
      return decider === undefined ? undefined : addressOf(decider);
    }

    it("decides by the default profile ahead of list order", async () => {
      const second = await usableInbox();
      const deciding = await profilePointingAt(second);
      await listProfiles([
        await profilePointingAt(await usableInbox()),
        deciding,
      ]);
      await setDefault(deciding);

      await ensure();

      expect(await adoptedAddress()).toEqual(addressOf(second));
      expect(await deciderAddress()).toEqual(addressOf(deciding));
    });

    it("decides by the most recently used profile when Home names no default", async () => {
      const second = await usableInbox();
      const recent = await profilePointingAt(second);
      await listProfiles([
        await profilePointingAt(await usableInbox()),
        recent,
      ]);
      await listRecent([recent]);

      await ensure();

      expect(await adoptedAddress()).toEqual(addressOf(second));
      expect(await deciderAddress()).toEqual(addressOf(recent));
    });

    it("decides by the default profile ahead of the most recently used one", async () => {
      const chosen = await usableInbox();
      const deciding = await profilePointingAt(chosen);
      const recent = await profilePointingAt(await usableInbox());
      await listProfiles([recent, deciding]);
      await setDefault(deciding);
      await listRecent([recent]);

      await ensure();

      expect(await adoptedAddress()).toEqual(addressOf(chosen));
      expect(await deciderAddress()).toEqual(addressOf(deciding));
    });

    it("passes over a default profile that points at no inbox, to the next in order", async () => {
      const chosen = await usableInbox();
      const unpointed = await profilePointingAt(undefined);
      const recent = await profilePointingAt(chosen);
      await listProfiles([
        unpointed,
        await profilePointingAt(await usableInbox()),
        recent,
      ]);
      await setDefault(unpointed);
      await listRecent([recent]);

      await ensure();

      expect(await adoptedAddress()).toEqual(addressOf(chosen));
      expect(await deciderAddress()).toEqual(addressOf(recent));
    });

    it("rejects, sending nothing, when a profile ordered ahead of the deciding one cannot be read", async () => {
      const unreadable = await profilePointingAt(await usableInbox());
      await listProfiles([
        unreadable,
        await profilePointingAt(await usableInbox()),
      ]);
      using _refused = stub(
        storage,
        "spaceAccessError",
        (space) =>
          space === unreadable.space ? new Error("access refused") : undefined,
      );

      await expect(ensurePrivateInboxOf(runtime, home, identity.did())).rejects
        .toThrow("Cannot read the profile that decides");
      await runtime.idle();
      expect(await home.key("ensured" as never).pull()).toBe(0);
    });
  });

  describe("profiles that do not load", () => {
    it("names no inbox when Home's list is empty", async () => {
      await listProfiles([]);

      const result = await ensure();

      expect(result).toEqual({ outcome: "none-advertised" });
      expect(await home.key("ensured" as never).pull()).toBe(1);
    });

    it("names no inbox when no entry in Home's list is a profile", async () => {
      await listProfiles([null as unknown as Cell<unknown>]);

      const result = await ensure();

      expect(result).toEqual({ outcome: "none-advertised" });
    });

    it("passes over a profile whose document is absent", async () => {
      const inbox = await usableInbox();
      const absent = runtime.getCell<unknown>(
        await runtime.createSpace({ grants: { "*": "WRITE" } }),
        crypto.randomUUID(),
      );
      await listProfiles([absent, await profilePointingAt(inbox)]);

      const result = await ensure();

      expect(
        result.outcome === "adopt" ? addressOf(result.inbox) : undefined,
      ).toEqual(addressOf(inbox));
    });

    it("decides by an earlier profile when a later one fails to load", async () => {
      const inbox = await usableInbox();
      const failing = await profilePointingAt(await usableInbox());
      await listProfiles([await profilePointingAt(inbox), failing]);
      const sync = storage.syncCell.bind(storage);
      using _failed = stub(
        storage,
        "syncCell",
        (cell, options) =>
          cell.space === failing.space
            ? Promise.reject(new Error("load failed"))
            : sync(cell, options),
      );

      const result = await ensure();

      expect(
        result.outcome === "adopt" ? addressOf(result.inbox) : undefined,
      ).toEqual(addressOf(inbox));
    });

    it("rejects, sending nothing, when an earlier profile's load is reported failed though its sync resolves", async () => {
      // A provider reports a failed load in its result, so the sync resolves
      // with no document and only the storage manager's ledger of loads says
      // it failed.
      const failing = await profilePointingAt(await usableInbox());
      await listProfiles([
        failing,
        await profilePointingAt(await usableInbox()),
      ]);
      const settled = storage.loadsSettled.bind(storage);
      using _failed = stub(
        storage,
        "loadsSettled",
        (keys) =>
          keys.some((key) => key.includes(failing.space))
            ? Promise.reject(new Error("load failed"))
            : settled(keys),
      );

      await expect(ensurePrivateInboxOf(runtime, home, identity.did())).rejects
        .toThrow("Cannot read the profile that decides");
      await runtime.idle();
      expect(await home.key("ensured" as never).pull()).toBe(0);
    });
  });

  describe("when Home holds an inbox", () => {
    /** Has Home hold `inbox` as its private inbox. */
    async function hold(inbox: Cell<unknown>): Promise<void> {
      await runtime.editWithRetry((tx) =>
        home.withTx(tx).key("privateInbox" as never).set(
          { piece: inbox } as never,
        )
      );
    }

    it("names no inbox when the deciding profile advertises the held one, though a later profile advertises another", async () => {
      const held = await usableInbox();
      await hold(held);
      await listProfiles([
        await profilePointingAt(held),
        await profilePointingAt(await usableInbox()),
      ]);

      const result = await ensure();

      expect(result.outcome).toBe("held");
      expect(await adopted()).toBeUndefined();
    });

    it("names the deciding profile, and no inbox or refusal, when it advertises the held inbox", async () => {
      const held = await usableInbox();
      await hold(held);
      const deciding = await profilePointingAt(held);
      await listProfiles([deciding, await profilePointingAt(undefined)]);

      const result = await ensure();

      expect(result.outcome).toBe("held");
      expect(
        result.outcome === "held" && result.profile !== undefined
          ? addressOf(result.profile)
          : undefined,
      ).toEqual(addressOf(deciding));
      const decider = await decidedBy();
      expect(decider === undefined ? undefined : addressOf(decider)).toEqual(
        addressOf(deciding),
      );
      expect(await adopted()).toBeUndefined();
      expect(await refusedSent()).toBeUndefined();
    });

    it("names the deciding profile's inbox, though a later profile advertises the held one", async () => {
      const held = await usableInbox();
      await hold(held);
      const other = await usableInbox();
      const deciding = await profilePointingAt(other);
      await listProfiles([deciding, await profilePointingAt(held)]);

      const result = await ensure();

      expect(result.outcome).toBe("adopt");
      const named = await adopted();
      expect(named === undefined ? undefined : addressOf(named)).toEqual(
        addressOf(other),
      );
      const decider = await decidedBy();
      expect(decider === undefined ? undefined : addressOf(decider)).toEqual(
        addressOf(deciding),
      );
    });

    it("names no inbox when the deciding profile advertises the held one through another link to it", async () => {
      const held = await usableInbox();
      await hold(await documentIn(identity.did(), held));
      await listProfiles([
        await profilePointingAt(held),
        await profilePointingAt(await usableInbox()),
      ]);

      const result = await ensure();

      expect(result.outcome).toBe("held");
      expect(await adopted()).toBeUndefined();
    });

    it("names no inbox when no profile advertises one", async () => {
      await hold(await usableInbox());
      await listProfiles([await profilePointingAt(undefined)]);

      const result = await ensure();

      expect(result).toEqual({ outcome: "held" });
      expect(result).not.toHaveProperty("profile");
      expect(await adopted()).toBeUndefined();
      expect(await decidedBy()).toBeUndefined();
      expect(await home.key("ensured" as never).pull()).toBe(1);
    });

    it("names the inbox the first advertising profile points at when it is not the held one", async () => {
      await hold(await usableInbox());
      const first = await usableInbox();
      await listProfiles([
        await profilePointingAt(undefined),
        await profilePointingAt(first),
        await profilePointingAt(await usableInbox()),
      ]);

      const result = await ensure();

      expect(result.outcome).toBe("adopt");
      const named = await adopted();
      expect(named === undefined ? undefined : addressOf(named)).toEqual(
        addressOf(first),
      );
    });

    it("names no inbox, and logs the refusal, when the advertised one fails vetting", async () => {
      await hold(await usableInbox());
      const space = await runtime.createSpace({
        owner: someoneElse,
        grants: { "*": "WRITE" },
      });
      await listProfiles([
        await profilePointingAt(await documentIn(space, inboxValue(space))),
      ]);
      const before = refusalsLogged();

      const result = await ensure();

      expect(result.outcome === "refused" && result.reason).toBe(
        "inbox-adoption-acl-mismatch",
      );
      expect(await adopted()).toBeUndefined();
      expect(await home.key("ensured" as never).pull()).toBe(1);
      expect(refusalsLogged()).toBe(before + 1);
    });
  });

  it("sends nothing, and returns `abandoned`, once its signal has aborted", async () => {
    await listProfiles([await profilePointingAt(await usableInbox())]);
    const stopped = new AbortController();
    stopped.abort();

    const result = await ensurePrivateInboxOf(
      runtime,
      home,
      identity.did(),
      stopped.signal,
    );
    await runtime.idle();

    expect(result).toEqual({ outcome: "abandoned" });
    expect(await home.key("ensured" as never).pull()).toBe(0);
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

    it("names the refusal, with its reason and the refused inbox, and the deciding profile, for Home to record", async () => {
      const space = await runtime.createSpace({
        owner: someoneElse,
        grants: { "*": "WRITE" },
      });
      const inbox = await documentIn(space, inboxValue(space));
      const profile = await profilePointingAt(inbox);

      await ensureOver(inbox, profile);

      expect(await refusedSent()).toEqual({
        reason: "inbox-adoption-acl-mismatch",
        inbox: addressOf(inbox),
      });
      const decider = await decidedBy();
      expect(decider === undefined ? undefined : addressOf(decider)).toEqual(
        addressOf(profile),
      );
      expect(await adopted()).toBeUndefined();
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
