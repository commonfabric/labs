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
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

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
});
