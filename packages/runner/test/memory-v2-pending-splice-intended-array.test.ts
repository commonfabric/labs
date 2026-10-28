import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("pending splice intended array");
const space = signer.did();
const listSchema = { type: "array", items: { type: "string" } } as const;

type Session = { storage: EmulatedStorageManager; runtime: Runtime };

const snapshot = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value ?? null));

describe("memory-v2-pending-splice-intended-array", () => {
  // Two runtimes grow one list. Each writes a tail splice at the list's old
  // length; when the other's write lands first and its frame arrives while
  // this one's splice awaits its verdict, the view shows the array this
  // runtime computed, not the splice replayed over the grown array.

  let server: MemoryV2Server.Server;
  let verdicts: string[];
  // Commits on these document ids wait at the server's door until the test
  // releases them: the window a slow verdict leaves open.
  let heldIds: Set<string>;
  let held: PromiseWithResolvers<void>;
  let release: PromiseWithResolvers<void>;
  const sessions: Session[] = [];

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    verdicts = [];
    heldIds = new Set();
    held = Promise.withResolvers<void>();
    release = Promise.withResolvers<void>();
    const transact = server.transact.bind(server);
    server.transact = async (...args: Parameters<typeof transact>) => {
      const [message] = args;
      if (
        message.commit.operations.some((op) => "id" in op && heldIds.has(op.id))
      ) {
        held.resolve();
        await release.promise;
      }
      const response = await transact(...args);
      verdicts.push(response.error ? response.error.name : "ok");
      return response;
    };
  });

  afterEach(async () => {
    release.resolve();
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

  const flush = async () => {
    await server.flushSessions([space]);
    await clock.settle();
  };

  const seed = async (session: Session, doc: string, value: string[]) => {
    await session.runtime.getCell(space, doc, listSchema).sync();
    const tx = session.runtime.edit();
    session.runtime.getCell(space, doc, listSchema, tx).set(value);
    expect((await tx.commit({ holdSyncedUntilCovered: false }).verdict).error)
      .toBeUndefined();
  };

  const append = (session: Session, doc: string, item: string) => {
    const tx = session.runtime.edit();
    const cell = session.runtime.getCell(space, doc, listSchema, tx);
    cell.set([...(cell.get() as string[]), item]);
    return tx.commit({ holdSyncedUntilCovered: false }).verdict;
  };

  const errorNameOf = (verdict: { error?: { name?: string } }) =>
    verdict.error?.name;

  const watched = async (session: Session, doc: string) => {
    const list = session.runtime.getCell(space, doc, listSchema);
    await list.sync();
    await flush();
    await session.storage.synced();
    const seen: unknown[] = [];
    const cancel = list.sink((value) => {
      seen.push(snapshot(value));
    });
    return { list, seen, cancel };
  };

  it("shows the list as it is while the other session's identical tail lands first, and the store accepts the splice as an identity", async () => {
    // The splice reaches the stored list from the view that produced it, so
    // the server accepts it as an identity and writes nothing; the layer
    // promotes to the list its transaction computed, which is the stored
    // list, rather than landing its element a second time.
    const doc = "intended-identical";
    const a = connect();
    const b = connect();
    await seed(a, doc, ["e1", "e2"]);
    const { list, seen, cancel } = await watched(b, doc);

    heldIds.add(list.getAsNormalizedFullLink().id);
    const bVerdict = append(b, doc, "e3");
    await held.promise;
    expect(list.get()).toEqual(["e1", "e2", "e3"]);

    heldIds.clear();
    expect((await append(a, doc, "e3")).error).toBeUndefined();
    await flush();
    expect(list.get()).toEqual(["e1", "e2", "e3"]);

    release.resolve();
    expect((await bVerdict).error).toBeUndefined();
    await flush();
    await b.runtime.idle();
    cancel();

    expect(list.get()).toEqual(["e1", "e2", "e3"]);
    expect(seen.filter((value) => Array.isArray(value) && value.length > 3))
      .toEqual([]);
    expect(verdicts).toEqual(["ok", "ok", "ok"]);
  });

  it("shows the list it computed, then the store's, when the other session's tail differs", async () => {
    // The view never shows the foreign tail with this session's appended
    // after it: that list no writer wrote.
    const doc = "intended-differs";
    const a = connect();
    const b = connect();
    await seed(a, doc, ["e1", "e2"]);
    const { list, seen, cancel } = await watched(b, doc);

    heldIds.add(list.getAsNormalizedFullLink().id);
    const bVerdict = append(b, doc, "e3");
    await held.promise;

    heldIds.clear();
    expect((await append(a, doc, "x")).error).toBeUndefined();
    await flush();
    expect(list.get()).toEqual(["e1", "e2", "e3"]);

    release.resolve();
    expect(errorNameOf(await bVerdict)).toBe("ConflictError");
    await flush();
    await b.runtime.idle();
    cancel();

    expect(list.get()).toEqual(["e1", "e2", "x"]);
    expect(
      seen.filter((value) =>
        Array.isArray(value) && value.includes("x") && value.includes("e3")
      ),
    ).toEqual([]);
  });

  it("replays a splice its commit read nothing for where it stands, so a reader of it commits what the store will hold", async () => {
    // A blind write of one element carries no read of the array, so the
    // store applies its splice wherever the array then stands. The view
    // replays it the same way: a transaction that reads the list through
    // the pending layer and commits its length is accepted against the
    // layer's durable contribution, and the two must agree.
    const doc = "intended-blind";
    const a = connect();
    const b = connect();
    await seed(a, doc, ["e1", "e2"]);
    const { list, cancel } = await watched(b, doc);
    const count = b.runtime.getCell<number>(space, "intended-blind-count", {
      type: "number",
    });
    await count.sync();
    await flush();

    heldIds.add(list.getAsNormalizedFullLink().id);
    const blind = b.runtime.edit();
    const address = toMemorySpaceAddress(list.getAsNormalizedFullLink());
    blind.writeOrThrow({ ...address, path: ["value", "2"] }, "e3");
    const blindVerdict = blind.commit({ holdSyncedUntilCovered: false })
      .verdict;
    await held.promise;

    heldIds.clear();
    expect((await append(a, doc, "x")).error).toBeUndefined();
    await flush();
    expect(list.get()).toEqual(["e1", "e2", "e3", "x"]);

    const dependent = b.runtime.edit();
    const observed = b.runtime.getCell<string[]>(
      space,
      doc,
      listSchema,
      dependent,
    )
      .get();
    count.withTx(dependent).set(observed.length);
    const dependentVerdict = dependent.commit({ holdSyncedUntilCovered: false })
      .verdict;

    release.resolve();
    expect((await blindVerdict).error).toBeUndefined();
    expect((await dependentVerdict).error).toBeUndefined();
    await flush();
    await b.storage.synced();
    cancel();

    expect(list.get()).toEqual(["e1", "e2", "e3", "x"]);
    expect(count.get()).toBe(4);
  });

  // A read that does not cover the array's values does not justify showing
  // the computed array in a splice's place: the store applies the splice
  // where it stands over a peer's in-place change the read never saw, and a
  // reader of the layer must observe what the store will hold.
  const persistedJoinAfterPeerReplaces = async (
    doc: string,
    readBeforeWriting: (
      list: ReturnType<Runtime["getCell"]>,
      tx: ReturnType<Runtime["edit"]>,
    ) => void,
  ) => {
    const a = connect();
    const b = connect();
    await seed(a, doc, ["e1", "e2"]);
    const { list, cancel } = await watched(b, doc);
    const joined = b.runtime.getCell<string>(space, `${doc}-joined`, {
      type: "string",
    });
    await joined.sync();
    await flush();

    heldIds.add(list.getAsNormalizedFullLink().id);
    const writer = b.runtime.edit();
    readBeforeWriting(list, writer);
    const address = toMemorySpaceAddress(list.getAsNormalizedFullLink());
    writer.writeOrThrow({ ...address, path: ["value", "2"] }, "e3");
    const writerVerdict = writer.commit({ holdSyncedUntilCovered: false })
      .verdict;
    await held.promise;

    heldIds.clear();
    const replace = a.runtime.edit();
    a.runtime.getCell(space, doc, listSchema, replace).key(1).set("x");
    expect(
      (await replace.commit({ holdSyncedUntilCovered: false }).verdict).error,
    )
      .toBeUndefined();
    await flush();
    expect(list.get()).toEqual(["e1", "x", "e3"]);

    const dependent = b.runtime.edit();
    const observed = b.runtime.getCell<string[]>(
      space,
      doc,
      listSchema,
      dependent,
    )
      .get();
    joined.withTx(dependent).set(observed.join("|"));
    const dependentVerdict = dependent.commit({ holdSyncedUntilCovered: false })
      .verdict;

    release.resolve();
    expect((await writerVerdict).error).toBeUndefined();
    expect((await dependentVerdict).error).toBeUndefined();
    await flush();
    await b.storage.synced();
    cancel();

    expect(list.get()).toEqual(["e1", "x", "e3"]);
    return joined.get();
  };

  it("keeps a peer's in-place change under a splice whose commit read one element, and a reader of it persists what the store holds", async () => {
    // A read of element 0 sits below the array, so it covers neither the
    // array nor element 1, which the peer replaced.
    const joined = await persistedJoinAfterPeerReplaces(
      "intended-element-read",
      (list, tx) => {
        expect(list.withTx(tx).key(0).get()).toBe("e1");
      },
    );
    expect(joined).toBe("e1|x|e3");
  });

  it("keeps a peer's in-place change under a splice whose commit read the array's shape alone, and a reader of it persists what the store holds", async () => {
    // A shape-only read of the array sees its length and not its values, and
    // the peer's replacement changed no shape.
    const joined = await persistedJoinAfterPeerReplaces(
      "intended-shape-read",
      (list, tx) => {
        expect(list.withTx(tx).getRaw({ nonRecursive: true })).toHaveLength(2);
      },
    );
    expect(joined).toBe("e1|x|e3");
  });

  it("shows a stacked pair as the second computed it, then the store's list", async () => {
    const doc = "intended-stack";
    const a = connect();
    const b = connect();
    await seed(a, doc, ["e1", "e2"]);
    const { list, seen, cancel } = await watched(b, doc);

    heldIds.add(list.getAsNormalizedFullLink().id);
    const first = append(b, doc, "e3");
    const second = append(b, doc, "e4");
    await held.promise;
    expect(list.get()).toEqual(["e1", "e2", "e3", "e4"]);

    heldIds.clear();
    expect((await append(a, doc, "x")).error).toBeUndefined();
    await flush();
    expect(list.get()).toEqual(["e1", "e2", "e3", "e4"]);

    release.resolve();
    expect(errorNameOf(await first)).toBe("ConflictError");
    expect(errorNameOf(await second)).toBe("ConflictError");
    await flush();
    await b.runtime.idle();
    cancel();

    expect(list.get()).toEqual(["e1", "e2", "x"]);
    expect(
      seen.filter((value) =>
        Array.isArray(value) && value.includes("x") &&
        (value.includes("e3") || value.includes("e4"))
      ),
    ).toEqual([]);
  });
});
