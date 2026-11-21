import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  DOCUMENT_MAX_BYTES,
  PART_MIN_BYTES,
  PartedDocuments,
  type PartsOptions,
} from "../parts.ts";
import { spliceIn } from "../store.ts";

/**
 * A document as the store holds it, one value changed in place, with
 * each change reported to the part documents as `Store` reports it.
 */
class Logical {
  root: unknown;
  readonly parts: PartedDocuments;

  constructor(root: unknown, options: PartsOptions = {}) {
    this.root = root;
    this.parts = new PartedDocuments(options);
    this.parts.changed("d", [], this.root, undefined);
    this.parts.seal();
  }

  #holder(path: readonly string[]): Record<string, unknown> {
    let holder = this.root as Record<string, unknown>;
    for (const segment of path) {
      holder = holder[segment] as Record<string, unknown>;
    }
    return holder;
  }

  set(path: readonly string[], value: unknown) {
    const holder = this.#holder(path.slice(0, -1));
    const last = path[path.length - 1];
    const old = holder[last];
    holder[last] = value;
    this.parts.changed("d", path, this.root, old);
    return this.parts.seal();
  }

  splice(
    path: readonly string[],
    start: number,
    removed: number,
    members: unknown[],
  ) {
    const array = this.#holder(path) as unknown as unknown[];
    const taken = spliceIn(array, start, removed, members);
    this.parts.changed("d", path, this.root, taken, {
      start,
      removed: taken.length,
      inserted: members.length,
    });
    return this.parts.seal();
  }
}

const small = (index: number) => ({ id: `i${index}`, title: `t${index}` });
const wide = (index: number) => ({
  id: `i${index}`,
  title: `t${index}`.padEnd(2_000, "x"),
});
const list = (length: number, row: (index: number) => unknown) => ({
  items: Array.from({ length }, (_, index) => row(index)),
});

describe("part documents (P20)", () => {
  it("keeps an array of small rows under the maximum in its holder", () => {
    const doc = new Logical(list(100, small));
    expect(doc.parts.size).toBe(1);
    expect(doc.parts.materialize("d")).toEqual(doc.root);
    const sealed = doc.set(["items", "3", "title"], "other");
    expect(sealed.written.map(({ id }) => id)).toEqual(["d"]);
    expect(doc.parts.materialize("d")).toEqual(doc.root);
  });

  it("stores an array over the maximum in chunks, with small rows in place", () => {
    const doc = new Logical(list(10_000, small));
    const shape = doc.parts.describe("d", ["items"]);
    expect(shape.parts).toBe(0);
    expect(shape.chunks).toBeGreaterThan(1);
    for (const bytes of shape.chunkBytes) {
      expect(bytes).toBeLessThanOrEqual(DOCUMENT_MAX_BYTES);
    }
    expect(doc.parts.size).toBe(1 + shape.chunks);
    expect(doc.parts.materialize("d")).toEqual(doc.root);
  });

  it("makes a row of the minimum size a part, and returns it in place under half", () => {
    const doc = new Logical(list(10, small));
    doc.set(["items", "4", "title"], "x".repeat(PART_MIN_BYTES));
    expect(doc.parts.describe("d", ["items"]).parts).toBe(1);
    expect(doc.parts.size).toBe(2);
    // Between half the minimum and the minimum the row stays a part.
    const between = doc.set(
      ["items", "4", "title"],
      "x".repeat(PART_MIN_BYTES / 2 + 10),
    );
    expect(doc.parts.describe("d", ["items"]).parts).toBe(1);
    // The part alone is written: the holder holds the same link.
    expect(between.written.length).toBe(1);
    expect(between.written[0].id).not.toBe("d");
    doc.set(["items", "4", "title"], "short");
    expect(doc.parts.describe("d", ["items"]).parts).toBe(0);
    expect(doc.parts.size).toBe(1);
    expect(doc.parts.materialize("d")).toEqual(doc.root);
  });

  for (
    const [name, row] of [["23 bytes", small], ["2,000 bytes", wide]] as const
  ) {
    for (const counts of ["stored", "none"] as const) {
      it(`writes a bounded number of bytes for one change of a list of rows of ${name}, counts ${counts}`, () => {
        const bound = (length: number) => {
          const doc = new Logical(list(length, row), { counts });
          const changes = [
            doc.splice(["items"], length, 0, [row(length)]),
            doc.splice(["items"], 0, 0, [row(length + 1)]),
            doc.set(["items", `${length >> 1}`, "title"], "edited"),
            doc.splice(["items"], 0, 1, []),
            doc.splice(["items"], length, 1, []),
          ];
          expect(doc.parts.materialize("d")).toEqual(doc.root);
          return changes.reduce((most, { bytes }) => Math.max(most, bytes), 0);
        };
        // The holder, one chunk, one list of chunks on a split, and one
        // part: four documents of at most the maximum.
        expect(bound(1_000)).toBeLessThanOrEqual(4 * DOCUMENT_MAX_BYTES);
        expect(bound(20_000)).toBeLessThanOrEqual(4 * DOCUMENT_MAX_BYTES);
      });
    }
  }

  it("writes the lists above a chunk on an insertion only where the counts are stored", () => {
    const written = (counts: "stored" | "none") => {
      const doc = new Logical(list(10_000, small), { counts });
      return doc.splice(["items"], 5_000, 0, [small(-1)]).written.length;
    };
    expect(written("none")).toBe(1);
    expect(written("stored")).toBe(2);
  });

  it("reads one row through the holder, the chunk and the part", () => {
    const doc = new Logical(list(2_000, wide));
    const { value, documents } = doc.parts.counting(() =>
      doc.parts.read("d", ["items", "1500"])
    );
    expect(value).toEqual((doc.root as { items: unknown[] }).items[1500]);
    expect(documents).toBe(3);
    const first = doc.parts.counting(() =>
      doc.parts.rows("d", ["items"], 0, 20)
    );
    expect(first.value).toEqual(
      (doc.root as { items: unknown[] }).items.slice(0, 20),
    );
    expect(first.documents).toBe(22);
  });

  it("reads every chunk before a position where no count is stored", () => {
    const doc = new Logical(list(20_000, small), { counts: "none" });
    const { chunks } = doc.parts.describe("d", ["items"]);
    const last = doc.parts.counting(() =>
      doc.parts.read("d", ["items", "19999"])
    );
    expect(last.documents).toBe(1 + chunks);
    const stored = new Logical(list(20_000, small), { counts: "stored" });
    expect(
      stored.parts.counting(() => stored.parts.read("d", ["items", "19999"]))
        .documents,
    ).toBe(2);
  });

  it("merges chunks that removals emptied, and leaves no empty chunk", () => {
    const doc = new Logical(list(10_000, small));
    const before = doc.parts.describe("d", ["items"]).chunks;
    for (let length = 10_000; length > 200; length -= 200) {
      doc.splice(["items"], 100, 200, []);
    }
    const shape = doc.parts.describe("d", ["items"]);
    expect(shape.chunkBytes.every((bytes) => bytes > 2)).toBe(true);
    expect(shape.chunks).toBeLessThan(before);
    expect(doc.parts.materialize("d")).toEqual(doc.root);
    // What is left is under half the maximum and is in the holder again.
    expect(doc.parts.size).toBe(1);
  });

  it("gives the part of a row another identifier when its key changes, and the same one where it is minted", () => {
    const keys = new Map<number, string>();
    const run = (identity: "key" | "minted") => {
      const doc = new Logical(list(10, wide), {
        identity,
        keyAt: (_doc, _path, index) => keys.get(index) ?? `k${index}`,
      });
      keys.set(4, "another");
      const sealed = doc.set(["items", "4", "id"], "renamed");
      keys.clear();
      return sealed;
    };
    const byKey = run("key");
    expect([byKey.created, byKey.deleted]).toEqual([1, 1]);
    expect(byKey.written.length).toBe(2);
    const minted = run("minted");
    expect([minted.created, minted.deleted]).toEqual([0, 0]);
    expect(minted.written.length).toBe(1);
  });

  it("splits a chunk in two halves, for rows prepended one at a time", () => {
    const doc = new Logical(list(10, small));
    for (let index = 0; index < 6_000; index++) {
      doc.splice(["items"], 0, 0, [small(100 + index)]);
    }
    const { chunkBytes } = doc.parts.describe("d", ["items"]);
    expect(chunkBytes.length).toBeGreaterThan(1);
    for (const bytes of chunkBytes) {
      expect(bytes).toBeGreaterThan(DOCUMENT_MAX_BYTES / 4);
    }
  });

  it("holds what the document holds after a run of changes", () => {
    let seed = 7;
    const random = (below: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % below;
    };
    const doc = new Logical({ a: { items: [] as unknown[] }, n: 1 });
    let next = 0;
    for (let step = 0; step < 400; step++) {
      const { items } = (doc.root as { a: { items: unknown[] } }).a;
      const choice = random(10);
      if (choice < 5 || items.length < 5) {
        const members = Array.from(
          { length: 1 + random(300) },
          () => (random(4) === 0 ? wide(next++) : small(next++)),
        );
        doc.splice(["a", "items"], random(items.length + 1), 0, members);
      } else if (choice < 7) {
        doc.splice(["a", "items"], random(items.length), random(400), []);
      } else if (choice < 9) {
        const at = random(items.length);
        doc.set(
          ["a", "items", `${at}`, "title"],
          random(2) === 0 ? "s" : "y".repeat(random(3_000)),
        );
      } else {
        doc.set(
          ["a", "items"],
          items.slice(random(3), items.length - random(3)),
        );
      }
      expect(doc.parts.materialize("d")).toEqual(doc.root);
      const shape = doc.parts.describe("d", ["a", "items"]);
      for (const bytes of shape.chunkBytes) {
        expect(bytes).toBeLessThanOrEqual(DOCUMENT_MAX_BYTES);
      }
    }
  });
});
