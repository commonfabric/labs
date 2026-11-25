import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import {
  type CurrencyRecord,
  storeCurrencyRecords,
} from "@commonfabric/memory/v2/currency-index";
import { close, open } from "@commonfabric/memory/v2/engine";

import { currencyCycles, type CurrencyReadEdge } from "../currency.ts";
import { openSpaces, type SpaceRef } from "../multispace.ts";

const A = "did:key:z6Mk-inspect-currency-a";
const B = "did:key:z6Mk-inspect-currency-b";
const C = "did:key:z6Mk-inspect-currency-c";

/** What a test says a piece reads: a document, and the space it is in. */
type Reads = Array<{ space: string; id: string; slice?: string }>;

describe("currency", () => {
  let dir: string;
  let refs: SpaceRef[];

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "inspect-currency-" });
    refs = [];
  });

  afterEach(async () => {
    for (const ref of refs) ref.space.close();
    await Deno.remove(dir, { recursive: true });
  });

  /**
   * A record of `piece` that writes `writes` and whose slices read `reads`,
   * each in the `space` slice unless it names another.
   */
  const record = (
    piece: string,
    writes: string[],
    reads: Reads,
  ): CurrencyRecord => {
    const slices = new Map<string, Reads>([["space", []]]);
    for (const read of reads) {
      const key = read.slice ?? "space";
      slices.set(key, [...slices.get(key) ?? [], read]);
    }
    return {
      piece,
      under: [],
      vouched: true,
      writes,
      owned: [],
      slices: [...slices].map(([key, read]) => ({
        key,
        vouched: true,
        reads: read.map(({ space, id }) => ({
          space,
          id,
          scopeKey: "space",
          derived: false,
        })),
        vouches: [],
      })),
    };
  };

  /** Writes a store for `space` that holds `records` in its currency index. */
  const seed = async (space: string, records: CurrencyRecord[]) => {
    const engine = await open({ url: toFileUrl(`${dir}/${space}.sqlite`) });
    storeCurrencyRecords(engine, {
      space,
      asOf: 0,
      seen: [],
      epoch: "epoch-one",
      records,
    });
    close(engine);
  };

  /** Opens the stores of `spaces`, in that order. */
  const examine = (spaces: string[]) => {
    refs = openSpaces(spaces.map((space) => `${dir}/${space}.sqlite`));
    return refs;
  };

  /** An edge as `writer space/piece -[document]-> reader space/piece`. */
  const shown = (edge: CurrencyReadEdge): string =>
    `${edge.from.space}/${edge.from.piece} -[${edge.id}]-> ` +
    `${edge.to.space}/${edge.to.piece}`;

  describe("currencyCycles()", () => {
    it("returns no cycle for spaces whose pieces read each other in a chain", async () => {
      await seed(A, [record("of:first", ["of:a"], [])]);
      await seed(B, [
        record("of:second", ["of:b"], [{ space: A, id: "of:a" }]),
      ]);
      await seed(C, [record("of:third", [], [{ space: B, id: "of:b" }])]);

      const result = currencyCycles(examine([A, B, C]));

      expect(result.cycles).toEqual([]);
      expect(result.cycleCount).toBe(0);
      expect(result.reads).toEqual([
        { from: A, to: B, documents: 1 },
        { from: B, to: C, documents: 1 },
      ]);
    });

    it("returns the cycle of two pieces in two spaces that read what the other writes, with the documents and slices", async () => {
      await seed(A, [
        record("of:first", ["of:a"], [{
          space: B,
          id: "of:b",
          slice: "user:alice",
        }]),
      ]);
      await seed(B, [
        record("of:second", ["of:b"], [{ space: A, id: "of:a" }]),
      ]);

      const result = currencyCycles(examine([A, B]));

      expect(result.cycles).toEqual([{
        edges: [
          {
            from: { space: A, piece: "of:first" },
            to: { space: B, piece: "of:second" },
            id: "of:a",
            slices: ["space"],
          },
          {
            from: { space: B, piece: "of:second" },
            to: { space: A, piece: "of:first" },
            id: "of:b",
            slices: ["user:alice"],
          },
        ],
        spaces: [A, B],
        pieces: 2,
      }]);
    });

    it("returns a cycle that passes through two pieces of one space", async () => {
      await seed(A, [
        record("of:first", ["of:a"], [{ space: A, id: "of:c" }]),
        record("of:third", ["of:c"], [{ space: B, id: "of:b" }]),
      ]);
      await seed(B, [
        record("of:second", ["of:b"], [{ space: A, id: "of:a" }]),
      ]);

      const [cycle] = currencyCycles(examine([A, B])).cycles;

      expect(cycle.edges.map(shown)).toEqual([
        `${A}/of:first -[of:a]-> ${B}/of:second`,
        `${B}/of:second -[of:b]-> ${A}/of:third`,
        `${A}/of:third -[of:c]-> ${A}/of:first`,
      ]);
      expect(cycle.pieces).toBe(3);
    });

    it("returns the shortest cycle through pieces that more than one cycle passes through", async () => {
      await seed(A, [
        record("of:first", ["of:a"], [
          { space: B, id: "of:b" },
          { space: A, id: "of:c" },
        ]),
        record("of:third", ["of:c"], [{ space: B, id: "of:b" }]),
      ]);
      await seed(B, [
        record("of:second", ["of:b"], [{ space: A, id: "of:a" }]),
      ]);

      const result = currencyCycles(examine([A, B]));

      expect(result.cycleCount).toBe(1);
      expect(result.cycles[0].edges).toHaveLength(2);
      expect(result.cycles[0].pieces).toBe(3);
    });

    it("returns no cycle for pieces of one space that read what each other write", async () => {
      await seed(A, [
        record("of:first", ["of:a"], [{ space: A, id: "of:c" }]),
        record("of:third", ["of:c"], [{ space: A, id: "of:a" }]),
      ]);

      expect(currencyCycles(examine([A])).cycles).toEqual([]);
    });

    it("returns no cycle through a document that no recorded piece writes", async () => {
      await seed(A, [record("of:first", [], [{ space: B, id: "of:b" }])]);
      await seed(B, [record("of:second", [], [{ space: A, id: "of:a" }])]);

      const result = currencyCycles(examine([A, B]));

      expect(result.cycles).toEqual([]);
      expect(result.reads).toEqual([
        { from: A, to: B, documents: 1 },
        { from: B, to: A, documents: 1 },
      ]);
    });

    it("names a space that was read and whose store was not given", async () => {
      await seed(A, [record("of:first", ["of:a"], [{ space: B, id: "of:b" }])]);

      const result = currencyCycles(examine([A]));

      expect(result.unexamined).toEqual([B]);
      expect(result.cycles).toEqual([]);
    });

    it("lists no more cycles than the limit, and counts them all", async () => {
      await seed(A, [
        record("of:first", ["of:a"], [{ space: B, id: "of:b" }]),
        record("of:other", ["of:x"], [{ space: B, id: "of:y" }]),
      ]);
      await seed(B, [
        record("of:second", ["of:b"], [{ space: A, id: "of:a" }]),
        record("of:another", ["of:y"], [{ space: A, id: "of:x" }]),
      ]);

      const result = currencyCycles(examine([A, B]), { limit: 1 });

      expect(result.cycles).toHaveLength(1);
      expect(result.cycleCount).toBe(2);
    });

    it("reports each store with the space it is of and how many pieces it recorded", async () => {
      await seed(A, [
        record("of:first", ["of:a"], []),
        record("of:third", ["of:c"], []),
      ]);
      await seed(B, []);

      expect(currencyCycles(examine([A, B])).spaces).toEqual([
        { label: `${A}.sqlite`, space: A, indexed: true, pieces: 2 },
        { label: `${B}.sqlite`, space: B, indexed: true, pieces: 0 },
      ]);
    });

    it("reports a store with no currency index as not indexed", () => {
      const bare = new Database(`${dir}/${A}.sqlite`, { create: true });
      bare.exec(`
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON,
  commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);`);
      bare.close();

      expect(currencyCycles(examine([A])).spaces).toEqual([
        { label: `${A}.sqlite`, space: A, indexed: false, pieces: 0 },
      ]);
    });
  });
});
