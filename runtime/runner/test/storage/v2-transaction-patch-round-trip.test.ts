/**
 * What a commit's patch ops come to once the server has applied them. Each
 * case writes through a cell, commits, and reads the document back through a
 * second session, which loads it from the server rather than from the
 * writer's own replica. So a case fails where the ops the patch generator
 * sent do not apply, or apply to something other than what the writer held.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { PatchOp } from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  markServedWaveRunTx,
  markUiInputBlindWriteTx,
  setBlindStructuralTarget,
  unmarkUiInputBlindWriteTx,
} from "../../src/storage/reactivity-log.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import {
  newSharedServer,
  withoutMarkedSplices,
} from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "v2-transaction patch round trip",
);
const space = signer.did();

/** A storage session against the shared server, and the runtime over it. */
type Session = { storage: EmulatedStorageManager; runtime: Runtime };

/** The kind of `op` and the path it names, as one string. */
const kindAndPath = (op: PatchOp): string => `${op.op} ${op.path}`;

describe("v2-transaction", () => {
  let server: MemoryV2Server.Server;
  // Every patch op the server was sent, in arrival order.
  let sentPatches: PatchOp[];
  const sessions: Session[] = [];

  beforeEach(() => {
    // The server advertises `markedSplicesV1`, so a pinned change to an
    // array goes as marked splices; one case below connects to a server that
    // does not.
    server = newSharedServer();
    sentPatches = [];
    const transact = server.transact.bind(server);
    server.transact = (...args: Parameters<typeof transact>) => {
      for (const operation of args[0].commit.operations) {
        if (operation.op !== "patch") continue;
        for (const patch of operation.patches) sentPatches.push(patch);
      }
      return transact(...args);
    };
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.runtime.dispose();
      await session.storage.close();
    }
    await server.close();
  });

  /** Opens a session against the shared server. */
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

  /**
   * Commits what `write` does to the cell of the document `doc`, and returns
   * the kind and path of each patch op the commit sent. Throws where the
   * commit is refused.
   */
  const commit = async (
    session: Session,
    doc: string,
    write: (cell: Cell<FabricValue>) => void,
  ): Promise<string[]> => {
    const alreadySent = sentPatches.length;
    const tx = session.runtime.edit();
    write(session.runtime.getCell<FabricValue>(space, doc, undefined, tx));
    const result = await tx.commit().settled;
    if (result.error) throw result.error;
    return sentPatches.slice(alreadySent).map(kindAndPath);
  };

  /**
   * Returns the value of the document `doc` as a session that connects now
   * loads it, which is the value the server made of the ops it was sent.
   */
  const storedValue = async (doc: string): Promise<FabricValue | undefined> => {
    const cell = connect().runtime.getCell<FabricValue>(space, doc);
    await cell.sync();
    return cell.getRaw();
  };

  describe("a record keyed by integer-like strings", () => {
    // A key of a plain object written as a non-negative integer is a key of
    // that object, inside the range of array indices and past it. A write at
    // or beneath one travels as an op at the written path, so the record's
    // other keys stay out of the commit. `toStrictEqual()` tells a record from
    // the array an index would address.

    const farPast = "1791869505000000000";
    const keys = [
      { key: "123", where: "inside the array index range" },
      { key: "4294967295", where: "one past the array index range" },
      { key: farPast, where: "far past the array index range" },
    ];

    for (const { key, where } of keys) {
      it(`sends an \`add\` at a key ${where} added to an empty record`, async () => {
        const writer = connect();
        await commit(writer, "added", (cell) => cell.set({}));

        const sent = await commit(
          writer,
          "added",
          (cell) => cell.set({ [key]: 1 }),
        );

        expect(sent).toEqual([`add /value/${key}`]);
        expect(await storedValue("added")).toStrictEqual({ [key]: 1 });
      });

      it(`sends a \`remove\` at a key ${where} removed from a record`, async () => {
        const writer = connect();
        await commit(
          writer,
          "removed",
          (cell) => cell.set({ [key]: 1, kept: 2 }),
        );

        const sent = await commit(
          writer,
          "removed",
          (cell) => cell.set({ kept: 2 }),
        );

        expect(sent).toEqual([`remove /value/${key}`]);
        expect(await storedValue("removed")).toStrictEqual({ kept: 2 });
      });
    }

    it("sends a `replace` at the written path beneath a key inside the array index range", async () => {
      const writer = connect();
      await commit(writer, "beneath", (cell) =>
        cell.set({
          byId: { "123": { name: "a" }, "124": { name: "b" } },
        }));

      const sent = await commit(
        writer,
        "beneath",
        (cell) => cell.key("byId").key("123").key("name").set("z"),
      );

      expect(sent).toEqual(["replace /value/byId/123/name"]);
      expect(await storedValue("beneath")).toStrictEqual({
        byId: { "123": { name: "z" }, "124": { name: "b" } },
      });
    });

    it("sends an `add` at the written path beneath a key inside the array index range that the record lacks", async () => {
      // The record is there, so the server finds a plain object to create the
      // key in.

      const writer = connect();
      await commit(writer, "new-key", (cell) => cell.set({ byId: {} }));

      const sent = await commit(
        writer,
        "new-key",
        (cell) => cell.key("byId").key("7").key("name").set("x"),
      );

      expect(sent).toEqual(["add /value/byId/7/name"]);
      expect(await storedValue("new-key")).toStrictEqual({
        byId: { "7": { name: "x" } },
      });
    });

    it("sends an `add` at a record's `length` key", async () => {
      // `length` is the other key an array has, and on a record it is a key
      // like any other.

      const writer = connect();
      await commit(writer, "length", (cell) => cell.set({ size: { a: 1 } }));

      const sent = await commit(
        writer,
        "length",
        (cell) => cell.key("size").key("length").set(3),
      );

      expect(sent).toEqual(["add /value/size/length"]);
      expect(await storedValue("length")).toStrictEqual({
        size: { a: 1, length: 3 },
      });
    });

    it("sends a record whole where a key inside the array index range is written into one the document lacks", async () => {
      // The server shapes a container it creates by the segment that follows
      // it, and would create an array for this key. The commit holds a record
      // there, so the record travels as one `add`.

      const writer = connect();
      await commit(writer, "created-record", (cell) => cell.set({}));

      const sent = await commit(writer, "created-record", (cell) => {
        cell.key("p").key("meta").key("title").set("t");
        cell.key("p").key("5").set("y");
      });

      expect(sent).toEqual(["add /value/p"]);
      expect(await storedValue("created-record")).toStrictEqual({
        p: { meta: { title: "t" }, "5": "y" },
      });
    });

    it("commits two sessions' writes beneath different keys inside the array index range", async () => {
      // Both transactions are staged before either commits, so each carries
      // reads that predate the other's write. An op at the written path
      // leaves the other key out of the commit, and neither conflicts.

      const first = connect();
      const second = connect();
      await commit(first, "disjoint", (cell) =>
        cell.set({
          byId: { "1": { name: "a" }, "2": { name: "b" } },
        }));
      await second.runtime.getCell<FabricValue>(space, "disjoint").sync();

      await Promise.all([
        commit(
          first,
          "disjoint",
          (cell) => cell.key("byId").key("1").key("name").set("A"),
        ),
        commit(
          second,
          "disjoint",
          (cell) => cell.key("byId").key("2").key("name").set("B"),
        ),
      ]);

      expect(await storedValue("disjoint")).toStrictEqual({
        byId: { "1": { name: "A" }, "2": { name: "B" } },
      });
    });

    it("sends an `increment` alone for a counter at a key inside the array index range", async () => {
      // The increment is the whole of the write. A `replace` beside it would
      // carry the number this session computed, and undo what the op is for.

      const writer = connect();
      await commit(
        writer,
        "counter",
        (cell) => cell.set({ counts: { "5": 1 } }),
      );

      const sent = await commit(
        writer,
        "counter",
        (cell) => cell.key("counts").key("5").increment(1),
      );

      expect(sent).toEqual(["increment /value/counts/5"]);
      expect(await storedValue("counter")).toStrictEqual({
        counts: { "5": 2 },
      });
    });

    it("sends an `append` alone for the first push to a list at a key inside the array index range", async () => {
      const writer = connect();
      await commit(writer, "pushed", (cell) => cell.set({ lists: {} }));

      const sent = await commit(
        writer,
        "pushed",
        (cell) => cell.key("lists").key("5").push("b"),
      );

      expect(sent).toEqual(["append /value/lists/5"]);
      expect(await storedValue("pushed")).toStrictEqual({
        lists: { "5": ["b"] },
      });
    });

    it("counts both of two sessions' increments of a counter at a key inside the array index range", async () => {
      const first = connect();
      const second = connect();
      await commit(
        first,
        "counted",
        (cell) => cell.set({ counts: { "5": 1 } }),
      );
      await second.runtime.getCell<FabricValue>(space, "counted").sync();

      await Promise.all([
        commit(
          first,
          "counted",
          (cell) => cell.key("counts").key("5").increment(1),
        ),
        commit(
          second,
          "counted",
          (cell) => cell.key("counts").key("5").increment(1),
        ),
      ]);

      expect(await storedValue("counted")).toStrictEqual({
        counts: { "5": 3 },
      });
    });

    it("commits a key far past the array index range written beneath a key the record lacks", async () => {
      const writer = connect();
      await commit(writer, "created", (cell) => cell.set({}));

      await commit(
        writer,
        "created",
        (cell) => cell.key("byTime").key(farPast).set(1),
      );

      expect(await storedValue("created")).toStrictEqual({
        byTime: { [farPast]: 1 },
      });
    });

    it("commits a value written beneath a key far past the array index range, itself beneath a key the record lacks", async () => {
      const writer = connect();
      await commit(writer, "nested", (cell) => cell.set({}));

      await commit(
        writer,
        "nested",
        (cell) => cell.key("byTime").key(farPast).key("text").set("hi"),
      );

      expect(await storedValue("nested")).toStrictEqual({
        byTime: { [farPast]: { text: "hi" } },
      });
    });
  });

  describe("a write beneath an array element the document lacks", () => {
    // The element arrives holding what was written, so the write is a change
    // to the array that gains the element. An array's elements travel only as
    // a `splice` on the array's path, a `replace` at an index, or an op
    // carrying the whole array, so each case names the ops its commit sent as
    // well as the value the server made of them.

    it("sends a `splice` on the array for a nested array written into its first slot", async () => {
      const writer = connect();
      await commit(writer, "first", (cell) => cell.set({ items: [] }));

      const sent = await commit(
        writer,
        "first",
        (cell) => cell.key("items").key("0").key("0").set("x"),
      );

      expect(sent).toEqual(["splice /value/items"]);
      expect(await storedValue("first")).toStrictEqual({ items: [["x"]] });
    });

    it("sends a `splice` on the array for a nested array written past its last element", async () => {
      const writer = connect();
      await commit(writer, "last", (cell) => cell.set({ items: [["a"]] }));

      const sent = await commit(
        writer,
        "last",
        (cell) => cell.key("items").key("1").key("0").set("b"),
      );

      expect(sent).toEqual(["splice /value/items"]);
      expect(await storedValue("last")).toStrictEqual({
        items: [["a"], ["b"]],
      });
    });

    it("sends a `splice` on the array for a record holding an array", async () => {
      const writer = connect();
      await commit(writer, "record", (cell) => cell.set({ items: [] }));

      const sent = await commit(
        writer,
        "record",
        (cell) => cell.key("items").key("0").key("tags").key("0").set("x"),
      );

      expect(sent).toEqual(["splice /value/items"]);
      expect(await storedValue("record")).toStrictEqual({
        items: [{ tags: ["x"] }],
      });
    });

    it("sends a `splice` on the inner array for an element missing two arrays down", async () => {
      const writer = connect();
      await commit(writer, "inner", (cell) => cell.set({ items: [[["a"]]] }));

      const sent = await commit(
        writer,
        "inner",
        (cell) => cell.key("items").key("0").key("1").key("0").set("b"),
      );

      expect(sent).toEqual(["splice /value/items/0"]);
      expect(await storedValue("inner")).toStrictEqual({
        items: [[["a"], ["b"]]],
      });
    });

    it("sends an `add` of the outer array for nested arrays written beneath a key the record lacks", async () => {
      const writer = connect();
      await commit(writer, "outer", (cell) => cell.set({}));

      const sent = await commit(
        writer,
        "outer",
        (cell) => cell.key("rows").key("0").key("0").set("x"),
      );

      expect(sent).toEqual(["add /value/rows"]);
      expect(await storedValue("outer")).toStrictEqual({ rows: [["x"]] });
    });

    it("sends an `add` of the outer array for nested arrays written two keys beneath what the record holds", async () => {
      const writer = connect();
      await commit(writer, "deeper", (cell) => cell.set({}));

      const sent = await commit(
        writer,
        "deeper",
        (cell) => cell.key("a").key("b").key("0").key("0").set("x"),
      );

      expect(sent).toEqual(["add /value/a/b"]);
      expect(await storedValue("deeper")).toStrictEqual({
        a: { b: [["x"]] },
      });
    });
  });

  describe("a write beneath an array element the document holds", () => {
    // The counterpart of the group above: where the element is there, the
    // write stays as deep as it was made.

    it("sends a `replace` at the written index of a nested array", async () => {
      const writer = connect();
      await commit(writer, "edited", (cell) => cell.set({ m: [[1, 2]] }));

      const sent = await commit(
        writer,
        "edited",
        (cell) => cell.key("m").key("0").key("1").set(9),
      );

      expect(sent).toEqual(["replace /value/m/0/1"]);
      expect(await storedValue("edited")).toStrictEqual({ m: [[1, 9]] });
    });

    it("sends a `splice` on a nested array for a value written past its last element", async () => {
      const writer = connect();
      await commit(writer, "grown", (cell) => cell.set({ items: [["a"]] }));

      const sent = await commit(
        writer,
        "grown",
        (cell) => cell.key("items").key("0").key("1").set("b"),
      );

      expect(sent).toEqual(["splice /value/items/0"]);
      expect(await storedValue("grown")).toStrictEqual({
        items: [["a", "b"]],
      });
    });

    it("sends a `splice` on the outer array emptied after a write beneath one of its elements", async () => {
      const writer = connect();
      await commit(
        writer,
        "emptied",
        (cell) => cell.set({ items: [["a", "b"]] }),
      );

      const sent = await commit(writer, "emptied", (cell) => {
        cell.key("items").key("0").key("1").set("c");
        cell.key("items").set([]);
      });

      expect(sent).toEqual(["splice /value/items"]);
      expect(await storedValue("emptied")).toStrictEqual({ items: [] });
    });
  });

  describe("an array written beneath a key the record lacks", () => {
    it("sends an `add` at the array's own key", async () => {
      // The key above the array is created by the server as it applies the
      // op, so the array is not sent inside the record that holds it.

      const writer = connect();
      await commit(writer, "keyed", (cell) => cell.set({}));

      const sent = await commit(
        writer,
        "keyed",
        (cell) => cell.key("profile").key("tags").key("0").set("x"),
      );

      expect(sent).toEqual(["add /value/profile/tags"]);
      expect(await storedValue("keyed")).toStrictEqual({
        profile: { tags: ["x"] },
      });
    });
  });

  describe("an array whose elements shift", () => {
    // An element added to or removed from an array shifts every element after
    // it. A change to the array's length travels as one splice for each run
    // of a shortest edit script, carrying the elements that run adds, where
    // that carries fewer than an index-by-index diff would. A change that
    // keeps the length travels index by index unless that would replace more
    // than 64 elements. Each case names the ops its commit sent, and the value
    // the server made of them.

    /** `count` distinct strings, `e0` on. */
    const items = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `e${index}`);

    /** Like `commit()`, except returns the ops the commit sent, whole. */
    const commitOps = async (
      session: Session,
      doc: string,
      write: (cell: Cell<FabricValue>) => void,
    ): Promise<PatchOp[]> => {
      const alreadySent = sentPatches.length;
      await commit(session, doc, write);
      return sentPatches.slice(alreadySent);
    };

    it("sends one `splice` for an element inserted at the head", async () => {
      const writer = connect();
      const list = items(100);
      await commit(writer, "head", (cell) => cell.set({ list }));

      const sent = await commitOps(
        writer,
        "head",
        (cell) => cell.key("list").set(["x", ...list]),
      );

      expect(sent).toEqual([{
        op: "splice",
        path: "/value/list",
        index: 0,
        remove: 0,
        add: ["x"],
        pinned: true,
      }]);
      expect(await storedValue("head")).toStrictEqual({ list: ["x", ...list] });
    });

    it("sends one `splice` for an element removed from the middle", async () => {
      const writer = connect();
      const list = items(100);
      await commit(writer, "middle", (cell) => cell.set({ list }));

      const remaining = list.filter((item) => item !== "e50");
      const sent = await commitOps(
        writer,
        "middle",
        (cell) => cell.key("list").set(remaining),
      );

      expect(sent).toEqual([{
        op: "splice",
        path: "/value/list",
        index: 50,
        remove: 1,
        add: [],
        pinned: true,
      }]);
      expect(await storedValue("middle")).toStrictEqual({ list: remaining });
    });

    it("sends a `splice` for each of two places elements are inserted at, each at its index once the one before has applied", async () => {
      const writer = connect();
      const list = items(100);
      await commit(writer, "two", (cell) => cell.set({ list }));

      const grown = ["x", ...list.slice(0, 60), "y", ...list.slice(60)];
      const sent = await commitOps(
        writer,
        "two",
        (cell) => cell.key("list").set(grown),
      );

      expect(sent).toEqual([
        {
          op: "splice",
          path: "/value/list",
          index: 0,
          remove: 0,
          add: ["x"],
          pinned: true,
        },
        {
          op: "splice",
          path: "/value/list",
          index: 61,
          remove: 0,
          add: ["y"],
          pinned: true,
        },
      ]);
      expect(await storedValue("two")).toStrictEqual({ list: grown });
    });

    it("sends the tail `splice` alone for elements appended by a write of the whole array", async () => {
      const writer = connect();
      const list = items(100);
      await commit(writer, "tail", (cell) => cell.set({ list }));

      const sent = await commitOps(
        writer,
        "tail",
        (cell) => cell.key("list").set([...list, "x", "y"]),
      );

      expect(sent).toEqual([{
        op: "splice",
        path: "/value/list",
        index: 100,
        remove: 0,
        add: ["x", "y"],
      }]);
      expect(await storedValue("tail")).toStrictEqual({
        list: [...list, "x", "y"],
      });
    });

    it("sends a `replace` at the index of an element changed in place", async () => {
      const writer = connect();
      const list = items(100);
      await commit(writer, "in-place", (cell) => cell.set({ list }));

      const changed = list.map((item) => item === "e50" ? "z" : item);
      const sent = await commit(
        writer,
        "in-place",
        (cell) => cell.key("list").set(changed),
      );

      expect(sent).toEqual(["replace /value/list/50"]);
      expect(await storedValue("in-place")).toStrictEqual({ list: changed });
    });

    it("sends a `replace` at each index an element moving a few places to the head shifts", async () => {
      const writer = connect();
      const list = items(10);
      await commit(writer, "short-move", (cell) => cell.set({ list }));

      const moved = ["e5", ...list.filter((item) => item !== "e5")];
      const sent = await commit(
        writer,
        "short-move",
        (cell) => cell.key("list").set(moved),
      );

      expect(sent).toEqual(
        [0, 1, 2, 3, 4, 5].map((index) => `replace /value/list/${index}`),
      );
      expect(await storedValue("short-move")).toStrictEqual({ list: moved });
    });

    it("sends an insertion and a removal for an element moving more than 64 places to the head", async () => {
      const writer = connect();
      const list = items(100);
      await commit(writer, "long-move", (cell) => cell.set({ list }));

      const moved = ["e90", ...list.filter((item) => item !== "e90")];
      const sent = await commitOps(
        writer,
        "long-move",
        (cell) => cell.key("list").set(moved),
      );

      expect(sent).toEqual([
        {
          op: "splice",
          path: "/value/list",
          index: 0,
          remove: 0,
          add: ["e90"],
          pinned: true,
        },
        {
          op: "splice",
          path: "/value/list",
          index: 91,
          remove: 1,
          add: [],
          pinned: true,
        },
      ]);
      expect(await storedValue("long-move")).toStrictEqual({ list: moved });
    });

    it("sends nothing beneath the shifted elements where an element holding an array changed beside a head insertion", async () => {
      // Every element at or past the first splice is carried by the splices,
      // or else is the same in both documents, so the diffs of the arrays
      // inside the shifted elements are left out.

      const writer = connect();
      const nested = [["a"], ["b"], ["c"], ["d"], ["e"]];
      await commit(writer, "nested", (cell) => cell.set({ list: nested }));

      const changed = [["x"], ...nested.slice(0, 4), ["e", "f"]];
      const sent = await commit(
        writer,
        "nested",
        (cell) => cell.key("list").set(changed),
      );

      expect(sent).toEqual(["splice /value/list", "splice /value/list"]);
      expect(await storedValue("nested")).toStrictEqual({ list: changed });
    });

    it("sends one `splice` for a link inserted at the head of a list of links", async () => {
      const writer = connect();
      const seeding = writer.runtime.edit();
      const rows = Array.from({ length: 101 }, (_, index) => {
        const row = writer.runtime.getCell<FabricValue>(
          space,
          `row-${index}`,
          undefined,
          seeding,
        );
        row.set({ title: `t${index}` });
        return row;
      });
      writer.runtime.getCell<FabricValue>(space, "board", undefined, seeding)
        .set({ list: rows.slice(1) });
      expect((await seeding.commit().settled).error).toBeUndefined();

      const sent = await commitOps(
        writer,
        "board",
        (cell) => cell.key("list").set(rows),
      );

      expect(sent.map(kindAndPath)).toEqual(["splice /value/list"]);
      const [splice] = sent;
      expect(splice?.op === "splice" && [splice.index, splice.add.length])
        .toEqual([0, 1]);
      const written = writer.runtime.getCell<FabricValue>(space, "board")
        .getRaw();
      expect(await storedValue("board")).toEqual(written);
    });

    it("keeps both of two sessions' pushes to one list", async () => {
      const first = connect();
      const second = connect();
      await commit(first, "pushes", (cell) => cell.set({ list: items(3) }));
      await second.runtime.getCell<FabricValue>(space, "pushes").sync();

      // The two commits' ops reach the server interleaved, so they are judged
      // together.
      const alreadySent = sentPatches.length;
      await Promise.all([
        commit(first, "pushes", (cell) => cell.key("list").push("x")),
        commit(second, "pushes", (cell) => cell.key("list").push("y")),
      ]);

      expect(sentPatches.slice(alreadySent).map(kindAndPath)).toEqual([
        "append /value/list",
        "append /value/list",
      ]);
      const stored = await storedValue("pushes") as { list: string[] };
      expect([...stored.list].sort()).toEqual([...items(3), "x", "y"].sort());
      expect(stored.list.slice(0, 3)).toEqual(items(3));
    });

    it("keeps one session's head insertion and another's push to one list", async () => {
      const first = connect();
      const second = connect();
      const list = items(100);
      await commit(first, "head-and-push", (cell) => cell.set({ list }));
      await second.runtime.getCell<FabricValue>(space, "head-and-push").sync();

      // The two commits' ops reach the server interleaved, so they are judged
      // together.
      const alreadySent = sentPatches.length;
      await Promise.all([
        commit(
          first,
          "head-and-push",
          (cell) => cell.key("list").set(["x", ...list]),
        ),
        commit(second, "head-and-push", (cell) => cell.key("list").push("y")),
      ]);

      expect(sentPatches.slice(alreadySent)).toEqual([
        {
          op: "splice",
          path: "/value/list",
          index: 0,
          remove: 0,
          add: ["x"],
          pinned: true,
        },
        { op: "append", path: "/value/list", values: ["y"] },
      ]);
      expect(await storedValue("head-and-push")).toStrictEqual({
        list: ["x", ...list, "y"],
      });
    });

    it("sends the edits a push leaves to the diff index by index, beside the `append`", async () => {
      // The `append` suppresses every op at the list's own path, so the
      // existing elements' edits must travel at their indices. Here an edit
      // script would carry fewer elements as splices, which the suppression
      // would drop.

      const writer = connect();
      await commit(
        writer,
        "edit-and-push",
        (cell) => cell.set({ list: ["a", "b"] }),
      );

      const sent = await commit(writer, "edit-and-push", (cell) => {
        cell.key("list").key(0).set("b");
        cell.key("list").key(1).set("a");
        cell.key("list").push("c");
      });

      expect([...sent].sort()).toEqual([
        "append /value/list",
        "replace /value/list/0",
        "replace /value/list/1",
      ]);
      expect(await storedValue("edit-and-push")).toStrictEqual({
        list: ["b", "a", "c"],
      });
    });

    it("sends a head insertion index by index to a server that does not advertise marked splices", async () => {
      // A server without `markedSplicesV1`, one that predates marked
      // splices, reads a splice as overwriting nothing, so the change goes in
      // the form it reads.
      const older = withoutMarkedSplices(newSharedServer());
      const sentToOlder: PatchOp[] = [];
      const transact = older.transact.bind(older);
      older.transact = (...args: Parameters<typeof transact>) => {
        for (const operation of args[0].commit.operations) {
          if (operation.op !== "patch") continue;
          for (const patch of operation.patches) sentToOlder.push(patch);
        }
        return transact(...args);
      };
      const storage = EmulatedStorageManager.connectTo(older, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      try {
        const list = items(10);
        const seed = runtime.edit();
        runtime.getCell<FabricValue>(space, "older", undefined, seed)
          .set({ list });
        expect((await seed.commit().settled).error).toBeUndefined();

        const alreadySent = sentToOlder.length;
        const insertion = runtime.edit();
        const cell = runtime.getCell<FabricValue>(
          space,
          "older",
          undefined,
          insertion,
        ).key("list");
        cell.set(["x", ...(cell.get() as string[])]);
        expect((await insertion.commit().settled).error).toBeUndefined();

        const sent = sentToOlder.slice(alreadySent);
        expect(sent.map(kindAndPath)).toEqual([
          ...list.map((_, index) => `replace /value/list/${index}`),
          "splice /value/list",
        ]);
        expect(sent.some((op) => op.op === "splice" && op.pinned === true))
          .toBe(false);
      } finally {
        await runtime.dispose();
        await storage.close();
        await older.close();
      }
    });

    it("commits an increment of an element beside the truncation that drops it", async () => {
      const writer = connect();
      await commit(
        writer,
        "truncated",
        (cell) => cell.set({ list: [10, 20, 30] }),
      );

      const sent = await commit(writer, "truncated", (cell) => {
        cell.key("list").key(2).increment(1);
        cell.key("list").key("length").set(2);
      });

      expect([...sent].sort()).toEqual([
        "increment /value/list/2",
        "splice /value/list",
      ]);
      expect(await storedValue("truncated")).toStrictEqual({ list: [10, 20] });
    });

    it("sends a change that no edit script within 64 edits makes index by index", async () => {
      // Seventy elements change and one is removed, past the bound where the
      // search for a shortest edit script stops. One splice spanning the
      // changed range would carry every element in it, the unchanged one
      // among them, so the change travels index by index, carrying only the
      // elements that changed or shifted.
      const writer = connect();
      const list = items(120);
      await commit(writer, "unscripted", (cell) => cell.set({ list }));
      const changed = list
        .map((value, index) =>
          index <= 70 && index !== 60 ? `${value}-edited` : value
        )
        .filter((_, index) => index !== 80);

      const sent = await commitOps(
        writer,
        "unscripted",
        (cell) => cell.key("list").set(changed),
      );

      expect(sent.filter((op) => op.op === "splice")).toEqual([
        { op: "splice", path: "/value/list", index: 119, remove: 1, add: [] },
      ]);
      expect(sent.map(kindAndPath)).not.toContain("replace /value/list/60");
      expect(await storedValue("unscripted")).toStrictEqual({ list: changed });
    });

    it("sends index by index a change whose edit script adds an element back where it was", async () => {
      // The shortest script keeps `c`, `d` and `e`, so it removes `h` and adds
      // it back at the index it held. The per-index diff leaves `h` alone,
      // and an element can be any size.
      const writer = connect();
      const h = "h".repeat(4096);
      await commit(
        writer,
        "readded",
        (cell) => cell.set({ list: ["a", "b", h, "c", "d", "e"] }),
      );
      const changed = ["c", "d", h, "e", "f"];

      const sent = await commitOps(
        writer,
        "readded",
        (cell) => cell.key("list").set(changed),
      );

      expect(
        sent.some((op) => op.op === "splice" && op.add.includes(h)),
      ).toBe(false);
      expect(sent.map(kindAndPath)).not.toContain("replace /value/list/2");
      expect(await storedValue("readded")).toStrictEqual({ list: changed });
    });

    it("sends a served wave run's head insertion index by index", async () => {
      // A wave batch carries no read set the store checks, and the wave drops
      // a served handler's patches one by one, which a splice cannot be in
      // part.
      const writer = connect();
      await commit(writer, "served", (cell) => cell.set({ list: ["a", "b"] }));

      const tx = writer.runtime.edit();
      markServedWaveRunTx(tx);
      const list = writer.runtime
        .getCell<FabricValue>(space, "served", undefined, tx)
        .key("list");
      list.set(["x", ...(list.get() as string[])]);
      const alreadySent = sentPatches.length;
      const result = await tx.commit().settled;

      expect(result.error).toBeUndefined();
      expect(sentPatches.slice(alreadySent).map(kindAndPath)).toEqual([
        "replace /value/list/0",
        "replace /value/list/1",
        "splice /value/list",
      ]);
      expect(await storedValue("served")).toStrictEqual({
        list: ["x", "a", "b"],
      });
    });

    describe("written by a commit that does not read the whole list", () => {
      // A splice names positions, and the server applies it to whatever list
      // it holds then. A commit that read the whole list is refused where the
      // list moved since, so its splices land on the list they were diffed
      // from. A blind UI-input write reads no more than the shape of the
      // list's parent, so its change travels index by index, and each index
      // it wrote holds its value however the list moved.

      /**
       * Builds a transaction that writes `next` to the list of `doc` the way
       * the UI's input does: blind, its one read the shape of the list's
       * parent.
       */
      const blindWrite = (session: Session, doc: string, next: string[]) => {
        const tx = session.runtime.edit();
        const list = session.runtime
          .getCell<FabricValue>(space, doc, undefined, tx)
          .key("list");
        markUiInputBlindWriteTx(tx);
        const link = list.resolveAsCell().getAsNormalizedFullLink();
        setBlindStructuralTarget(tx, {
          id: link.id,
          space: link.space,
          scope: link.scope,
          path: link.path.slice(0, -1),
        });
        list.set(next);
        unmarkUiInputBlindWriteTx(tx);
        session.runtime.prepareTxForCommit(tx);
        return tx;
      };

      /** Builds a transaction that changes element 1 of the list of `doc`. */
      const peerEdit = (session: Session, doc: string) => {
        const tx = session.runtime.edit();
        session.runtime.getCell<FabricValue>(space, doc, undefined, tx)
          .key("list").key(1).set("peer");
        return tx;
      };

      it("sends a blind head insertion index by index", async () => {
        const writer = connect();
        await commit(writer, "blind", (cell) => cell.set({ list: ["a", "b"] }));

        const alreadySent = sentPatches.length;
        const result = await blindWrite(writer, "blind", ["x", "a", "b"])
          .commit().settled;

        expect(result.error).toBeUndefined();
        expect(sentPatches.slice(alreadySent).map(kindAndPath)).toEqual([
          "replace /value/list/0",
          "replace /value/list/1",
          "splice /value/list",
        ]);
        expect(await storedValue("blind")).toStrictEqual({
          list: ["x", "a", "b"],
        });
      });

      it("keeps each index a blind write wrote where another session changed the list first", async () => {
        const writer = connect();
        const peer = connect();
        await commit(
          writer,
          "blind-race",
          (cell) => cell.set({ list: ["a", "b"] }),
        );
        await peer.runtime.getCell<FabricValue>(space, "blind-race").sync();

        // Both commits are built before either reaches the server, which
        // takes the peer's first.
        const blind = blindWrite(writer, "blind-race", ["x", "a", "b"]);
        const edit = peerEdit(peer, "blind-race");
        const [edited, written] = await Promise.all([
          edit.commit().settled,
          blind.commit().settled,
        ]);

        expect(edited.error).toBeUndefined();
        expect(written.error).toBeUndefined();
        expect(await storedValue("blind-race")).toStrictEqual({
          list: ["x", "a", "b"],
        });
      });

      it("refuses a head insertion that read the list where another session changed the list first", async () => {
        const writer = connect();
        const peer = connect();
        await commit(
          writer,
          "read-race",
          (cell) => cell.set({ list: ["a", "b"] }),
        );
        await peer.runtime.getCell<FabricValue>(space, "read-race").sync();

        const insertion = writer.runtime.edit();
        const list = writer.runtime
          .getCell<FabricValue>(space, "read-race", undefined, insertion)
          .key("list");
        list.set(["x", ...(list.get() as string[])]);
        const edit = peerEdit(peer, "read-race");
        const alreadySent = sentPatches.length;
        const [edited, inserted] = await Promise.all([
          edit.commit().settled,
          insertion.commit().settled,
        ]);

        expect(sentPatches.slice(alreadySent).map(kindAndPath)).toEqual([
          "replace /value/list/1",
          "splice /value/list",
        ]);
        expect(edited.error).toBeUndefined();
        expect(inserted.error?.name).toBe("ConflictError");
        expect(await storedValue("read-race")).toStrictEqual({
          list: ["a", "peer"],
        });
      });
    });
  });
});
