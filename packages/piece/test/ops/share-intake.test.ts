import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { createSession, Identity } from "@commonfabric/identity";
import type { ACL } from "@commonfabric/memory/acl";
import {
  type Cell,
  type MemorySpace,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import {
  type ShareIntake,
  startShareIntakeOf,
} from "../../src/ops/share-intake.ts";

const identity = await Identity.fromPassphrase("share intake owner");

/** The principal the offers name as their sender. */
const sender = (await Identity.fromPassphrase("share intake sender")).did();

/** A principal who is neither the owner nor the sender. */
const someoneElse = (await Identity.fromPassphrase("share intake other")).did();

/** The origin of the host the test's runtime is served by. */
const HOST = "https://home.example";

// A Home pattern reduced to what the intake reads and the stream it sends,
// whose `registerSharedSpace` records each event it is sent.
const program: RuntimeProgram = {
  main: "/home.tsx",
  files: [{
    name: "/home.tsx",
    contents: `
import { type Cell, handler, pattern, Writable } from "commonfabric";

type Pointer = { piece?: Cell<{ name?: string }> };

type Catalog = {
  entries: Record<string, unknown>;
  offers: Record<string, unknown>;
};

type Registration = {
  space: string;
  host: string;
  kind: string;
  title?: string;
  offer?: { from: string; id: string };
};

const registerSharedSpace = handler<
  Registration,
  { registered: Writable<Registration[]> }
>((event, { registered }) => {
  registered.push(event);
});

export default pattern(() => {
  const privateInbox = new Writable<Pointer>({}).for("privateInbox");
  const retainedPrivateInboxes = new Writable<Cell<{ name?: string }>[]>([])
    .for("retainedPrivateInboxes");
  const sharedSpaceCatalog = new Writable<Catalog>({ entries: {}, offers: {} })
    .for("sharedSpaceCatalog");
  const registered = new Writable<Registration[]>([]).for("registered");
  return {
    privateInbox,
    retainedPrivateInboxes,
    sharedSpaceCatalog,
    registered,
    registerSharedSpace: registerSharedSpace({ registered }),
  };
});`,
  }],
};

/** An offer as an inbox holds it, which a test varies field by field. */
type Row = Record<string, unknown>;

/** What Home's stand-in records of each registration it is sent. */
const registeredSchema = {
  type: "array",
  items: { type: "object", additionalProperties: true },
} as const;

describe("share-intake", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;
  let home: Cell<unknown>;
  let inbox: Cell<unknown>;
  let intake: ShareIntake | undefined;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: identity });
    runtime = new Runtime({
      apiUrl: new URL(HOST),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    controller = new PiecesController(
      createSession({ identity, spaceDid: identity.did() }),
      runtime,
    );
    await controller.synced();
    home = (await controller.recreateDefaultPattern({ customProgram: program }))
      .getCell();
    inbox = await inboxIn(
      await runtime.createSpace({ grants: { "*": "WRITE" } }),
    );
    await runtime.editWithRetry((tx) =>
      home.withTx(tx).key("privateInbox" as never).set(
        { piece: inbox } as never,
      )
    );
    await runtime.idle();
  });

  afterEach(async () => {
    intake?.stop();
    intake = undefined;
    await controller.dispose();
    await storage.close();
  });

  /** An inbox in `space`, holding no offers. */
  async function inboxIn(space: MemorySpace): Promise<Cell<unknown>> {
    const cell = runtime.getCell<unknown>(space, crypto.randomUUID());
    await runtime.editWithRetry((tx) =>
      cell.withTx(tx).set({ offers: [] } as never)
    );
    return cell;
  }

  /**
   * A space granting `grants`, owned by the owner unless `owner` says
   * otherwise, whose space cell links a root in it unless `root` is false.
   */
  async function offeredSpace(
    grants: ACL,
    { owner, root = true }: { owner?: string; root?: boolean } = {},
  ): Promise<MemorySpace> {
    const space = await runtime.createSpace({
      grants,
      ...(owner === undefined ? {} : { owner: owner as never }),
    });
    if (root) {
      const piece = runtime.getCell<unknown>(space, crypto.randomUUID());
      await runtime.editWithRetry((tx) => {
        piece.withTx(tx).set({ name: "Room" } as never);
        runtime.getSpaceCell(space).withTx(tx).key("defaultPattern").set(
          piece as never,
        );
      });
    }
    return space;
  }

  /** An offer of `space` from the sender, with `fields` replacing its own. */
  function offerOf(space: MemorySpace, id: string, fields: Row = {}): Row {
    return {
      kind: "fabrichat-room",
      id,
      space,
      host: HOST,
      ownerOrigin: HOST,
      title: `Room ${id}`,
      from: sender,
      sharedAt: 1_700_000_000_000,
      receivedAt: 1_700_000_000_000,
      ...fields,
    };
  }

  /** Appends `rows` to the offers `target` holds, the private inbox by default. */
  async function deliver(rows: Row[], target = inbox): Promise<void> {
    await runtime.editWithRetry((tx) => {
      const offers = target.withTx(tx).key("offers" as never);
      offers.set([...(offers.get() as Row[] ?? []), ...rows] as never);
    });
  }

  /** Starts the intake over Home. */
  function start(signal?: AbortSignal): ShareIntake {
    intake = startShareIntakeOf(runtime, home, identity.did(), signal);
    if (intake === undefined) throw new Error("Home has no stream");
    return intake;
  }

  /**
   * What Home's `registerSharedSpace` has been sent, once it holds `id`. Each
   * read is a `pull()` the cell's sink wakes, since a `get()` there can read
   * the list as it was before the handler's push.
   */
  async function registeredThrough(id: string): Promise<Row[]> {
    const cell = home.key("registered" as never).asSchema(registeredSchema);
    let changed = Promise.withResolvers<void>();
    const cancel = cell.sink(() => {
      changed.resolve();
      changed = Promise.withResolvers<void>();
    });
    try {
      while (true) {
        const next = changed.promise;
        const rows = (await cell.pull() ?? []) as Row[];
        if (rows.some((each) => (each.offer as Row | undefined)?.id === id)) {
          return rows;
        }
        await next;
      }
    } finally {
      cancel();
    }
  }

  /** The ids of the offers Home's `registerSharedSpace` has been sent. */
  function registeredIds(rows: Row[]): unknown[] {
    return rows.map((each) => (each.offer as Row | undefined)?.id);
  }

  /** How many refusals the intake has logged. */
  function refusalsLogged(): number {
    return getLoggerCountsBreakdown()["piece.share-intake"]
      ?.["offer-refused"]?.warn ?? 0;
  }

  /**
   * Delivers `refused`, then an offer that passes, and waits for the second to
   * be registered, which happens only after the first is decided, since the
   * intake decides an inbox's offers in order. Returns what was registered.
   */
  async function deliverThenBarrier(refused: Row): Promise<Row[]> {
    const space = await offeredSpace({ [sender]: "WRITE" });
    await deliver([refused, offerOf(space, "barrier")]);
    return await registeredThrough("barrier");
  }

  describe("startShareIntakeOf()", () => {
    it("returns `undefined` for a Home without a `registerSharedSpace` stream", () => {
      // The inbox document stands in for a Home holding no such stream.
      expect(startShareIntakeOf(runtime, inbox, identity.did()))
        .toBeUndefined();
    });
  });

  describe("an offer that passes vetting", () => {
    it("is registered with its sender, `id`, `kind`, `host` and `title`", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });
      start();
      await deliver([offerOf(space, "first")]);

      expect(await registeredThrough("first")).toEqual([{
        space,
        host: HOST,
        kind: "fabrichat-room",
        title: "Room first",
        offer: { from: sender, id: "first" },
      }]);
    });

    it("is registered without a `title` when its title is empty", async () => {
      const space = await offeredSpace({ [sender]: "OWNER" });
      start();
      await deliver([offerOf(space, "untitled", { title: "" })]);

      const [registered] = await registeredThrough("untitled");
      expect(registered).toEqual({
        space,
        host: HOST,
        kind: "fabrichat-room",
        offer: { from: sender, id: "untitled" },
      });
    });

    it("is registered when it was in the inbox before the intake started", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });
      await deliver([offerOf(space, "waiting")]);
      start();

      expect(registeredIds(await registeredThrough("waiting"))).toEqual([
        "waiting",
      ]);
    });

    it("is registered when it arrives after earlier ones were taken up", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });
      start();
      await deliver([offerOf(space, "earlier")]);
      await registeredThrough("earlier");
      await deliver([offerOf(space, "later")]);

      expect(registeredIds(await registeredThrough("later"))).toEqual([
        "earlier",
        "later",
      ]);
    });

    it("is registered from an inbox Home retains", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });
      const retained = await inboxIn(
        await runtime.createSpace({ grants: { "*": "WRITE" } }),
      );
      await runtime.editWithRetry((tx) =>
        home.withTx(tx).key("retainedPrivateInboxes" as never).set(
          [retained] as never,
        )
      );
      start();
      await deliver([offerOf(space, "retained")], retained);

      expect(registeredIds(await registeredThrough("retained"))).toEqual([
        "retained",
      ]);
    });

    it("is registered from an inbox Home comes to hold after the intake started", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });
      const adopted = await inboxIn(
        await runtime.createSpace({ grants: { "*": "WRITE" } }),
      );
      await deliver([offerOf(space, "adopted")], adopted);
      start();
      await runtime.editWithRetry((tx) =>
        home.withTx(tx).key("privateInbox" as never).set(
          { piece: adopted } as never,
        )
      );

      expect(registeredIds(await registeredThrough("adopted"))).toEqual([
        "adopted",
      ]);
    });

    it("is sent once, though the inbox changes again after it", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });
      start();
      await deliver([offerOf(space, "once")]);
      await registeredThrough("once");
      await deliver([offerOf(space, "after")]);

      expect(registeredIds(await registeredThrough("after"))).toEqual([
        "once",
        "after",
      ]);
    });
  });

  describe("an offer that is skipped", () => {
    it("is not registered, nor logged, when its `kind` is `loom`", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });
      start();
      const before = refusalsLogged();

      const registered = await deliverThenBarrier(
        offerOf(space, "loom", { kind: "loom" }),
      );

      expect(registeredIds(registered)).toEqual(["barrier"]);
      expect(refusalsLogged()).toBe(before);
    });

    it("is not registered, nor logged, when the catalog holds its receipt", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });
      await runtime.editWithRetry((tx) =>
        home.withTx(tx).key("sharedSpaceCatalog" as never).key(
          "offers" as never,
        ).set({
          [JSON.stringify([sender, "received"])]: {
            from: sender,
            id: "received",
            space,
            host: HOST,
            kind: "fabrichat-room",
          },
        } as never)
      );
      const intake = start();
      const before = refusalsLogged();

      const registered = await deliverThenBarrier(offerOf(space, "received"));

      expect(registeredIds(registered)).toEqual(["barrier"]);
      expect(refusalsLogged()).toBe(before);
      expect(
        intake.accessForTestingOnly.decided.get(
          JSON.stringify([sender, "received"]),
        ),
      ).toBe("received");
    });
  });

  describe("an offer that is refused", () => {
    // Each case delivers the refused offer ahead of one that passes, and
    // reads what was registered once the second is: the intake decides an
    // inbox's offers in order, so the first was decided by then.

    /**
     * Delivers `refused`, and returns what was registered and logged, and what
     * the intake decided about it.
     */
    async function refuse(refused: Row) {
      const intake = start();
      const before = refusalsLogged();
      const registered = await deliverThenBarrier(refused);
      return {
        ids: registeredIds(registered),
        logged: refusalsLogged() - before,
        decision: intake.accessForTestingOnly.decided.get(
          JSON.stringify([refused.from, refused.id]),
        ),
      };
    }

    it("is not registered, and is logged, when `space` is not a DID", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });

      expect(await refuse(offerOf(space, "bad space", { space: "room" })))
        .toEqual({
          ids: ["barrier"],
          logged: 1,
          decision: "offer-malformed",
        });
    });

    it("is not registered, and is logged, when `host` is not its own origin", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });

      expect(
        await refuse(offerOf(space, "bad host", { host: `${HOST}/path` })),
      ).toEqual({
        ids: ["barrier"],
        logged: 1,
        decision: "offer-malformed",
      });
    });

    it("is not registered, and is logged, when `ownerOrigin` is neither empty nor an origin", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });

      expect(
        await refuse(
          offerOf(space, "bad owner origin", { ownerOrigin: "elsewhere" }),
        ),
      ).toEqual({
        ids: ["barrier"],
        logged: 1,
        decision: "offer-malformed",
      });
    });

    it("is not registered, and is logged, when its `title` is longer than the inbox keeps", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });

      expect(
        await refuse(offerOf(space, "long title", { title: "x".repeat(201) })),
      ).toEqual({
        ids: ["barrier"],
        logged: 1,
        decision: "offer-malformed",
      });
    });

    it("is not registered, and is logged, when its `host` is another host's", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });

      expect(
        await refuse(
          offerOf(space, "foreign", { host: "https://elsewhere.example" }),
        ),
      ).toEqual({
        ids: ["barrier"],
        logged: 1,
        decision: "offer-foreign-host",
      });
    });

    it("is not registered, and is logged, when `from` holds only the grant to every principal", async () => {
      const space = await offeredSpace({ "*": "WRITE" });

      expect(await refuse(offerOf(space, "everyone"))).toEqual({
        ids: ["barrier"],
        logged: 1,
        decision: "sender-not-member",
      });
    });

    it("is not registered, and is logged, when `from` holds only `READ`", async () => {
      const space = await offeredSpace({ [sender]: "READ" });

      expect(await refuse(offerOf(space, "reader"))).toEqual({
        ids: ["barrier"],
        logged: 1,
        decision: "sender-not-member",
      });
    });

    it("is not registered, and is logged, when `from` is absent from the access list", async () => {
      const space = await offeredSpace({ [someoneElse]: "WRITE" });

      expect(await refuse(offerOf(space, "absent"))).toEqual({
        ids: ["barrier"],
        logged: 1,
        decision: "sender-not-member",
      });
    });

    it("is not registered, and is logged, when the access list grants the owner nothing", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" }, {
        owner: someoneElse,
      });

      expect(await refuse(offerOf(space, "ungranted"))).toEqual({
        ids: ["barrier"],
        logged: 1,
        decision: "recipient-access-refused",
      });
    });

    it("is not registered, and is logged, when the owner is refused access to the space", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });
      using _refused = stub(
        storage,
        "spaceAccessError",
        (each) => each === space ? new Error("access refused") : undefined,
      );

      expect(await refuse(offerOf(space, "refused"))).toEqual({
        ids: ["barrier"],
        logged: 1,
        decision: "recipient-access-refused",
      });
    });

    it("is not registered, and is logged, when the space has no root", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" }, { root: false });

      expect(await refuse(offerOf(space, "rootless"))).toEqual({
        ids: ["barrier"],
        logged: 1,
        decision: "space-root-missing",
      });
    });

    it("is logged once, though the inbox changes again after it", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });
      const refused = await offeredSpace({ "*": "WRITE" });
      start();
      const before = refusalsLogged();
      await deliver([offerOf(refused, "refused once")]);
      await deliver([offerOf(space, "first barrier")]);
      await registeredThrough("first barrier");
      await deliver([offerOf(space, "second barrier")]);
      await registeredThrough("second barrier");

      expect(refusalsLogged() - before).toBe(1);
    });
  });

  describe("stopping", () => {
    it("sends nothing for an offer arriving once its signal has aborted", async () => {
      const space = await offeredSpace({ [sender]: "WRITE" });
      const abort = new AbortController();
      const started = start(abort.signal);
      await started.idle();
      abort.abort();
      await deliver([offerOf(space, "too late")]);
      await runtime.idle();
      await started.idle();

      expect(
        await home.key("registered" as never).asSchema(registeredSchema).pull(),
      ).toEqual([]);
    });
  });
});
