import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { basisPartOf } from "../../src/compiled/basis.ts";
import {
  PieceUnits,
  readersPartDocumentOf,
  unitsDocumentOf,
  type UnitsStorage,
} from "../../src/compiled/units.ts";

/** A transaction of the storage below: what it wrote, by document. */
type Tx = { writes: Map<string, unknown> };

const RESULT = "result";

/**
 * A storage of documents in memory. A transaction's writes are held with
 * the transaction until `commit()` puts them into the documents.
 */
const storageOf = () => {
  const documents = new Map<string, unknown>();
  const at = (value: unknown, path: readonly string[]): unknown =>
    path.reduce(
      (below: unknown, segment) =>
        (below as Record<string, unknown> | undefined)?.[segment],
      value,
    );
  const storage: UnitsStorage<Tx> = {
    held: (doc) => structuredClone(documents.get(doc)),
    write: (tx, doc, path, value) => {
      const whole = structuredClone(
        tx.writes.get(doc) ?? documents.get(doc) ?? {},
      ) as Record<string, unknown>;
      if (path.length === 0) {
        tx.writes.set(doc, structuredClone(value));
        return;
      }
      const parent = at(whole, path.slice(0, -1)) as Record<string, unknown>;
      parent[path[path.length - 1]] = structuredClone(value);
      tx.writes.set(doc, whole);
    },
    result: () => undefined,
    rowsHeld: () => {},
    streamsHeld: () => {},
  };
  return {
    storage,
    documents,
    commit: (tx: Tx) => {
      for (const [doc, value] of tx.writes) documents.set(doc, value);
    },
  };
};

/** Two documents that the lists keep in different parts. */
const twoDocuments = (): [string, string] => {
  const first = "of:document-0";
  for (let index = 1;; index++) {
    const other = `of:document-${index}`;
    if (basisPartOf(other) !== basisPartOf(first)) return [first, other];
  }
};

/** What the body of the element of `key` read: one path of `doc`. */
const reads = (key: string, doc: string) => ({
  collection: 0,
  key,
  plain: true,
  position: false,
  reads: [{ doc, path: ["title"], own: false }],
});

describe("PieceUnits", () => {
  describe("refused()", () => {
    it("writes whole again a part that the refused transaction wrote as a part with no document", () => {
      const { storage, documents, commit } = storageOf();
      const [doc] = twoDocuments();
      const units = new PieceUnits<Tx>(RESULT, "pattern", storage);
      const refused: Tx = { writes: new Map() };
      units.read(reads("a", doc));
      units.record(refused);
      units.refused(refused);

      const next: Tx = { writes: new Map() };
      units.record(next);
      commit(next);

      const part = readersPartDocumentOf(RESULT, basisPartOf(doc));
      expect(documents.get(part)).toEqual({
        [doc]: { "0 a": { c: 0, k: "a", p: [["title"]], o: [] } },
      });
    });

    it("names in the document of the units the parts that the storage held before the refused transaction, beside the part written since", () => {
      const { storage, documents, commit } = storageOf();
      const [first, other] = twoDocuments();
      const units = new PieceUnits<Tx>(RESULT, "pattern", storage);
      const load: Tx = { writes: new Map() };
      units.read(reads("a", first));
      units.record(load);
      commit(load);
      const refused: Tx = { writes: new Map() };
      units.read(reads("b", other));
      units.record(refused);
      units.refused(refused);

      const next: Tx = { writes: new Map() };
      units.record(next);
      commit(next);

      const held = documents.get(unitsDocumentOf(RESULT)) as {
        parts: Record<string, 1>;
      };
      expect(Object.keys(held.parts).map(Number).sort()).toEqual(
        [basisPartOf(first), basisPartOf(other)].sort(),
      );
    });
  });
});
