import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  advanceCurrencyCursor,
  ANY_INSTANCE,
  type CurrencyRead,
  type CurrencyRecord,
  type CurrencySliceRecord,
  judgeCurrencyRoots,
  selectCurrencyPiece,
  storeCurrencyRecords,
} from "../v2/currency-index.ts";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import { resolveScopeKey } from "../v2.ts";

const SPACE = "did:key:z6Mk-currency-index-test-space";
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
    for (const read of parts.reads ?? []) sliceAt("space").reads.push(read);
    for (const { id, scopeKey } of parts.vouches ?? []) {
      sliceAt(scopeKey).vouches.push(id);
    }
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
      writes: parts.writes ?? [],
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
          writes: ["computed:b"],
        }),
        record("of:pieceC", {
          reads: [derived("computed:b")],
          writes: ["computed:c"],
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
        record("of:pieceB", { reads: [input("of:a")], writes: ["computed:b"] }),
        record("of:pieceY", { reads: [input("of:x")], writes: ["computed:y"] }),
        record("of:pieceC", {
          reads: [derived("computed:b"), derived("computed:y")],
          writes: ["computed:c"],
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
          writes: ["computed:b"],
        }),
        record("of:pieceC", {
          reads: [derived("computed:b"), input("of:other")],
          writes: ["computed:c"],
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
        }),
        record("of:pieceC", {
          slices: [
            slice(ALICE_USER, [derived("computed:b", ALICE_USER)]),
            slice(BOB_USER, [derived("computed:b", BOB_USER)]),
          ],
        }),
      ]);

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

      store(asOf, [record("of:pieceB", { writes: ["computed:b"] })]);

      expect(markOf("of:pieceC")).toBe(0);
    });

    it("stores marked `1` a piece whose input a marked piece writes, and names that piece", () => {
      const asOf = write("of:a", "computed:b");
      store(asOf, [
        record("of:pieceB", { reads: [input("of:a")], writes: ["computed:b"] }),
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
        record("of:pieceB", { reads: [input("of:a")], writes: ["of:b"] }),
      ]);
      const changed = write("of:a");

      store(changed, [record("of:pieceC", { reads: [input("of:b")] })]);

      expect([markOf("of:pieceB"), markOf("of:pieceC")]).toEqual([2, 1]);
    });

    it("clears the pieces marked `1` downstream of a piece stored clean, through a chain", () => {
      const asOf = write("of:a", "computed:b", "computed:c");
      store(asOf, [
        record("of:pieceB", { reads: [input("of:a")], writes: ["computed:b"] }),
        record("of:pieceC", {
          reads: [derived("computed:b")],
          writes: ["computed:c"],
        }),
        record("of:pieceD", { reads: [derived("computed:c")] }),
      ]);
      const changed = write("of:a");
      expect(advance()).toEqual(["of:pieceB", "of:pieceC", "of:pieceD"]);

      store(changed, [
        record("of:pieceB", { reads: [input("of:a")], writes: ["computed:b"] }),
      ]);

      expect([markOf("of:pieceB"), markOf("of:pieceC"), markOf("of:pieceD")])
        .toEqual([0, 0, 0]);
    });

    it("leaves marked `2` a piece downstream of one stored clean", () => {
      const asOf = write("of:a", "of:other", "computed:b");
      store(asOf, [
        record("of:pieceB", { reads: [input("of:a")], writes: ["computed:b"] }),
        record("of:pieceC", {
          reads: [derived("computed:b"), input("of:other")],
        }),
      ]);
      write("of:a");
      const changed = write("of:other");
      advance();
      expect(markOf("of:pieceC")).toBe(2);

      store(changed, [
        record("of:pieceB", { reads: [input("of:a")], writes: ["computed:b"] }),
      ]);

      expect(markOf("of:pieceB")).toBe(0);
      expect(markOf("of:pieceC")).toBe(2);
    });

    it("leaves marked `1` a piece with a second marked producer", () => {
      const asOf = write("of:a", "of:x", "computed:b", "computed:y");
      store(asOf, [
        record("of:pieceB", { reads: [input("of:a")], writes: ["computed:b"] }),
        record("of:pieceY", { reads: [input("of:x")], writes: ["computed:y"] }),
        record("of:pieceC", {
          reads: [derived("computed:b"), derived("computed:y")],
        }),
      ]);
      const changed = write("of:a", "of:x");
      advance();

      store(changed, [
        record("of:pieceB", { reads: [input("of:a")], writes: ["computed:b"] }),
      ]);

      expect(markOf("of:pieceC")).toBe(1);
    });

    it("settles together two pieces of one batch that read each other's writes", () => {
      const asOf = write("computed:b", "computed:c");

      store(asOf, [
        record("of:pieceC", {
          reads: [derived("computed:b")],
          writes: ["computed:c"],
        }),
        record("of:pieceB", {
          reads: [derived("computed:c")],
          writes: ["computed:b"],
        }),
      ]);

      expect([markOf("of:pieceB"), markOf("of:pieceC")]).toEqual([0, 0]);
    });

    it("settles a piece an earlier batch stored with one that names it and writes its input", () => {
      const asOf = write("computed:b", "computed:c");
      store(asOf, [
        record("of:pieceC", {
          reads: [derived("computed:b")],
          writes: ["computed:c"],
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
            writes: ["computed:b"],
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
          writes: ["computed:c"],
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
            writes: ["computed:b"],
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
          { id: "computed:out", scopeKey: "user:alice" },
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
          slices: keys.map((key) => slice(key, [input("of:prefs", key)])),
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
          { id: "computed:out", scopeKey: "user:alice" },
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
});
