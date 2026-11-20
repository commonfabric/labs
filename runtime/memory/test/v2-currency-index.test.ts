import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  advanceCurrencyCursor,
  ANY_INSTANCE,
  applyCurrencyImports,
  type CurrencyRead,
  type CurrencyRecord,
  type CurrencySliceRecord,
  dropUnreadCurrencyImports,
  forgetCurrencySource,
  judgeCurrencyRoots,
  pullCurrencyExports,
  registerCurrencyReads,
  selectCurrencyPiece,
  selectCurrencyReadersMoved,
  selectCurrencySourcePosition,
  selectCurrencySources,
  storeCurrencyRecords,
} from "../v2/currency-index.ts";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import { resolveScopeKey } from "../v2.ts";

const SPACE = "did:key:z6Mk-currency-index-test-space";

/** A second space, whose store some cases read from. */
const SOURCE = "did:key:z6Mk-currency-index-test-source";
const EPOCH = "epoch-one";

/** The two viewers of these tests, and the scope keys of their instances. */
const ALICE = { principal: "did:key:alice", sessionId: "session-one" };
const BOB = { principal: "did:key:bob", sessionId: "session-two" };
const ALICE_USER = resolveScopeKey("user", ALICE);
const ALICE_SESSION = resolveScopeKey("session", ALICE);
const BOB_USER = resolveScopeKey("user", BOB);

describe("currency-index", () => {
  let engine: Engine;
  let path: string;
  let localSeq: number;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  /**
   * Commits a write to each of `ids` as `viewer`, and returns the commit's
   * seq. An id given with a scope is written at that viewer's instance.
   */
  const writeAs = (
    viewer: { principal: string; sessionId: string },
    ...ids: Array<string | { id: string; scope: "user" | "session" }>
  ): number => {
    localSeq += 1;
    return applyCommit(engine, {
      sessionId: viewer.sessionId,
      principal: viewer.principal,
      space: SPACE,
      commit: {
        localSeq,
        reads: { confirmed: [], pending: [] },
        operations: ids.map((entry) => ({
          op: "set" as const,
          ...(typeof entry === "string" ? { id: entry } : entry),
          value: { value: { n: localSeq } },
        })),
      },
    }).seq;
  };

  /** Commits a write to each of `ids` as Alice. */
  const write = (
    ...ids: Array<string | { id: string; scope: "user" | "session" }>
  ): number => writeAs(ALICE, ...ids);

  /** A slice at `key`, vouched for, that read `reads` and vouches for `vouches`. */
  const slice = (
    key: string,
    reads: CurrencyRead[] = [],
    vouches: string[] = [],
  ): CurrencySliceRecord => ({ key, vouched: true, reads, vouches });

  /**
   * What a test says of a record: its piece-level parts, the reads of its
   * `space` slice, the instances it vouches for, each filed under the slice
   * at its scope key, and any further slices in full.
   */
  type Parts = {
    under?: string[];
    vouched?: boolean;
    reads?: CurrencyRead[];
    writes?: string[];
    /** Ids the piece writes and vouches for the shared instance of. */
    produces?: string[];
    owned?: string[];
    vouches?: Array<{ id: string; scopeKey: string }>;
    slices?: CurrencySliceRecord[];
  };

  /** A record of `piece`, vouched for, with `parts` over the empty ones. */
  const record = (piece: string, parts: Parts = {}): CurrencyRecord => {
    const slices = new Map<
      string,
      {
        key: string;
        vouched: boolean;
        reads: CurrencyRead[];
        vouches: string[];
      }
    >();
    const sliceAt = (key: string) => {
      let slice = slices.get(key);
      if (slice === undefined) {
        slice = { key, vouched: true, reads: [], vouches: [] };
        slices.set(key, slice);
      }
      return slice;
    };
    // A record of a piece names its `space` slice, whatever else it names.
    sliceAt("space");
    for (const read of parts.reads ?? []) sliceAt("space").reads.push(read);
    for (const { id, scopeKey } of parts.vouches ?? []) {
      sliceAt(scopeKey).vouches.push(id);
    }
    for (const id of parts.produces ?? []) sliceAt("space").vouches.push(id);
    for (const given of parts.slices ?? []) {
      const merged = sliceAt(given.key);
      merged.vouched &&= given.vouched;
      for (const read of given.reads) merged.reads.push(read);
      for (const id of given.vouches) merged.vouches.push(id);
    }
    return {
      piece,
      under: parts.under ?? [],
      vouched: parts.vouched ?? true,
      writes: [...(parts.writes ?? []), ...(parts.produces ?? [])],
      owned: parts.owned ?? [],
      slices: [...slices.values()],
    };
  };

  /** A read of the shared instance of the input document `id`. */
  const input = (id: string, scopeKey = "space"): CurrencyRead => ({
    space: SPACE,
    id,
    scopeKey,
    derived: false,
  });

  /** A read of `id`, a document some computation writes. */
  const derived = (id: string, scopeKey = "space"): CurrencyRead => ({
    space: SPACE,
    id,
    scopeKey,
    derived: true,
  });

  /** Stores `records` as taken at `asOf`, having seen the commits `seen`. */
  const store = (
    asOf: number,
    records: CurrencyRecord[],
    seen: number[] = [],
  ) =>
    storeCurrencyRecords(engine, {
      space: SPACE,
      asOf,
      seen,
      epoch: EPOCH,
      records,
    });

  /** The mark the slice `slice` of `piece` holds. */
  const markOf = (piece: string, slice = "space") =>
    selectCurrencyPiece(engine, { piece, slice })?.mark;

  /** The pieces an advance of the cursor reports a slice of, sorted. */
  const advance = () =>
    [
      ...new Set(
        advanceCurrencyCursor(engine, { space: SPACE }).map(({ piece }) =>
          piece
        ),
      ),
    ].sort();

  describe("advanceCurrencyCursor()", () => {
    it("marks `2` a piece that read a document with a revision above its read row", () => {
      const asOf = write("of:a");
      store(asOf, [record("of:piece", { reads: [input("of:a")] })]);
      expect(markOf("of:piece")).toBe(0);

      const changed = write("of:a");

      expect(advanceCurrencyCursor(engine, { space: SPACE })).toEqual([
        { piece: "of:piece", slice: "space", seq: changed, under: [] },
      ]);
      expect(markOf("of:piece")).toBe(2);
    });

    it("leaves clean a piece whose rows stand at the revisions it reads", () => {
      write("of:a");
      const asOf = write("of:a", "of:unread");
      store(asOf, [record("of:piece", { reads: [input("of:a")] })]);

      write("of:unread");

      expect(advance()).toEqual([]);
      expect(markOf("of:piece")).toBe(0);
    });

    it("marks `2` a piece when an instance it vouches for has a revision above its vouch row", () => {
      const asOf = write("computed:out");
      store(asOf, [
        record("of:piece", {
          writes: ["computed:out"],
          vouches: [{ id: "computed:out", scopeKey: "space" }],
        }),
      ]);

      write("computed:out");

      expect(advance()).toEqual(["of:piece"]);
      expect(markOf("of:piece")).toBe(2);
    });

    it("leaves clean a piece when a document it writes and does not vouch for is written", () => {
      const asOf = write("computed:out");
      store(asOf, [record("of:piece", { writes: ["computed:out"] })]);

      write("computed:out");

      expect(advance()).toEqual([]);
      expect(markOf("of:piece")).toBe(0);
    });

    it("leaves clean a piece when a cell it owns and did not read is written", () => {
      const asOf = write("of:state");
      store(asOf, [record("of:piece", { owned: ["of:state"] })]);

      write("of:state");

      expect(advance()).toEqual([]);
      expect(markOf("of:piece")).toBe(0);
    });

    it("marks `2` a piece when its own result document is written", () => {
      const asOf = write("of:piece");
      store(asOf, [record("of:piece")]);

      write("of:piece");

      expect(advance()).toEqual(["of:piece"]);
    });

    it("marks `1` each clean piece downstream of one that became marked, through a chain", () => {
      const asOf = write("of:a", "computed:b", "computed:c");
      store(asOf, [
        record("of:pieceB", {
          reads: [input("of:a")],
          produces: ["computed:b"],
        }),
        record("of:pieceC", {
          reads: [derived("computed:b")],
          produces: ["computed:c"],
        }),
        record("of:pieceD", { reads: [derived("computed:c")] }),
      ]);
      expect([markOf("of:pieceB"), markOf("of:pieceC"), markOf("of:pieceD")])
        .toEqual([0, 0, 0]);

      const changed = write("of:a");

      expect(advanceCurrencyCursor(engine, { space: SPACE })).toEqual([
        { piece: "of:pieceB", slice: "space", seq: changed, under: [] },
        { piece: "of:pieceC", slice: "space", seq: changed, under: [] },
        { piece: "of:pieceD", slice: "space", seq: changed, under: [] },
      ]);
      expect([markOf("of:pieceB"), markOf("of:pieceC"), markOf("of:pieceD")])
        .toEqual([2, 1, 1]);
    });

    it("reports a piece two marked pieces feed at the earlier one's seq", () => {
      const asOf = write(
        "of:a",
        "of:x",
        "computed:b",
        "computed:y",
        "computed:c",
      );
      store(asOf, [
        record("of:pieceB", {
          reads: [input("of:a")],
          produces: ["computed:b"],
        }),
        record("of:pieceY", {
          reads: [input("of:x")],
          produces: ["computed:y"],
        }),
        record("of:pieceC", {
          reads: [derived("computed:b"), derived("computed:y")],
          produces: ["computed:c"],
        }),
        record("of:pieceD", { reads: [derived("computed:c")] }),
      ]);
      const first = write("of:x");
      const second = write("of:a");

      const marked = advanceCurrencyCursor(engine, { space: SPACE });

      expect(
        Object.fromEntries(marked.map(({ piece, seq }) => [piece, seq])),
      ).toEqual({
        "of:pieceB": second,
        "of:pieceY": first,
        "of:pieceC": first,
        "of:pieceD": first,
      });
    });

    it("reports nothing downstream of a piece that was already marked", () => {
      const asOf = write("of:a", "of:other", "computed:b", "computed:c");
      store(asOf, [
        record("of:pieceB", {
          reads: [input("of:a")],
          produces: ["computed:b"],
        }),
        record("of:pieceC", {
          reads: [derived("computed:b"), input("of:other")],
          produces: ["computed:c"],
        }),
        record("of:pieceD", { reads: [derived("computed:c")] }),
      ]);
      write("of:other");
      expect(advance()).toEqual(["of:pieceC", "of:pieceD"]);

      write("of:a");

      expect(advance()).toEqual(["of:pieceB"]);
      expect([markOf("of:pieceB"), markOf("of:pieceC"), markOf("of:pieceD")])
        .toEqual([2, 2, 1]);
    });

    it("marks the slice that read the instance that changed, and no other", () => {
      const asOf = Math.max(
        write({ id: "of:prefs", scope: "user" }),
        writeAs(BOB, { id: "of:prefs", scope: "user" }),
      );
      store(asOf, [
        record("of:piece", {
          slices: [
            slice(ALICE_USER, [input("of:prefs", ALICE_USER)]),
            slice(BOB_USER, [input("of:prefs", BOB_USER)]),
          ],
        }),
      ]);

      const changed = write({ id: "of:prefs", scope: "user" });

      expect(advanceCurrencyCursor(engine, { space: SPACE })).toEqual([
        { piece: "of:piece", slice: ALICE_USER, seq: changed, under: [] },
      ]);
      expect([
        markOf("of:piece"),
        markOf("of:piece", ALICE_USER),
        markOf("of:piece", BOB_USER),
      ]).toEqual([0, 2, 0]);
    });

    it("marks each slice that read a shared instance that changed", () => {
      const asOf = write("of:shared");
      store(asOf, [
        record("of:piece", {
          slices: [
            slice(ALICE_USER, [input("of:shared")]),
            slice(BOB_USER, [input("of:shared")]),
          ],
        }),
      ]);

      write("of:shared");
      advance();

      expect([
        markOf("of:piece"),
        markOf("of:piece", ALICE_USER),
        markOf("of:piece", BOB_USER),
      ]).toEqual([0, 2, 2]);
    });

    it("marks a slice that read an instance it could not name when any instance of the document changes", () => {
      const asOf = write("of:prefs");
      store(asOf, [
        record("of:piece", { reads: [input("of:prefs", ANY_INSTANCE)] }),
      ]);

      writeAs(BOB, { id: "of:prefs", scope: "user" });

      expect(advance()).toEqual(["of:piece"]);
    });

    it("marks the slice at the key of a vouched instance that was written, and no other", () => {
      const asOf = Math.max(
        write("computed:out", { id: "computed:out", scope: "user" }),
        writeAs(BOB, { id: "computed:out", scope: "user" }),
      );
      store(asOf, [
        record("of:piece", {
          writes: ["computed:out"],
          vouches: [
            { id: "computed:out", scopeKey: "space" },
            { id: "computed:out", scopeKey: ALICE_USER },
            { id: "computed:out", scopeKey: BOB_USER },
          ],
        }),
      ]);

      writeAs(BOB, { id: "computed:out", scope: "user" });
      advance();

      expect([
        markOf("of:piece"),
        markOf("of:piece", ALICE_USER),
        markOf("of:piece", BOB_USER),
      ]).toEqual([0, 0, 2]);
    });

    it("marks `1` the slices downstream of a marked slice that read an instance at its key or beneath it", () => {
      const asOf = Math.max(
        write(
          { id: "of:prefs", scope: "user" },
          { id: "computed:b", scope: "user" },
          { id: "computed:b", scope: "session" },
        ),
        writeAs(BOB, { id: "computed:b", scope: "user" }),
      );
      store(asOf, [
        record("of:pieceB", {
          writes: ["computed:b"],
          vouches: [ALICE_USER, ALICE_SESSION, BOB_USER].map((scopeKey) => ({
            id: "computed:b",
            scopeKey,
          })),
          slices: [slice(ALICE_USER, [input("of:prefs", ALICE_USER)])],
        }),
        record("of:pieceC", {
          slices: [
            slice(ALICE_USER, [derived("computed:b", ALICE_USER)]),
            slice(ALICE_SESSION, [derived("computed:b", ALICE_SESSION)]),
            slice(BOB_USER, [derived("computed:b", BOB_USER)]),
          ],
        }),
      ]);

      write({ id: "of:prefs", scope: "user" });
      advance();

      expect([
        markOf("of:pieceC"),
        markOf("of:pieceC", ALICE_USER),
        markOf("of:pieceC", ALICE_SESSION),
        markOf("of:pieceC", BOB_USER),
      ]).toEqual([0, 1, 1, 0]);
    });

    it("marks `1` every slice downstream of a marked `space` slice", () => {
      const asOf = Math.max(
        write("of:a", { id: "computed:b", scope: "user" }),
        writeAs(BOB, { id: "computed:b", scope: "user" }),
      );
      store(asOf, [
        record("of:pieceB", {
          reads: [input("of:a")],
          writes: ["computed:b"],
          vouches: [ALICE_USER, BOB_USER].map((scopeKey) => ({
            id: "computed:b",
            scopeKey,
          })),
        }),
        record("of:pieceC", {
          slices: [
            slice(ALICE_USER, [derived("computed:b", ALICE_USER)]),
            slice(BOB_USER, [derived("computed:b", BOB_USER)]),
          ],
        }),
      ]);
      expect([
        markOf("of:pieceC", ALICE_USER),
        markOf("of:pieceC", BOB_USER),
      ]).toEqual([0, 0]);

      write("of:a");
      advance();

      expect([
        markOf("of:pieceC", ALICE_USER),
        markOf("of:pieceC", BOB_USER),
      ]).toEqual([1, 1]);
    });

    it("names the pieces that enclose a marked piece", () => {
      const asOf = write("of:a");
      store(asOf, [
        record("of:nested", { reads: [input("of:a")], under: ["of:outer"] }),
      ]);

      const changed = write("of:a");

      expect(advanceCurrencyCursor(engine, { space: SPACE })).toEqual([
        {
          piece: "of:nested",
          slice: "space",
          seq: changed,
          under: ["of:outer"],
        },
      ]);
    });

    it("returns nothing from a second advance with no commit between", () => {
      const asOf = write("of:a");
      store(asOf, [record("of:piece", { reads: [input("of:a")] })]);
      write("of:a");
      expect(advance()).toEqual(["of:piece"]);

      expect(advance()).toEqual([]);
    });

    it("returns nothing over a store that holds no record", () => {
      write("of:a");

      expect(advance()).toEqual([]);
    });
  });

  describe("storeCurrencyRecords()", () => {
    it("stores marked `2` a record that is not vouched for", () => {
      const asOf = write("of:a");

      store(asOf, [
        record("of:piece", { vouched: false, reads: [input("of:a")] }),
      ]);

      expect(selectCurrencyPiece(engine, { piece: "of:piece" })).toEqual({
        mark: 2,
        epoch: EPOCH,
      });
    });

    it("stores marked `2` a record that read a document committed above `asOf` and not seen", () => {
      const asOf = write("of:a");
      write("of:a");

      store(asOf, [record("of:piece", { reads: [input("of:a")] })]);

      expect(markOf("of:piece")).toBe(2);
    });

    it("names as behind a vouched-for piece it stored marked for a commit above `asOf`, and not one that is not vouched for", () => {
      const asOf = write("of:a");
      write("of:a");

      const stored = store(asOf, [
        record("of:piece", { reads: [input("of:a")] }),
        record("of:other", { vouched: false, reads: [input("of:a")] }),
      ]);

      expect(stored.behind).toEqual(["of:piece"]);
    });

    it("stores clean a record whose only commits above `asOf` are ones it saw", () => {
      const asOf = write("of:a");
      const own = write("computed:out");

      store(
        asOf,
        [
          record("of:piece", {
            reads: [input("of:a")],
            writes: ["computed:out"],
          }),
        ],
        [own],
      );

      expect(markOf("of:piece")).toBe(0);
      write("of:unrelated");
      expect(advance()).toEqual([]);
    });

    it("stores marked `2` a record with one seen and one unseen commit above `asOf` on a document it read", () => {
      const asOf = write("of:a");
      write("of:a");
      const own = write("of:a");

      store(asOf, [record("of:piece", { reads: [input("of:a")] })], [own]);

      expect(markOf("of:piece")).toBe(2);
    });

    it("stores marked `1` a piece that read a derived document no recorded piece writes", () => {
      const asOf = write("computed:b");

      const stored = store(asOf, [
        record("of:pieceC", { reads: [derived("computed:b")] }),
      ]);

      expect(markOf("of:pieceC")).toBe(1);
      expect(stored.blockedBy).toEqual([]);
    });

    it("clears a piece marked `1` once the piece that writes its input is stored clean", () => {
      const asOf = write("computed:b");
      store(asOf, [record("of:pieceC", { reads: [derived("computed:b")] })]);
      expect(markOf("of:pieceC")).toBe(1);

      store(asOf, [record("of:pieceB", { produces: ["computed:b"] })]);

      expect(markOf("of:pieceC")).toBe(0);
    });

    it("stores marked `1` a piece whose input a marked piece writes, and names that piece", () => {
      const asOf = write("of:a", "computed:b");
      store(asOf, [
        record("of:pieceB", {
          reads: [input("of:a")],
          produces: ["computed:b"],
        }),
      ]);
      const changed = write("of:a");

      const stored = store(changed, [
        record("of:pieceC", { reads: [derived("computed:b")] }),
      ]);

      expect(markOf("of:pieceB")).toBe(2);
      expect(markOf("of:pieceC")).toBe(1);
      expect(stored.blocked).toEqual(["of:pieceC"]);
      expect(stored.blockedBy).toEqual(["of:pieceB"]);
    });

    it("stores marked `1` a piece that read, as an input, a document a marked piece writes", () => {
      // A runtime that does not hold the producer records its output as a
      // plain input.

      const asOf = write("of:a", "of:b");
      store(asOf, [
        record("of:pieceB", { reads: [input("of:a")], produces: ["of:b"] }),
      ]);
      const changed = write("of:a");

      store(changed, [record("of:pieceC", { reads: [input("of:b")] })]);

      expect([markOf("of:pieceB"), markOf("of:pieceC")]).toEqual([2, 1]);
    });

    it("clears the pieces marked `1` downstream of a piece stored clean, through a chain", () => {
      const asOf = write("of:a", "computed:b", "computed:c");
      store(asOf, [
        record("of:pieceB", {
          reads: [input("of:a")],
          produces: ["computed:b"],
        }),
        record("of:pieceC", {
          reads: [derived("computed:b")],
          produces: ["computed:c"],
        }),
        record("of:pieceD", { reads: [derived("computed:c")] }),
      ]);
      const changed = write("of:a");
      expect(advance()).toEqual(["of:pieceB", "of:pieceC", "of:pieceD"]);

      store(changed, [
        record("of:pieceB", {
          reads: [input("of:a")],
          produces: ["computed:b"],
        }),
      ]);

      expect([markOf("of:pieceB"), markOf("of:pieceC"), markOf("of:pieceD")])
        .toEqual([0, 0, 0]);
    });

    it("leaves marked `2` a piece downstream of one stored clean", () => {
      const asOf = write("of:a", "of:other", "computed:b");
      store(asOf, [
        record("of:pieceB", {
          reads: [input("of:a")],
          produces: ["computed:b"],
        }),
        record("of:pieceC", {
          reads: [derived("computed:b"), input("of:other")],
        }),
      ]);
      write("of:a");
      const changed = write("of:other");
      advance();
      expect(markOf("of:pieceC")).toBe(2);

      store(changed, [
        record("of:pieceB", {
          reads: [input("of:a")],
          produces: ["computed:b"],
        }),
      ]);

      expect(markOf("of:pieceB")).toBe(0);
      expect(markOf("of:pieceC")).toBe(2);
    });

    it("leaves marked `1` a piece with a second marked producer", () => {
      const asOf = write("of:a", "of:x", "computed:b", "computed:y");
      store(asOf, [
        record("of:pieceB", {
          reads: [input("of:a")],
          produces: ["computed:b"],
        }),
        record("of:pieceY", {
          reads: [input("of:x")],
          produces: ["computed:y"],
        }),
        record("of:pieceC", {
          reads: [derived("computed:b"), derived("computed:y")],
        }),
      ]);
      const changed = write("of:a", "of:x");
      advance();

      store(changed, [
        record("of:pieceB", {
          reads: [input("of:a")],
          produces: ["computed:b"],
        }),
      ]);

      expect(markOf("of:pieceC")).toBe(1);
    });

    it("settles together two pieces of one batch that read each other's writes", () => {
      const asOf = write("computed:b", "computed:c");

      store(asOf, [
        record("of:pieceC", {
          reads: [derived("computed:b")],
          produces: ["computed:c"],
        }),
        record("of:pieceB", {
          reads: [derived("computed:c")],
          produces: ["computed:b"],
        }),
      ]);

      expect([markOf("of:pieceB"), markOf("of:pieceC")]).toEqual([0, 0]);
    });

    it("settles a piece an earlier batch stored with one that names it and writes its input", () => {
      const asOf = write("computed:b", "computed:c");
      store(asOf, [
        record("of:pieceC", {
          reads: [derived("computed:b")],
          produces: ["computed:c"],
        }),
      ]);
      expect(markOf("of:pieceC")).toBe(1);

      storeCurrencyRecords(engine, {
        space: SPACE,
        asOf,
        seen: [],
        epoch: EPOCH,
        records: [
          record("of:pieceB", {
            reads: [derived("computed:c")],
            produces: ["computed:b"],
          }),
        ],
        settle: ["of:pieceC"],
      });

      expect([markOf("of:pieceB"), markOf("of:pieceC")]).toEqual([0, 0]);
    });

    it("leaves marked `1` a named piece of an earlier batch that reads a document no record writes", () => {
      const asOf = write("computed:b", "computed:c", "computed:z");
      store(asOf, [
        record("of:pieceC", {
          reads: [derived("computed:b"), derived("computed:z")],
          produces: ["computed:c"],
        }),
      ]);

      storeCurrencyRecords(engine, {
        space: SPACE,
        asOf,
        seen: [],
        epoch: EPOCH,
        records: [
          record("of:pieceB", {
            reads: [derived("computed:c")],
            produces: ["computed:b"],
          }),
        ],
        settle: ["of:pieceC"],
      });

      expect([markOf("of:pieceB"), markOf("of:pieceC")]).toEqual([1, 1]);
    });

    it("stores marked `2` a record that read a document in another space", () => {
      const asOf = write("of:a");

      store(asOf, [
        record("of:pieceB", {
          reads: [
            input("of:a"),
            {
              space: "did:key:z6Mk-another-space",
              id: "of:far",
              scopeKey: "space",
              derived: false,
            },
          ],
        }),
      ]);

      expect(markOf("of:pieceB")).toBe(2);
    });

    it("keeps marked a piece whose output a commit that is no derivation overwrote, through a later record of it", () => {
      const vouching = record("of:piece", {
        writes: ["computed:out"],
        vouches: [{ id: "computed:out", scopeKey: "space" }],
      });
      const asOf = write("of:piece", "computed:out");
      store(asOf, [vouching]);
      const overwritten = write("computed:out");
      expect(advance()).toEqual(["of:piece"]);

      const stored = store(overwritten, [vouching]);

      expect(markOf("of:piece")).toBe(2);
      expect(stored.behind).toEqual([]);
    });

    it("clears a piece whose output was overwritten once a commit it names as seen writes it again", () => {
      const vouching = record("of:piece", {
        writes: ["computed:out"],
        vouches: [{ id: "computed:out", scopeKey: "space" }],
      });
      const asOf = write("of:piece", "computed:out");
      store(asOf, [vouching]);
      const overwritten = write("computed:out");
      store(overwritten, [vouching]);
      const own = write("computed:out");

      store(overwritten, [vouching], [own]);

      expect(markOf("of:piece")).toBe(0);
    });

    it("keeps marked a piece whose vouched instance was overwritten below another instance's head", () => {
      const vouching = record("of:piece", {
        writes: ["computed:out"],
        vouches: [
          { id: "computed:out", scopeKey: "space" },
          { id: "computed:out", scopeKey: ALICE_USER },
        ],
      });
      const asOf = write("of:piece", "computed:out");
      store(asOf, [vouching]);
      write("computed:out");
      const own = write({ id: "computed:out", scope: "user" });

      store(own, [vouching], [own]);

      expect(markOf("of:piece")).toBe(2);
    });

    it("leaves a slice the record does not name with its rows and its mark", () => {
      const asOf = Math.max(
        write("of:piece", { id: "computed:out", scope: "user" }),
        writeAs(BOB, { id: "computed:out", scope: "user" }),
      );
      store(asOf, [
        record("of:piece", {
          writes: ["computed:out"],
          vouches: [{ id: "computed:out", scopeKey: ALICE_USER }],
        }),
      ]);

      store(asOf, [
        record("of:piece", {
          writes: ["computed:out"],
          vouches: [{ id: "computed:out", scopeKey: BOB_USER }],
        }),
      ]);

      expect([
        markOf("of:piece", ALICE_USER),
        markOf("of:piece", BOB_USER),
      ]).toEqual([0, 0]);
      expect(
        judgeCurrencyRoots(engine, {
          space: SPACE,
          roots: ["of:piece"],
          rows: [
            { id: "computed:out", scopeKey: ALICE_USER },
            { id: "computed:out", scopeKey: BOB_USER },
          ],
          epoch: EPOCH,
        }).servable,
      ).toEqual(["of:piece"]);
    });

    it("stores a `space` slice for a record that names none", () => {
      const asOf = write("of:piece");

      store(asOf, [
        { ...record("of:piece"), slices: [slice(ALICE_USER)] },
      ]);

      expect([markOf("of:piece"), markOf("of:piece", ALICE_USER)]).toEqual([
        0,
        0,
      ]);
    });

    it("stores marked `2` every slice of a record whose piece is not vouched for", () => {
      const asOf = write("of:piece");

      store(asOf, [
        record("of:piece", { vouched: false, slices: [slice(ALICE_USER)] }),
      ]);

      expect([markOf("of:piece"), markOf("of:piece", ALICE_USER)]).toEqual([
        2,
        2,
      ]);
    });

    it("stores marked `2` a slice that is not vouched for, and clean the others of its record", () => {
      const asOf = write("of:piece");

      store(asOf, [
        record("of:piece", {
          slices: [{ ...slice(ALICE_USER), vouched: false }, slice(BOB_USER)],
        }),
      ]);

      expect([
        markOf("of:piece"),
        markOf("of:piece", ALICE_USER),
        markOf("of:piece", BOB_USER),
      ]).toEqual([0, 2, 0]);
    });

    it("clears a slice marked `1` once the slice that writes its input is stored clean, and leaves another viewer's marked", () => {
      const asOf = Math.max(
        write(
          { id: "of:prefs", scope: "user" },
          { id: "computed:b", scope: "user" },
        ),
        writeAs(
          BOB,
          { id: "of:prefs", scope: "user" },
          { id: "computed:b", scope: "user" },
        ),
      );
      const producer = (...keys: string[]) =>
        record("of:pieceB", {
          writes: ["computed:b"],
          slices: keys.map((key) =>
            slice(key, [input("of:prefs", key)], ["computed:b"])
          ),
        });
      store(asOf, [
        producer(ALICE_USER, BOB_USER),
        record("of:pieceC", {
          slices: [
            slice(ALICE_USER, [derived("computed:b", ALICE_USER)]),
            slice(BOB_USER, [derived("computed:b", BOB_USER)]),
          ],
        }),
      ]);
      const changed = Math.max(
        write({ id: "of:prefs", scope: "user" }),
        writeAs(BOB, { id: "of:prefs", scope: "user" }),
      );
      advance();

      store(changed, [producer(ALICE_USER)]);

      expect([
        markOf("of:pieceC", ALICE_USER),
        markOf("of:pieceC", BOB_USER),
      ]).toEqual([0, 1]);
    });

    it("leaves the `space` slice as it is for a record that names none, when the piece has one", () => {
      const asOf = write("of:piece", "of:a");
      store(asOf, [record("of:piece", { reads: [input("of:a")] })]);
      write("of:a");
      advance();

      store(asOf, [{ ...record("of:piece"), slices: [slice(ALICE_USER)] }]);

      expect([markOf("of:piece"), markOf("of:piece", ALICE_USER)]).toEqual([
        2,
        0,
      ]);
    });

    describe("with a viewer's slice that read what the `space` slice computes", () => {
      /** The `space` slice computes `x` from `i`, and Bob's reads `x`. */
      const forBob = record("of:piece", {
        reads: [input("of:i")],
        produces: ["computed:x"],
        writes: ["computed:out"],
        slices: [slice(BOB_USER, [derived("computed:x")], ["computed:out"])],
      });

      /** The piece as a visit that runs neither computation records it. */
      const withoutEither = record("of:piece", {
        writes: ["computed:x", "computed:out"],
      });

      const BOB_ROW = { id: "computed:out", scopeKey: BOB_USER };

      /** Stores `forBob`, changes `i`, and stores `withoutEither`. */
      const recordWithoutTheComputation = (): number => {
        const asOf = Math.max(
          write("of:piece", "of:i", "computed:x"),
          writeAs(BOB, { id: "computed:out", scope: "user" }),
        );
        store(asOf, [forBob]);
        const changed = write("of:i");
        advance();
        store(changed, [withoutEither]);
        return changed;
      };

      it("marks `1` the viewer's slice once a record of the `space` slice no longer vouches for what it read", () => {
        recordWithoutTheComputation();

        expect([markOf("of:piece"), markOf("of:piece", BOB_USER)]).toEqual([
          0,
          1,
        ]);
      });

      it("refuses the root for that viewer", () => {
        recordWithoutTheComputation();

        expect(
          judgeCurrencyRoots(engine, {
            space: SPACE,
            roots: ["of:piece"],
            rows: [BOB_ROW],
            epoch: EPOCH,
          }).refused,
        ).toEqual([{ root: "of:piece", reason: "owner-not-clean" }]);
      });

      it("clears the viewer's slice once the `space` slice vouches for it again with the instance unchanged", () => {
        const changed = recordWithoutTheComputation();

        store(changed, [{ ...forBob, slices: [forBob.slices[0]] }]);

        expect(markOf("of:piece", BOB_USER)).toBe(0);
      });
    });

    it("keeps marked a piece whose overwritten output one record stops vouching for and a later one vouches for again", () => {
      const vouching = record("of:piece", { produces: ["computed:out"] });
      const asOf = write("of:piece", "computed:out");
      store(asOf, [vouching]);
      const overwritten = write("computed:out");
      advance();
      store(overwritten, [
        record("of:piece", { writes: ["computed:out"] }),
      ]);
      expect(markOf("of:piece")).toBe(0);

      store(overwritten, [vouching]);

      expect(markOf("of:piece")).toBe(2);
    });

    it("stores marked `2` a first record that vouches for an instance overwritten after a derivation wrote it", () => {
      write("of:piece");
      const own = write("computed:out");
      const overwritten = write("computed:out");

      store(
        overwritten,
        [record("of:piece", { produces: ["computed:out"] })],
        [own],
      );

      expect(markOf("of:piece")).toBe(2);
    });

    it("stores clean a first record that vouches for an instance no derivation wrote", () => {
      const asOf = write("of:piece", "computed:out");

      store(asOf, [record("of:piece", { produces: ["computed:out"] })]);

      expect(markOf("of:piece")).toBe(0);
    });

    it("stores clean a piece that vouches for an instance a client wrote above the `asOf` of its first record, once a record covers that write", () => {
      // The first record is taken below the client's write, so it answers
      // for the instance at no seq, and the write is not an overwrite of
      // anything the piece vouched for.

      const vouching = record("of:piece", { produces: ["computed:out"] });
      const before = write("of:piece");
      const created = write("computed:out");
      store(before, [vouching]);
      expect(markOf("of:piece")).toBe(2);

      store(created, [vouching]);

      expect(markOf("of:piece")).toBe(0);
    });

    it("keeps marked a piece whose output was overwritten above the `asOf` of a record of it, through a later record that covers the overwrite", () => {
      const vouching = record("of:piece", { produces: ["computed:out"] });
      const asOf = write("of:piece", "computed:out");
      store(asOf, [vouching]);
      const overwritten = write("computed:out");
      store(asOf, [vouching]);

      store(overwritten, [vouching]);

      expect(markOf("of:piece")).toBe(2);
    });

    it("replaces a piece's rows as a set", () => {
      const asOf = write("of:a", "of:b");
      store(asOf, [record("of:piece", { reads: [input("of:a")] })]);
      store(asOf, [record("of:piece", { reads: [input("of:b")] })]);

      write("of:a");

      expect(advance()).toEqual([]);
    });

    describe("the `falseClean` it reports", () => {
      const vouching = (reads: string[] = ["of:a"]) =>
        record("of:piece", {
          reads: reads.map((id) => input(id)),
          writes: ["computed:out"],
          vouches: [{ id: "computed:out", scopeKey: "space" }],
        });

      it("names a clean piece that wrote an instance it vouched for again with no input changed", () => {
        const asOf = write("of:a", "computed:out");
        store(asOf, [vouching()]);
        const own = write("computed:out");

        const stored = store(asOf, [vouching()], [own]);

        expect(stored.falseClean).toEqual(["of:piece"]);
      });

      it("names each piece of a wave stored in separate batches", () => {
        const second = record("of:second", {
          writes: ["computed:second"],
          vouches: [{ id: "computed:second", scopeKey: "space" }],
        });
        const asOf = write("of:a", "computed:out", "computed:second");
        store(asOf, [vouching(), second]);
        const own = write("computed:out", "computed:second");

        const first = store(asOf, [vouching()], [own]);
        const rest = store(asOf, [second], [own]);

        expect(first.falseClean).toEqual(["of:piece"]);
        expect(rest.falseClean).toEqual(["of:second"]);
      });

      it("names a piece an advance of the cursor marked before its record was stored", () => {
        const asOf = write("of:a", "computed:out");
        store(asOf, [vouching()]);
        const own = write("computed:out");
        expect(advance()).toEqual(["of:piece"]);

        const stored = store(asOf, [vouching()], [own]);

        expect(stored.falseClean).toEqual(["of:piece"]);
      });

      it("names a piece one of whose slices wrote its vouched instance again with no input changed", () => {
        const viewer = record("of:piece", {
          writes: ["computed:out"],
          vouches: [{ id: "computed:out", scopeKey: ALICE_USER }],
          slices: [slice(ALICE_USER, [input("of:a")])],
        });
        const asOf = write("of:a", { id: "computed:out", scope: "user" });
        store(asOf, [viewer]);
        const own = write({ id: "computed:out", scope: "user" });

        const stored = store(asOf, [viewer], [own]);

        expect(stored.falseClean).toEqual(["of:piece"]);
      });

      it("is empty for a piece that was never clean", () => {
        const asOf = write("of:a", "computed:out");
        store(asOf, [{ ...vouching(), vouched: false }]);
        const own = write("computed:out");

        const stored = store(asOf, [vouching()], [own]);

        expect(stored.falseClean).toEqual([]);
      });

      it("is empty when a document the piece read changed first", () => {
        const asOf = write("of:a", "computed:out");
        store(asOf, [vouching()]);
        const changed = write("of:a");
        const own = write("computed:out");

        const stored = store(changed, [vouching()], [own]);

        expect(stored.falseClean).toEqual([]);
      });

      it("is empty when the piece wrote only an instance it had not vouched for", () => {
        const asOf = write("of:a", "computed:out");
        store(asOf, [vouching()]);
        const own = write({ id: "computed:out", scope: "user" });

        const stored = store(asOf, [vouching()], [own]);

        expect(stored.falseClean).toEqual([]);
      });

      it("is empty when the document was written by a commit the loop did not make", () => {
        const asOf = write("of:a", "computed:out");
        store(asOf, [vouching()]);
        const foreign = write("computed:out");

        const stored = store(foreign, [vouching()]);

        expect(stored.falseClean).toEqual([]);
      });
    });
  });

  describe("judgeCurrencyRoots()", () => {
    const judge = (
      roots: string[],
      rows: Array<{ id: string; scopeKey: string }>,
      epoch = EPOCH,
    ) =>
      judgeCurrencyRoots(engine, { space: SPACE, roots, rows, epoch }).servable;

    /** The reason each of `roots` is refused for, by root. */
    const refusals = (
      roots: string[],
      rows: Array<{ id: string; scopeKey: string }>,
      epoch = EPOCH,
    ) =>
      Object.fromEntries(
        judgeCurrencyRoots(engine, { space: SPACE, roots, rows, epoch })
          .refused.map(({ root, reason }) => [root, reason]),
      );

    /** A clean record of `of:piece` that vouches for its one output. */
    const storeVouching = (parts: Parts = {}): number => {
      const asOf = write("of:piece", "computed:out", "of:state");
      store(asOf, [
        record("of:piece", {
          writes: ["computed:out"],
          vouches: [{ id: "computed:out", scopeKey: "space" }],
          ...parts,
        }),
      ]);
      return asOf;
    };

    const ROOT_ROW = { id: "of:piece", scopeKey: "space" };
    const OUT_ROW = { id: "computed:out", scopeKey: "space" };

    it("returns a root whose piece is clean and vouches for each demanded instance", () => {
      storeVouching();

      expect(judge(["of:piece"], [ROOT_ROW, OUT_ROW])).toEqual(["of:piece"]);
    });

    it("returns a root when the demand rows name documents no piece writes", () => {
      storeVouching();

      expect(
        judge(["of:piece"], [ROOT_ROW, { id: "of:data", scopeKey: "space" }]),
      )
        .toEqual(["of:piece"]);
    });

    it("returns nothing for a root with no record", () => {
      storeVouching();

      expect(judge(["of:unrecorded"], [ROOT_ROW])).toEqual([]);
    });

    it("returns nothing for a marked root", () => {
      storeVouching({ reads: [input("of:state")] });
      write("of:state");
      advance();

      expect(judge(["of:piece"], [ROOT_ROW, OUT_ROW])).toEqual([]);
    });

    it("returns nothing for a root recorded under another epoch", () => {
      storeVouching();

      expect(judge(["of:piece"], [ROOT_ROW, OUT_ROW], "epoch-two")).toEqual([]);
    });

    it("returns nothing when a demanded instance of a written id has no vouch row", () => {
      storeVouching();

      expect(
        judge(["of:piece"], [
          ROOT_ROW,
          { id: "computed:out", scopeKey: ALICE_USER },
        ]),
      ).toEqual([]);
    });

    it("returns nothing when a demanded written id was never vouched for", () => {
      storeVouching({ writes: ["computed:out", "computed:lazy"] });

      expect(
        judge(["of:piece"], [ROOT_ROW, {
          id: "computed:lazy",
          scopeKey: "space",
        }]),
      ).toEqual([]);
    });

    it("returns nothing when the store holds no instance of a demanded owned cell", () => {
      storeVouching({ owned: ["of:state"] });

      expect(
        judge(["of:piece"], [
          ROOT_ROW,
          { id: "of:state", scopeKey: "session:alice:one" },
        ]),
      ).toEqual([]);
    });

    it("returns a root when the store holds the demanded instance of an owned cell", () => {
      storeVouching({ owned: ["of:state"] });

      expect(
        judge(["of:piece"], [ROOT_ROW, { id: "of:state", scopeKey: "space" }]),
      )
        .toEqual(["of:piece"]);
    });

    it("returns nothing for a root when a piece beneath it does not vouch for a demanded instance", () => {
      const asOf = storeVouching();
      store(asOf, [
        record("of:nested", {
          under: ["of:piece"],
          writes: ["computed:nested"],
        }),
      ]);

      expect(
        judge(["of:piece"], [
          ROOT_ROW,
          { id: "computed:nested", scopeKey: "space" },
        ]),
      ).toEqual([]);
    });

    it("returns a root when a marked piece beneath it owns no demanded instance", () => {
      const asOf = storeVouching();
      store(asOf, [
        record("of:nested", {
          under: ["of:piece"],
          vouched: false,
          writes: ["computed:nested"],
        }),
      ]);

      expect(judge(["of:piece"], [ROOT_ROW, OUT_ROW])).toEqual(["of:piece"]);
    });

    it("names the reason it refuses each root for", () => {
      const asOf = storeVouching({
        writes: ["computed:out", "computed:lazy"],
        owned: ["of:state"],
      });
      store(asOf, [
        record("of:unvouched", { vouched: false }),
        record("of:nested", {
          under: ["of:outer"],
          vouched: false,
          writes: ["computed:nested"],
        }),
        record("of:outer"),
      ]);

      expect(refusals(["of:unrecorded", "of:unvouched"], [])).toEqual({
        "of:unrecorded": "no-record",
        "of:unvouched": "marked",
      });
      expect(refusals(["of:piece"], [ROOT_ROW], "epoch-two")).toEqual({
        "of:piece": "other-epoch",
      });
      expect(
        refusals(["of:piece"], [{ id: "computed:lazy", scopeKey: "space" }]),
      ).toEqual({ "of:piece": "unvouched-instance" });
      expect(
        refusals(["of:piece"], [
          { id: "of:state", scopeKey: "session:alice:one" },
        ]),
      ).toEqual({ "of:piece": "absent-owned" });
      expect(
        refusals(["of:outer"], [{ id: "computed:nested", scopeKey: "space" }]),
      ).toEqual({ "of:outer": "owner-not-clean" });
    });

    describe("with a piece recorded for two viewers", () => {
      const ALICE_ROW = { id: "computed:out", scopeKey: ALICE_USER };
      const BOB_ROW = { id: "computed:out", scopeKey: BOB_USER };

      /** A record of `of:piece` whose two viewers each read their own prefs. */
      const storeForBoth = (): number => {
        const asOf = Math.max(
          write(
            "of:piece",
            { id: "of:prefs", scope: "user" },
            { id: "computed:out", scope: "user" },
            { id: "computed:out", scope: "session" },
          ),
          writeAs(
            BOB,
            { id: "of:prefs", scope: "user" },
            { id: "computed:out", scope: "user" },
          ),
        );
        store(asOf, [
          record("of:piece", {
            writes: ["computed:out"],
            vouches: [
              { id: "computed:out", scopeKey: ALICE_USER },
              { id: "computed:out", scopeKey: ALICE_SESSION },
              { id: "computed:out", scopeKey: BOB_USER },
            ],
            slices: [
              slice(ALICE_USER, [input("of:prefs", ALICE_USER)]),
              slice(BOB_USER, [input("of:prefs", BOB_USER)]),
            ],
          }),
        ]);
        return asOf;
      };

      it("returns the root for a viewer whose slices are clean while another viewer's slice is marked", () => {
        storeForBoth();
        write({ id: "of:prefs", scope: "user" });
        advance();

        expect(judge(["of:piece"], [ROOT_ROW, BOB_ROW])).toEqual(["of:piece"]);
      });

      it("refuses the root for the viewer whose slice is marked", () => {
        storeForBoth();
        write({ id: "of:prefs", scope: "user" });
        advance();

        expect(refusals(["of:piece"], [ROOT_ROW, ALICE_ROW])).toEqual({
          "of:piece": "owner-not-clean",
        });
      });

      it("refuses the root when a demanded session instance is resolved under a marked user slice", () => {
        storeForBoth();
        write({ id: "of:prefs", scope: "user" });
        advance();

        expect(
          refusals(["of:piece"], [
            { id: "computed:out", scopeKey: ALICE_SESSION },
          ]),
        ).toEqual({ "of:piece": "owner-not-clean" });
      });

      it("refuses the root for every viewer once its `space` slice is marked", () => {
        storeForBoth();
        write("of:piece");
        advance();

        expect(refusals(["of:piece"], [BOB_ROW])).toEqual({
          "of:piece": "marked",
        });
      });
    });

    it("returns each root that passes and omits each that does not", () => {
      const asOf = storeVouching();
      store(asOf, [record("of:other", { vouched: false })]);

      expect(judge(["of:other", "of:piece"], [ROOT_ROW])).toEqual(["of:piece"]);
    });
  });

  describe("with a slice that read another space", () => {
    let source: Engine;
    let sourcePath: string;

    beforeEach(async () => {
      sourcePath = await Deno.makeTempFile({ suffix: ".sqlite" });
      source = await open({ url: toFileUrl(sourcePath) });
    });

    afterEach(async () => {
      close(source);
      await Deno.remove(sourcePath);
    });

    /** Commits a write to each of `ids` in the source, and returns its seq. */
    const writeSource = (...ids: string[]): number => {
      localSeq += 1;
      return applyCommit(source, {
        sessionId: ALICE.sessionId,
        principal: ALICE.principal,
        space: SOURCE,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations: ids.map((id) => ({
            op: "set" as const,
            id,
            value: { value: { n: localSeq } },
          })),
        },
      }).seq;
    };

    /** Stores `records` of the source's own pieces, as taken at `asOf`. */
    const storeSource = (asOf: number, records: CurrencyRecord[]) =>
      storeCurrencyRecords(source, {
        space: SOURCE,
        asOf,
        seen: [],
        epoch: EPOCH,
        records,
      });

    /** A read of the source's shared instance of `id`, made at `seq`. */
    const far = (id: string, seq?: number): CurrencyRead => ({
      space: SOURCE,
      id,
      scopeKey: "space",
      derived: false,
      ...(seq !== undefined && { seq }),
    });

    /** Registers the reading space's read of each of `ids` with the source. */
    const register = (...ids: string[]) =>
      applyCurrencyImports(engine, {
        space: SPACE,
        source: SOURCE,
        entries: registerCurrencyReads(source, {
          space: SOURCE,
          reader: SPACE,
          reads: ids.map((id) => ({ id, scopeKey: "space" })),
        }).entries,
      });

    /**
     * The spaces the source would tell of what moved since `since`, a
     * position of its own.
     */
    const movedSince = (since: number): string[] =>
      selectCurrencyReadersMoved(source, { space: SOURCE, since }).readers
        .map(({ reader }) => reader);

    /** The source's highest position. */
    const position = (): number =>
      selectCurrencyReadersMoved(source, { space: SOURCE, since: 0 }).position;

    /** Pulls from the source what changed, and applies it. */
    const pull = () => {
      const pulled = pullCurrencyExports(source, {
        space: SOURCE,
        reader: SPACE,
        since: selectCurrencySourcePosition(engine, {
          space: SPACE,
          source: SOURCE,
        }),
        dropped: dropUnreadCurrencyImports(engine, {
          space: SPACE,
          source: SOURCE,
        }),
      });
      applyCurrencyImports(engine, {
        space: SPACE,
        source: SOURCE,
        entries: pulled.entries,
        position: pulled.position,
      });
      return pulled.entries.map(({ id }) => id).sort();
    };

    /**
     * Records `of:piece` as having read the source's `of:far` at its head,
     * which the source has reported, and returns that head.
     */
    const storeReading = (piece = "of:piece", id = "of:far"): number => {
      const head = writeSource(id);
      register(id);
      store(write(piece), [record(piece, { reads: [far(id, head)] })]);
      return head;
    };

    /**
     * Gives the source a piece, `of:producer`, that computes `computed:far`
     * from `of:raw`, recorded clean.
     */
    const storeProducer = (): number => {
      const asOf = writeSource("of:producer", "of:raw", "computed:far");
      storeSource(asOf, [
        record("of:producer", {
          reads: [{ ...input("of:raw"), space: SOURCE }],
          produces: ["computed:far"],
        }),
      ]);
      return asOf;
    };

    describe("storeCurrencyRecords()", () => {
      it("stores clean a slice that read an instance at its head in the source, once the source has reported it", () => {
        storeReading();

        expect(markOf("of:piece")).toBe(0);
      });

      it("stores marked `2` a slice that read an instance below its head in the source", () => {
        const read = writeSource("of:far");
        writeSource("of:far");
        register("of:far");

        store(write("of:piece"), [
          record("of:piece", { reads: [far("of:far", read)] }),
        ]);

        expect(markOf("of:piece")).toBe(2);
      });

      it("stores marked `2` a slice that read an instance the source has reported nothing of", () => {
        const head = writeSource("of:far");

        store(write("of:piece"), [
          record("of:piece", { reads: [far("of:far", head)] }),
        ]);

        expect(markOf("of:piece")).toBe(2);
      });

      it("stores marked `2` a slice that read another space at a seq its record does not name", () => {
        writeSource("of:far");
        register("of:far");

        store(write("of:piece"), [
          record("of:piece", { reads: [far("of:far")] }),
        ]);

        expect(markOf("of:piece")).toBe(2);
      });

      it("stores clean a slice that reads what a clean slice that read another space writes", () => {
        const head = writeSource("of:far");
        register("of:far");
        const asOf = write("of:piece", "computed:out");

        store(asOf, [
          record("of:piece", {
            reads: [far("of:far", head)],
            produces: ["computed:out"],
          }),
          record("of:reader", { reads: [derived("computed:out")] }),
        ]);

        expect([markOf("of:piece"), markOf("of:reader")]).toEqual([0, 0]);
      });

      it("reports no false clean for a piece that wrote a vouched instance again after an instance of another space it read changed", () => {
        const head = writeSource("of:far");
        register("of:far");
        const producing = (seq: number) =>
          record("of:piece", {
            reads: [far("of:far", seq)],
            produces: ["computed:out"],
          });
        const asOf = write("of:piece", "computed:out");
        store(asOf, [producing(head)]);
        const changed = writeSource("of:far");
        register("of:far");
        const own = write("computed:out");

        const stored = storeCurrencyRecords(engine, {
          space: SPACE,
          asOf,
          seen: [own],
          epoch: EPOCH,
          records: [producing(changed)],
        });

        expect(stored.falseClean).toEqual([]);
        expect(markOf("of:piece")).toBe(0);
      });

      it("stores marked `1` a slice that read an instance its source reports stale upstream", () => {
        const head = storeProducer();
        writeSource("of:raw");
        register("computed:far");

        store(write("of:piece"), [
          record("of:piece", { reads: [far("computed:far", head)] }),
        ]);

        expect(markOf("of:piece")).toBe(1);
      });
    });

    describe("pullCurrencyExports()", () => {
      it("returns each registered instance that changed since the position pulled from, and nothing to a second pull", () => {
        storeReading("of:pieceA", "of:farA");
        storeReading("of:pieceB", "of:farB");
        pull();
        writeSource("of:farA");

        expect(pull()).toEqual(["of:farA"]);
        expect(pull()).toEqual([]);
      });

      it("returns nothing of an instance the reading space dropped", () => {
        storeReading();
        store(write("of:piece"), [record("of:piece")]);
        pull();
        writeSource("of:far");

        expect(pull()).toEqual([]);
      });
    });

    describe("registerCurrencyReads()", () => {
      it("returns to no pull an instance that has not changed since it was registered", () => {
        storeReading();

        expect(pull()).toEqual([]);
      });

      it("returns the slices of the source its advance marked", () => {
        const asOf = storeProducer();
        const changed = writeSource("of:raw");

        const registered = registerCurrencyReads(source, {
          space: SOURCE,
          reader: SPACE,
          reads: [{ id: "computed:far", scopeKey: "space" }],
        });

        expect(registered.marked.map(({ piece, seq }) => ({ piece, seq })))
          .toEqual([{ piece: "of:producer", seq: changed }]);
        expect(registered.entries).toEqual([{
          id: "computed:far",
          scopeKey: "space",
          head: asOf,
          stale: true,
        }]);
      });
    });

    describe("selectCurrencyReadersMoved()", () => {
      it("returns a space that registered an instance a commit changed, once the cursor advanced, in a store with no record", () => {
        storeReading();
        const before = position();
        writeSource("of:far");
        expect(movedSince(before)).toEqual([]);

        advanceCurrencyCursor(source, { space: SOURCE });

        expect(movedSince(before)).toEqual([SPACE]);
      });

      it("returns no space for a commit to an instance none registered", () => {
        storeReading();
        const before = position();
        writeSource("of:other");

        advanceCurrencyCursor(source, { space: SOURCE });

        expect(movedSince(before)).toEqual([]);
      });

      it("returns a space that registered an instance whose producer an advance marked, and again once a record of the producer is clean", () => {
        storeProducer();
        register("computed:far");
        const before = position();
        const changed = writeSource("of:raw");
        advanceCurrencyCursor(source, { space: SOURCE });
        expect(movedSince(before)).toEqual([SPACE]);
        const marked = position();

        storeSource(changed, [
          record("of:producer", {
            reads: [{ ...input("of:raw"), space: SOURCE }],
            produces: ["computed:far"],
          }),
        ]);

        expect(movedSince(marked)).toEqual([SPACE]);
      });

      it("returns a space that registered an instance a piece no longer writes", () => {
        const asOf = storeProducer();
        register("computed:far");
        const before = position();

        storeSource(asOf, [record("of:producer")]);

        expect(movedSince(before)).toEqual([SPACE]);
      });
    });

    describe("applyCurrencyImports()", () => {
      it("marks `2` each slice that read an instance a pull finds changed, and no slice that read another", () => {
        storeReading("of:pieceA", "of:farA");
        storeReading("of:pieceB", "of:farB");
        writeSource("of:farA");

        pull();

        expect([markOf("of:pieceA"), markOf("of:pieceB")]).toEqual([2, 0]);
      });

      it("marks `1` a slice that reads what a slice writes that a pull marked", () => {
        const head = writeSource("of:far");
        register("of:far");
        store(write("of:piece", "computed:out"), [
          record("of:piece", {
            reads: [far("of:far", head)],
            produces: ["computed:out"],
          }),
          record("of:reader", { reads: [derived("computed:out")] }),
        ]);
        writeSource("of:far");

        pull();

        expect([markOf("of:piece"), markOf("of:reader")]).toEqual([2, 1]);
      });

      it("marks `1` a slice whose source reports its instance stale upstream, and clears it once the source's producer is recorded clean again", () => {
        const head = storeProducer();
        register("computed:far");
        store(write("of:piece"), [
          record("of:piece", { reads: [far("computed:far", head)] }),
        ]);
        const changed = writeSource("of:raw");
        pull();
        expect(markOf("of:piece")).toBe(1);

        storeSource(changed, [
          record("of:producer", {
            reads: [{ ...input("of:raw"), space: SOURCE }],
            produces: ["computed:far"],
          }),
        ]);
        pull();

        expect(markOf("of:piece")).toBe(0);
      });
    });

    describe("forgetCurrencySource()", () => {
      it("marks `2` each slice that read the source, and leaves nothing held of it", () => {
        storeReading();

        expect(forgetCurrencySource(engine, { space: SPACE, source: SOURCE }))
          .toEqual(["of:piece"]);

        expect(markOf("of:piece")).toBe(2);
        expect(
          selectCurrencySourcePosition(engine, {
            space: SPACE,
            source: SOURCE,
          }),
        ).toBe(0);
      });
    });

    describe("selectCurrencySources()", () => {
      it("returns the other spaces the slices at the given keys read", () => {
        storeReading();

        expect(
          selectCurrencySources(engine, { space: SPACE, slices: ["space"] }),
        ).toEqual([SOURCE]);
        expect(
          selectCurrencySources(engine, { space: SPACE, slices: [ALICE_USER] }),
        ).toEqual([]);
      });
    });

    describe("judgeCurrencyRoots()", () => {
      it("returns a root that rests on a clean slice that read another space", () => {
        storeReading();

        expect(
          judgeCurrencyRoots(engine, {
            space: SPACE,
            roots: ["of:piece"],
            rows: [{ id: "of:piece", scopeKey: "space" }],
            epoch: EPOCH,
          }).servable,
        ).toEqual(["of:piece"]);
      });
    });
  });
});
