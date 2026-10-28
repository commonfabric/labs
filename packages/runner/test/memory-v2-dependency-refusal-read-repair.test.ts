import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import type { Cell } from "../src/cell.ts";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("dependency refusal read repair");
const space = signer.did();
const listSchema = { type: "array", items: { type: "string" } } as const;
const cardSchema = { type: "string" } as const;

type Session = { storage: EmulatedStorageManager; runtime: Runtime };

/** A commit held at the server's door until the test releases it. */
type Door = {
  held: Promise<void>;
  release: () => void;
};

describe("memory-v2-dependency-refusal-read-repair", () => {
  // Two runtimes share a list. The second runtime's tail append is refused
  // for its stale read once the first runtime's differing tail lands, and a
  // commit that read the list through that append's layer is refused with
  // it, for the dependency rather than for any read of its own. A document
  // the dependent commit created, which the first runtime had already
  // written to the store, is held at the store's copy once the refusal
  // settles, whichever side pronounces it.

  let server: MemoryV2Server.Server;
  let verdicts: { name: string; message: string }[];
  let verdictWaiters: { count: number; arrived: PromiseWithResolvers<void> }[];
  // The next commit on each of these document ids waits at the server's
  // door until the test releases it: the window a slow verdict leaves open.
  let doors: Map<string, Door & { open: PromiseWithResolvers<void> }>;
  let openers: PromiseWithResolvers<void>[];
  const sessions: Session[] = [];

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    verdicts = [];
    verdictWaiters = [];
    doors = new Map();
    openers = [];
    const transact = server.transact.bind(server);
    server.transact = async (...args: Parameters<typeof transact>) => {
      const [message] = args;
      for (const op of message.commit.operations) {
        if (!("id" in op)) continue;
        const door = doors.get(op.id);
        if (door === undefined) continue;
        // A door holds the first commit that reaches it and no other.
        doors.delete(op.id);
        door.release();
        await door.open.promise;
      }
      const response = await transact(...args);
      verdicts.push(
        response.error
          ? { name: response.error.name, message: response.error.message }
          : { name: "ok", message: "" },
      );
      for (const waiter of verdictWaiters.splice(0)) {
        if (verdicts.length >= waiter.count) waiter.arrived.resolve();
        else verdictWaiters.push(waiter);
      }
      return response;
    };
  });

  afterEach(async () => {
    for (const opener of openers.splice(0)) opener.resolve();
    await server.flushSessions([space]);
    await clock.settle();
    for (const session of sessions.splice(0)) {
      await session.runtime.dispose();
      await session.storage.close();
    }
    await server.close();
  });

  const connect = (): Session => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const session = { storage, runtime };
    sessions.push(session);
    return session;
  };

  const holdAtDoor = (id: URI): Door => {
    const arrived = Promise.withResolvers<void>();
    const open = Promise.withResolvers<void>();
    openers.push(open);
    doors.set(id, {
      held: arrived.promise,
      release: () => arrived.resolve(),
      open,
    });
    return { held: arrived.promise, release: () => open.resolve() };
  };

  /** Resolves once the server has pronounced `count` verdicts in all. */
  const pronounced = (count: number): Promise<void> => {
    if (verdicts.length >= count) return Promise.resolve();
    const arrived = Promise.withResolvers<void>();
    verdictWaiters.push({ count, arrived });
    return arrived.promise;
  };

  const flush = async () => {
    await server.flushSessions([space]);
    await clock.settle();
  };

  const committed = async (tx: ReturnType<Runtime["edit"]>) => {
    expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
      .toBeUndefined();
  };

  const seedList = async (session: Session, doc: string, value: string[]) => {
    await session.runtime.getCell(space, doc, listSchema).sync();
    const tx = session.runtime.edit();
    session.runtime.getCell(space, doc, listSchema, tx).set(value);
    await committed(tx);
  };

  const seedCard = async (session: Session, doc: string, value: string) => {
    await session.runtime.getCell(space, doc, cardSchema).sync();
    const tx = session.runtime.edit();
    session.runtime.getCell(space, doc, cardSchema, tx).set(value);
    await committed(tx);
  };

  const append = (session: Session, doc: string, item: string) => {
    const tx = session.runtime.edit();
    const cell = session.runtime.getCell(space, doc, listSchema, tx);
    cell.set([...(cell.get() as string[]), item]);
    return tx.commit({ holdSyncedUntilCovered: false }).verdict;
  };

  const watched = async (session: Session, doc: string) => {
    const list = session.runtime.getCell(space, doc, listSchema);
    await list.sync();
    await flush();
    await session.storage.synced();
    return list;
  };

  const idOf = (cell: Cell): URI => cell.getAsNormalizedFullLink().id;

  /**
   * Seeds the list and the card from the first runtime, watches the list from
   * the second, and starts the second's tail append, held at the server's
   * door. Returns what the dependent commit builds on.
   */
  const setUp = async (list: string, card: string) => {
    const a = connect();
    const b = connect();
    await seedList(a, list, ["e1", "e2"]);
    await seedCard(a, card, "host");
    const bList = await watched(b, list);
    // Never read through a cell before the refusal settles: a cell read of a
    // document the replica never synced starts a load of its own.
    const bCard = b.runtime.getCell(space, card, cardSchema);
    const cardId = idOf(bCard);
    expect(storedCard(b, cardId)).toBeUndefined();

    const tailDoor = holdAtDoor(idOf(bList));
    const tail = append(b, list, "e3");
    await tailDoor.held;
    expect(bList.get()).toEqual(["e1", "e2", "e3"]);
    return { a, b, bList, bCard, cardId, tail, tailDoor };
  };

  /** The card as the session's replica holds it, read without a load. */
  const storedCard = (session: Session, cardId: URI): unknown =>
    session.storage.open(space).replica.getDocument(cardId)?.value;

  /**
   * Starts a commit of `session` that reads the list through its pending
   * tail and writes the card blind, never having loaded it. Returns the
   * commit's settlement, which follows its read repair; its verdict alone
   * precedes the repair.
   */
  const createCard = (session: Session, list: string, bCard: Cell) => {
    const tx = session.runtime.edit();
    expect(session.runtime.getCell(space, list, listSchema, tx).get())
      .toEqual(["e1", "e2", "e3"]);
    tx.writeOrThrow(
      { ...toMemorySpaceAddress(bCard.getAsNormalizedFullLink()), path: [] },
      { value: "guest" },
    );
    return tx.commit({ holdSyncedUntilCovered: false }).settled;
  };

  it("holds a document the server-refused dependent commit created at the store's copy", async () => {
    // The dependent commit's write of the card is blind, so the server finds
    // nothing stale in the commit's own reads and refuses it for the tail it
    // sits on, which has no verdict yet.
    const list = "server-list";
    const card = "server-card";
    const { a, b, bList, bCard, cardId, tail, tailDoor } = await setUp(
      list,
      card,
    );
    const dependentSettled = createCard(b, list, bCard);
    expect(storedCard(b, cardId)).toBe("guest");

    expect((await append(a, list, "x")).error).toBeUndefined();
    tailDoor.release();
    // The tail's refusal, then the dependent's.
    await pronounced(5);
    await flush();
    expect((await tail).error?.name).toBe("ConflictError");
    const refusal = (await dependentSettled).error;
    expect(refusal?.name).toBe("ConflictError");
    expect(refusal?.message).toMatch(/^pending dependency not resolved/);
    expect(storedCard(b, cardId)).toBe("host");

    await flush();
    await b.runtime.idle();
    expect(bList.get()).toEqual(["e1", "e2", "x"]);
    expect(storedCard(b, cardId)).toBe("host");
    expect(verdicts.map((verdict) => verdict.name)).toEqual([
      "ok",
      "ok",
      "ok",
      "ConflictError",
      "ConflictError",
    ]);
  });

  it("holds a document the locally refused dependent commit created at the store's copy", async () => {
    // The dependent commit is minted after the tail's refusal has reached
    // the replica and before the tail's layer is dropped, so the replica
    // refuses it itself, before it reaches the wire.
    const list = "local-list";
    const card = "local-card";
    const { a, b, bList, bCard, cardId, tail, tailDoor } = await setUp(
      list,
      card,
    );

    expect((await append(a, list, "x")).error).toBeUndefined();
    tailDoor.release();
    await pronounced(4);
    // The refusal reaches the replica; its layer stands until the read
    // repair below.
    await clock.settle();
    expect(bList.get()).toEqual(["e1", "e2", "e3"]);
    const dependentSettled = createCard(b, list, bCard);
    expect(storedCard(b, cardId)).toBe("guest");

    await flush();
    expect((await tail).error?.name).toBe("ConflictError");
    const refusal = (await dependentSettled).error;
    expect(refusal?.name).toBe("ConflictError");
    expect(refusal?.message).toMatch(/^pending dependency rejected/);
    expect(storedCard(b, cardId)).toBe("host");

    await flush();
    await b.runtime.idle();
    expect(bList.get()).toEqual(["e1", "e2", "x"]);
    expect(storedCard(b, cardId)).toBe("host");
    expect(verdicts.map((verdict) => verdict.name)).toEqual([
      "ok",
      "ok",
      "ok",
      "ConflictError",
    ]);
  });
});
