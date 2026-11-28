import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { type Stub, stub } from "@std/testing/mock";
import {
  advanceCurrencyCursor,
  ANY_INSTANCE,
  applyCurrencyImports,
  type CurrencyRead,
  type CurrencyRecord,
  type CurrencySliceRecord,
  dropUnreadCurrencyImports,
  forgetCurrencyImports,
  forgetCurrencySource,
  judgeCurrencyRoots,
  pullCurrencyExports,
  registerCurrencyReads,
  selectCurrencyDeriver,
  selectCurrencyImports,
  selectCurrencyNextExpiry,
  selectCurrencyPiece,
  selectCurrencyReadersMoved,
  selectCurrencySourcePosition,
  selectCurrencySources,
  storeCurrencyRecords,
} from "../v2/currency-index.ts";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import {
  applyCommit,
  applyWaveCommit,
  close,
  type Engine,
  open,
  serverSeq,
} from "../v2/engine.ts";
import { executionLeaseHolder } from "../v2/execution-lease.ts";
import {
  resetServerExecutionConfig,
  resolveScopeKey,
  scopeOfScopeKey,
  setServerExecutionConfig,
} from "../v2.ts";

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
    /** Ids among `owned` an absent instance of which reads as its default. */
    absentAsDefault?: string[];
    vouches?: Array<{ id: string; scopeKey: string }>;
    slices?: CurrencySliceRecord[];
    /** The time the `space` slice expires at. */
    expiresAt?: number;
    /** Whether the piece records a source origin. */
    followsOrigin?: boolean;
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
        decides?: Array<{ id: string; scopeKey: string }>;
        superseded?: Array<{ id: string; scopeKey: string }>;
        expiresAt?: number;
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
    // A record this builds names the `space` slice, whatever else it names:
    // a case about a record that names none takes it out.
    sliceAt("space");
    for (const read of parts.reads ?? []) sliceAt("space").reads.push(read);
    for (const { id, scopeKey } of parts.vouches ?? []) {
      sliceAt(scopeKey).vouches.push(id);
    }
    for (const id of parts.produces ?? []) sliceAt("space").vouches.push(id);
    if (parts.expiresAt !== undefined) {
      sliceAt("space").expiresAt = parts.expiresAt;
    }
    for (const given of parts.slices ?? []) {
      const merged = sliceAt(given.key);
      merged.vouched &&= given.vouched;
      for (const read of given.reads) merged.reads.push(read);
      for (const id of given.vouches) merged.vouches.push(id);
      if (given.decides !== undefined) {
        merged.decides = [...(merged.decides ?? []), ...given.decides];
      }
      if (given.superseded !== undefined) {
        merged.superseded = [
          ...(merged.superseded ?? []),
          ...given.superseded,
        ];
      }
    }
    return {
      piece,
      under: parts.under ?? [],
      vouched: parts.vouched ?? true,
      writes: [...(parts.writes ?? []), ...(parts.produces ?? [])],
      owned: parts.owned ?? [],
      ...(parts.absentAsDefault !== undefined &&
        { absentAsDefault: parts.absentAsDefault }),
      ...(parts.followsOrigin === true && { followsOrigin: true }),
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

    it("marks `1` each clean piece downstream of one that became marked, through a chain, and reports each of those as stale upstream", () => {
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
        {
          piece: "of:pieceC",
          slice: "space",
          seq: changed,
          under: [],
          upstream: true,
        },
        {
          piece: "of:pieceD",
          slice: "space",
          seq: changed,
          under: [],
          upstream: true,
        },
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

    it("stores clean a piece that read a derived document no recorded piece writes, which holds a value", () => {
      const asOf = write("computed:b");

      store(asOf, [record("of:pieceC", { reads: [derived("computed:b")] })]);

      expect(markOf("of:pieceC")).toBe(0);
    });

    it("stores marked `1` a piece that read a derived document no recorded piece writes and no computation has produced", () => {
      const asOf = write("of:pieceC");

      const stored = store(asOf, [
        record("of:pieceC", { reads: [derived("computed:b")] }),
      ]);

      expect(markOf("of:pieceC")).toBe(1);
      expect(stored.blockedBy).toEqual([]);
    });

    it("stores marked `1` a piece that read, at no one instance, a derived document of which the store holds no instance", () => {
      const asOf = write("of:pieceC");

      store(asOf, [
        record("of:pieceC", { reads: [derived("computed:b", ANY_INSTANCE)] }),
      ]);

      expect(markOf("of:pieceC")).toBe(1);
    });

    it("stores clean a piece that read, at no one instance, a derived document no recorded piece writes, of which the store holds an instance", () => {
      const asOf = write("of:pieceC", { id: "computed:b", scope: "user" });

      store(asOf, [
        record("of:pieceC", { reads: [derived("computed:b", ANY_INSTANCE)] }),
      ]);

      expect(markOf("of:pieceC")).toBe(0);
    });

    it("clears a piece marked `1` once the piece that writes its input is stored clean", () => {
      const asOf = write("of:pieceC");
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

    describe("with a reader of two marked producers, asked about once for each record stored", () => {
      const pieceB = record("of:pieceB", {
        reads: [input("of:a")],
        produces: ["computed:b"],
      });
      const pieceY = record("of:pieceY", {
        reads: [input("of:x")],
        produces: ["computed:y"],
      });

      /**
       * Records both producers and the reader, changes both producers'
       * inputs, and stores the first producer clean, which leaves the reader
       * waiting on the second. Returns the seq of the change.
       */
      const leaveWaitingOnSecond = (): number => {
        const asOf = write("of:a", "of:x", "computed:b", "computed:y");
        store(asOf, [
          pieceB,
          pieceY,
          record("of:pieceC", {
            reads: [derived("computed:b"), derived("computed:y")],
          }),
        ]);
        const changed = write("of:a", "of:x");
        advance();
        store(changed, [pieceB]);
        return changed;
      };

      it("leaves the reader marked `1` when the first producer is stored clean again", () => {
        const changed = leaveWaitingOnSecond();

        store(changed, [pieceB]);

        expect(markOf("of:pieceC")).toBe(1);
      });

      it("clears the reader once the producer it waited on is stored clean", () => {
        const changed = leaveWaitingOnSecond();
        store(changed, [pieceB]);

        store(changed, [pieceY]);

        expect(markOf("of:pieceC")).toBe(0);
      });

      it("stores the reader clean once its record no longer reads the producer it waited on", () => {
        const changed = leaveWaitingOnSecond();

        store(changed, [
          record("of:pieceC", { reads: [derived("computed:b")] }),
        ]);

        expect(markOf("of:pieceC")).toBe(0);
        expect(markOf("of:pieceY")).toBe(2);
      });
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
      const asOf = write("computed:c");
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

    it("leaves marked `1` a named piece of an earlier batch that reads a document no record writes and no computation has produced", () => {
      const asOf = write("computed:c");
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

    describe("with a record that names no `space` slice, of a piece that holds one", () => {
      // Such a record is one taken while no live computation of the piece
      // ran at the space's key, as a runtime takes of a piece it holds
      // while no session demands what the piece writes.

      /** A record of `of:piece` that vouches for `computed:out` from `of:a`. */
      const vouching = record("of:piece", {
        reads: [input("of:a")],
        produces: ["computed:out"],
      });

      /** A record of `of:piece` that names no slice at all. */
      const unrun: CurrencyRecord = {
        ...record("of:piece", { writes: ["computed:out"] }),
        slices: [],
      };

      const OUT_ROW = { id: "computed:out", scopeKey: "space" };

      /** What a judgment of `of:piece` finds, for a demand of its output. */
      const judged = (epoch = EPOCH) => {
        const { servable, refused } = judgeCurrencyRoots(engine, {
          space: SPACE,
          roots: ["of:piece"],
          rows: [OUT_ROW],
          epoch,
        });
        return { servable, refused: refused.map(({ reason }) => reason) };
      };

      it("leaves a clean slice of the batch's epoch vouching for what it vouched for", () => {
        const asOf = write("of:piece", "of:a", "computed:out");
        store(asOf, [vouching]);

        store(asOf, [unrun]);

        expect(markOf("of:piece")).toBe(0);
        expect(judged()).toEqual({ servable: ["of:piece"], refused: [] });
      });

      it("leaves that slice its read rows, so a change to what it read marks it", () => {
        const asOf = write("of:piece", "of:a", "computed:out");
        store(asOf, [vouching]);
        store(asOf, [unrun]);

        write("of:a");

        expect(advance()).toEqual(["of:piece"]);
        expect(judged()).toEqual({ servable: [], refused: ["marked"] });
      });

      it("leaves a clean slice of the batch's epoch as it is where the record names another slice", () => {
        const asOf = write("of:piece", "of:a", "computed:out");
        store(asOf, [vouching]);

        store(asOf, [{ ...unrun, slices: [slice(ALICE_USER)] }]);

        expect([markOf("of:piece"), markOf("of:piece", ALICE_USER)]).toEqual([
          0,
          0,
        ]);
        expect(judged().servable).toEqual(["of:piece"]);
      });

      it("stores in place of a marked slice one that read nothing and vouches for nothing", () => {
        const asOf = write("of:piece", "of:a", "computed:out");
        store(asOf, [vouching]);
        const changed = write("of:a");

        store(changed, [unrun]);

        expect(markOf("of:piece")).toBe(0);
        expect(judged()).toEqual({
          servable: [],
          refused: ["unvouched-instance"],
        });
      });

      it("stores in place of a slice of another epoch one of the batch's epoch that vouches for nothing", () => {
        const asOf = write("of:piece", "of:a", "computed:out");
        store(asOf, [vouching]);

        storeCurrencyRecords(engine, {
          space: SPACE,
          asOf,
          seen: [],
          epoch: "epoch-two",
          records: [unrun],
        });

        expect(selectCurrencyPiece(engine, { piece: "of:piece" })).toEqual({
          mark: 0,
          epoch: "epoch-two",
        });
        expect(judged("epoch-two")).toEqual({
          servable: [],
          refused: ["unvouched-instance"],
        });
      });

      it("stores marked `2`, in place of a clean slice, the slice of a record that is not vouched for", () => {
        const asOf = write("of:piece", "of:a", "computed:out");
        store(asOf, [vouching]);

        store(asOf, [{ ...unrun, vouched: false }]);

        expect(markOf("of:piece")).toBe(2);
      });
    });

    describe("with a clean piece that read what another computes", () => {
      /** Records `of:producer` computing `computed:x`, which `of:reader` reads. */
      const storeBoth = (): number => {
        const asOf = write("of:producer", "of:reader", "computed:x");
        store(asOf, [
          record("of:producer", { produces: ["computed:x"] }),
          record("of:reader", { reads: [derived("computed:x")] }),
        ]);
        return asOf;
      };

      it("marks `1` the reader once a record of the producer writes what it read and no longer vouches for it", () => {
        const asOf = storeBoth();

        store(asOf, [record("of:producer", { writes: ["computed:x"] })]);

        expect([markOf("of:producer"), markOf("of:reader")]).toEqual([0, 1]);
      });

      it("leaves the reader clean once a record of the producer no longer writes what it read, which holds a value", () => {
        const asOf = storeBoth();

        store(asOf, [record("of:producer")]);

        expect([markOf("of:producer"), markOf("of:reader")]).toEqual([0, 0]);
      });
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

      it("names no piece that wrote an instance it vouched for again with the value it held", () => {
        // A start derives every output afresh, and writes what stands.

        /** Commits a write of `{ n: 1 }` to `computed:out`. */
        const writeTheSame = (): number => {
          localSeq += 1;
          return applyCommit(engine, {
            sessionId: ALICE.sessionId,
            principal: ALICE.principal,
            space: SPACE,
            commit: {
              localSeq,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: "computed:out",
                value: { value: { n: 1 } },
              }],
            },
          }).seq;
        };
        write("of:a");
        const asOf = writeTheSame();
        store(asOf, [vouching()]);
        const own = writeTheSame();

        const stored = store(asOf, [vouching()], [own]);

        expect(stored.falseClean).toEqual([]);
        expect(markOf("of:piece")).toBe(0);
      });

      it("names a piece that wrote an instance it vouched for again with a different byte sequence in it", () => {
        // A byte sequence keeps its state out of its properties, so a
        // comparison of properties alone would take the two for the same.

        /** Commits a write of `bytes` to `computed:out`. */
        const writeBytes = (bytes: number[]): number => {
          localSeq += 1;
          return applyCommit(engine, {
            sessionId: ALICE.sessionId,
            principal: ALICE.principal,
            space: SPACE,
            commit: {
              localSeq,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: "computed:out",
                value: {
                  value: { bytes: new FabricBytes(new Uint8Array(bytes)) },
                },
              }],
            },
          }).seq;
        };
        write("of:a");
        const asOf = writeBytes([1, 2, 3]);
        store(asOf, [vouching()]);
        const own = writeBytes([1, 2, 4]);

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

      describe("for a piece whose result document each viewer holds an instance of", () => {
        const ROOT = { id: "of:scoped", scope: "session" as const };
        const OUT = { id: "computed:out", scope: "session" as const };

        /**
         * A record of `of:scoped` whose slice for Alice's session read her
         * instance of the piece's result document, and vouches for it and
         * for `computed:out`.
         */
        const scoped = () =>
          record("of:scoped", {
            writes: ["of:scoped", "computed:out"],
            slices: [{
              key: ALICE_SESSION,
              vouched: true,
              reads: [input("of:scoped", ALICE_SESSION)],
              vouches: ["of:scoped", "computed:out"],
            }],
          });

        it("names no piece that wrote its outputs once the viewer's instance of its result document was made", () => {
          // The piece does not run for a viewer who holds no instance, so
          // whoever instantiates it for them makes the instance, and that
          // prompts what the piece writes.

          const asOf = write("of:a");
          store(asOf, [scoped()]);
          const own = write(ROOT, OUT);

          const stored = store(asOf, [scoped()], [own]);

          expect(stored.falseClean).toEqual([]);
        });

        it("names a piece that wrote an output again while the viewer's instance of its result document stood", () => {
          const asOf = write(ROOT, OUT);
          store(asOf, [scoped()]);
          const own = write(OUT);

          const stored = store(asOf, [scoped()], [own]);

          expect(stored.falseClean).toEqual(["of:scoped"]);
        });

        it("names a piece that wrote the viewer's instance of its result document again, to another value", () => {
          const asOf = write(ROOT, OUT);
          store(asOf, [scoped()]);
          const own = write(ROOT);

          const stored = store(asOf, [scoped()], [own]);

          expect(stored.falseClean).toEqual(["of:scoped"]);
        });
      });

      describe("for an instance at another key that a slice decides", () => {
        // A commit says which run made each of its writes only where it is
        // a serving loop's derivation, so the writes of these cases are
        // derivations, each attributed to the run it is made as.

        /** The shared slot Alice's run leaves a redirect at. */
        const SLOT = { id: "computed:out", scopeKey: "space" };

        const PREFS = { id: "of:prefs", scope: "session" as const };
        let holder: string;

        beforeEach(() => {
          setServerExecutionConfig(true);
          holder = executionLeaseHolder(`service:${SPACE}`);
          engine.executionLeases.acquire(SPACE, holder);
        });

        afterEach(() => {
          resetServerExecutionConfig();
        });

        /**
         * Commits a derivation that writes `instance`, attributed to a run
         * that acted as `acting`, and returns the commit's seq. The value
         * written is `{ n }`, one no other commit of the test writes where
         * `n` is left out.
         */
        const derive = (
          instance: { id: string; scopeKey: string },
          acting: { principal?: string; sessionId?: string },
          n?: number,
        ): number => {
          localSeq += 1;
          const scope = scopeOfScopeKey(instance.scopeKey);
          return applyWaveCommit(engine, {
            sessionId: holder,
            space: SPACE,
            commitClass: "derived",
            holder,
            commit: {
              localSeq,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: instance.id,
                ...(scope !== "space" && { scope }),
                value: { value: { n: n ?? localSeq } },
              }],
            },
            annotations: [{
              op: 0,
              ...(scope !== "space" && { scopeKey: instance.scopeKey }),
              ...(acting.principal !== undefined &&
                { actingUser: acting.principal }),
              ...(acting.sessionId !== undefined &&
                { actingSession: acting.sessionId }),
            }],
            waveBasis: { basisSeq: serverSeq(engine), rebasedHeads: [] },
          }).seq;
        };

        /**
         * A record of `of:piece` whose slice at `key` read Alice's prefs,
         * vouches for `vouches`, and names `slots` as the instances at
         * another key it answers for or no longer does.
         */
        const deciding = (
          slots: Pick<CurrencySliceRecord, "decides" | "superseded"> = {
            decides: [SLOT],
          },
          key = ALICE_SESSION,
          vouches: string[] = [],
        ) =>
          record("of:piece", {
            writes: ["computed:out"],
            slices: [{
              key,
              vouched: true,
              reads: [input("of:prefs", ALICE_SESSION)],
              vouches,
              ...slots,
            }],
          });

        /**
         * Stores a record in which the run for Alice's session decides the
         * slot, as that run wrote it.
         */
        const storeDeciding = () => {
          write(PREFS);
          store(derive(SLOT, ALICE), [deciding()]);
        };

        it("names a piece one of whose slices wrote a slot it decides again with no input changed", () => {
          storeDeciding();
          const own = derive(SLOT, ALICE);

          const stored = store(own, [deciding()]);

          expect(stored.falseClean).toEqual(["of:piece"]);
        });

        it("names a piece whose slice at a user's key wrote a slot it decides again", () => {
          const user = { principal: ALICE.principal };
          write(PREFS);
          store(derive(SLOT, user), [deciding(undefined, ALICE_USER)]);
          const own = derive(SLOT, user);

          const stored = store(own, [deciding(undefined, ALICE_USER)]);

          expect(stored.falseClean).toEqual(["of:piece"]);
        });

        it("names a piece whose `space` slice wrote a viewer's instance it decides again", () => {
          const narrower = { id: "computed:out", scopeKey: ALICE_SESSION };
          const taken = deciding({ decides: [narrower] }, "space");
          write(PREFS);
          store(derive(narrower, {}), [taken]);
          const own = derive(narrower, {});

          const stored = store(own, [taken]);

          expect(stored.falseClean).toEqual(["of:piece"]);
        });

        it("names no piece that wrote a slot it decides again with the value it held", () => {
          write(PREFS);
          store(derive(SLOT, ALICE, 1), [deciding()]);
          const own = derive(SLOT, ALICE, 1);

          const stored = store(own, [deciding()]);

          expect(stored.falseClean).toEqual([]);
        });

        it("names no piece whose slot another viewer's run wrote, though its own run left the slot as that run wrote it", () => {
          // The record names the slot as one the slice decides, since
          // nothing changed it after the slice's run. That run made no
          // write of it, so nothing says it would have written otherwise
          // than the slot stood.

          storeDeciding();
          const other = derive(SLOT, BOB);

          const stored = store(other, [deciding()]);

          expect(stored.falseClean).toEqual([]);
        });

        it("names no piece whose run wrote a slot again that the record names as holding a later write", () => {
          storeDeciding();
          const own = derive(SLOT, ALICE);

          const stored = store(own, [deciding({ superseded: [SLOT] })]);

          expect(stored.falseClean).toEqual([]);
        });

        it("names no piece whose run wrote a slot again that its last record named as holding a later write", () => {
          // The slice answered for nothing at the slot, so no judgment
          // rested on what it held.

          write(PREFS);
          store(derive(SLOT, ALICE), [deciding({ superseded: [SLOT] })]);
          const own = derive(SLOT, ALICE);

          const stored = store(own, [deciding()]);

          expect(stored.falseClean).toEqual([]);
        });

        it("names no piece that wrote a slot it decides again after an instance its slice read changed", () => {
          storeDeciding();
          write(PREFS);
          const own = derive(SLOT, ALICE);

          const stored = store(own, [deciding()]);

          expect(stored.falseClean).toEqual([]);
        });

        it("names no piece whose slot was written again by a commit that names no run", () => {
          storeDeciding();
          const unattributed = write("computed:out");

          const stored = store(unattributed, [deciding()], [unattributed]);

          expect(stored.falseClean).toEqual([]);
        });

        it("names no piece whose `space` slice decides a viewer's instance that was written again by a commit that names no run", () => {
          const narrower = { id: "computed:out", scopeKey: ALICE_SESSION };
          const taken = deciding({ decides: [narrower] }, "space");
          write(PREFS);
          store(derive(narrower, {}), [taken]);
          const unattributed = write({ id: "computed:out", scope: "session" });

          const stored = store(unattributed, [taken], [unattributed]);

          expect(stored.falseClean).toEqual([]);
        });

        it("names no piece that wrote a vouched instance again after a commit the loop did not make wrote a slot it decides", () => {
          const OWN = { id: "computed:out", scopeKey: ALICE_SESSION };
          const vouching = () =>
            deciding(undefined, ALICE_SESSION, ["computed:out"]);
          write(PREFS);
          derive(SLOT, ALICE);
          store(derive(OWN, ALICE), [vouching()]);
          write("computed:out");
          const own = derive(OWN, ALICE);

          const stored = store(own, [vouching()]);

          expect(stored.falseClean).toEqual([]);
        });
      });
    });
  });

  describe("selectCurrencyDeriver()", () => {
    it("returns the one piece recorded as writing a computed document", () => {
      store(0, [record("of:piece", { writes: ["computed:total"] })]);

      expect(
        selectCurrencyDeriver(engine, { space: SPACE, id: "computed:total" }),
      )
        .toBe("of:piece");
    });

    it("returns `undefined` for a document that is no computed one, though one piece is recorded as writing it", () => {
      store(0, [record("of:piece", { writes: ["of:argument"] })]);

      expect(selectCurrencyDeriver(engine, { space: SPACE, id: "of:argument" }))
        .toBeUndefined();
    });

    it("returns `undefined` for a computed document that no piece, or more than one, is recorded as writing", () => {
      store(0, [
        record("of:piece", { writes: ["computed:shared"] }),
        record("of:other", { writes: ["computed:shared"] }),
      ]);

      expect([
        selectCurrencyDeriver(engine, { space: SPACE, id: "computed:shared" }),
        selectCurrencyDeriver(engine, { space: SPACE, id: "computed:none" }),
      ]).toEqual([undefined, undefined]);
    });
  });

  describe("judgeCurrencyRoots()", () => {
    const judge = (
      roots: string[],
      rows: Array<{ id: string; scopeKey: string; demander?: string }>,
      epoch = EPOCH,
    ) =>
      judgeCurrencyRoots(engine, { space: SPACE, roots, rows, epoch }).servable;

    /** The reason each of `roots` is refused for, by root. */
    const refusals = (
      roots: string[],
      rows: Array<{ id: string; scopeKey: string; demander?: string }>,
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

    describe("with a piece that records a source origin", () => {
      /** The pieces a judgment of `of:piece` names as recording an origin. */
      const origins = () =>
        judgeCurrencyRoots(engine, {
          space: SPACE,
          roots: ["of:piece"],
          rows: [ROOT_ROW],
          epoch: EPOCH,
        }).origins;

      it("names the root's own piece with a root the store can serve", () => {
        storeVouching({ followsOrigin: true });

        expect(origins()).toEqual([{ root: "of:piece", pieces: ["of:piece"] }]);
      });

      it("names a piece beneath the root, and no piece that records none", () => {
        const asOf = storeVouching();
        store(asOf, [
          record("of:nested", { under: ["of:piece"], followsOrigin: true }),
          record("of:plain", { under: ["of:piece"] }),
        ]);

        expect(origins()).toEqual([{
          root: "of:piece",
          pieces: ["of:nested"],
        }]);
      });

      it("names no piece once a record of it says it records no origin", () => {
        const asOf = storeVouching({ followsOrigin: true });
        store(asOf, [record("of:piece", { produces: ["computed:out"] })]);

        expect(origins()).toEqual([]);
      });

      it("names none for a root the store cannot serve", () => {
        storeVouching({ followsOrigin: true, reads: [input("of:state")] });
        write("of:state");
        advance();

        expect(origins()).toEqual([]);
      });
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

    it("returns a root when the store holds no instance of a demanded owned cell that reads as its default while absent", () => {
      storeVouching({ owned: ["of:state"], absentAsDefault: ["of:state"] });

      expect(
        judge(["of:piece"], [
          ROOT_ROW,
          { id: "of:state", scopeKey: "session:alice:one" },
        ]),
      ).toEqual(["of:piece"]);
    });

    it("refuses a root for an absent owned cell that reads as its default while absent, when a computation of the piece writes it", () => {
      storeVouching({
        writes: ["computed:out", "of:state"],
        owned: ["of:state"],
        absentAsDefault: ["of:state"],
      });

      expect(
        refusals(["of:piece"], [
          ROOT_ROW,
          { id: "of:state", scopeKey: "session:alice:one" },
        ]),
      ).toEqual({ "of:piece": "unvouched-instance" });
    });

    it("refuses a root for an absent owned cell that reads as its default while absent for one owner and not for another", () => {
      const asOf = storeVouching({
        owned: ["of:state"],
        absentAsDefault: ["of:state"],
      });
      store(asOf, [
        record("of:nested", { under: ["of:piece"], owned: ["of:state"] }),
      ]);

      expect(
        refusals(["of:piece"], [
          ROOT_ROW,
          { id: "of:state", scopeKey: "session:alice:one" },
        ]),
      ).toEqual({ "of:piece": "absent-owned" });
    });

    it("refuses a root for an absent owned cell that reads as its default while absent, when a slice the row is resolved under is marked", () => {
      storeVouching({
        owned: ["of:state"],
        absentAsDefault: ["of:state"],
        slices: [{
          key: "session:alice:one",
          vouched: false,
          reads: [],
          vouches: [],
        }],
      });

      expect(
        refusals(["of:piece"], [
          ROOT_ROW,
          { id: "of:state", scopeKey: "session:alice:one" },
        ]),
      ).toEqual({ "of:piece": "owner-not-clean" });
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

    describe("with three pieces, each reading the output of the one before", () => {
      /**
       * Stores clean records of `of:a`, which derives `computed:a` from
       * `of:in`, of `of:b`, which derives `computed:b` from `computed:a`,
       * and of `of:c`, which derives `computed:c` from `computed:b`.
       */
      const storeChain = (): number => {
        const asOf = write(
          "of:in",
          "of:a",
          "of:b",
          "of:c",
          "computed:a",
          "computed:b",
          "computed:c",
        );
        store(asOf, [
          record("of:a", {
            reads: [input("of:in")],
            produces: ["computed:a"],
          }),
          record("of:b", {
            reads: [derived("computed:a")],
            produces: ["computed:b"],
          }),
          record("of:c", {
            reads: [derived("computed:b")],
            produces: ["computed:c"],
          }),
        ]);
        return asOf;
      };

      /** What a judgment of `roots` holds and names upstream. */
      const upstreamOf = (roots: string[], running: string[] = []) => {
        const { servable, refused, held, upstream } = judgeCurrencyRoots(
          engine,
          { space: SPACE, roots, rows: [], epoch: EPOCH, running },
        );
        return {
          servable,
          refused: refused.map(({ root }) => root),
          held,
          upstream,
        };
      };

      it("holds the last one once an input of the first changed, and names the read of the first one's output that the one between made", () => {
        storeChain();
        write("of:in");
        advance();

        expect(upstreamOf(["of:c"])).toEqual({
          servable: [],
          refused: [],
          held: [{ root: "of:c", readers: ["of:c"] }],
          upstream: [{
            reader: "of:c",
            slice: "space",
            id: "computed:a",
            scopeKey: "space",
            piece: "of:a",
          }],
        });
      });

      it("holds the last one once the output the one between read was overwritten, and names its own read of that one's output", () => {
        storeChain();
        write("computed:a");
        advance();

        expect(upstreamOf(["of:c"])).toMatchObject({
          held: [{ root: "of:c", readers: ["of:c"] }],
          upstream: [{
            reader: "of:c",
            slice: "space",
            id: "computed:b",
            scopeKey: "space",
            piece: "of:b",
          }],
        });
      });

      it("refuses the one whose own input changed, and names nothing upstream of it", () => {
        storeChain();
        write("of:in");
        advance();

        expect(upstreamOf(["of:a"])).toEqual({
          servable: [],
          refused: ["of:a"],
          held: [],
          upstream: [],
        });
      });

      it("returns the last one as servable while nothing changed", () => {
        storeChain();

        expect(upstreamOf(["of:c"])).toMatchObject({
          servable: ["of:c"],
          held: [],
          upstream: [],
        });
      });

      it("names what is upstream of a running piece asked about, and holds no root for it", () => {
        storeChain();
        write("of:in");
        advance();

        expect(upstreamOf([], ["of:b"])).toEqual({
          servable: [],
          refused: [],
          held: [],
          upstream: [{
            reader: "of:b",
            slice: "space",
            id: "computed:a",
            scopeKey: "space",
            piece: "of:a",
          }],
        });
      });

      it("holds the last one for a viewer whose own instance of what it read no piece vouches for, and names the piece that writes it", () => {
        // The piece between derived its output for no one but the viewers it
        // ran for, and the last one read this viewer's instance of it.

        const asOf = storeChain();
        store(asOf, [
          record("of:c", {
            reads: [derived("computed:b")],
            produces: ["computed:c"],
            slices: [slice(ALICE_USER, [derived("computed:b", ALICE_USER)])],
          }),
        ]);

        expect(upstreamOf(["of:c"], ["of:c"]).upstream).toEqual([{
          reader: "of:c",
          slice: ALICE_USER,
          id: "computed:b",
          scopeKey: ALICE_USER,
          piece: "of:b",
        }]);
      });

      it("holds a root for a demanded output of a piece beneath it that read the first one's output, and names that piece as the one whose read holds it", () => {
        // The root's own slice read nothing that changed, so only the
        // piece beneath it is stale.

        storeChain();
        const asOf = write("of:outer", "computed:nested");
        store(asOf, [
          record("of:nested", {
            under: ["of:outer"],
            reads: [derived("computed:a")],
            produces: ["computed:nested"],
          }),
          record("of:outer"),
        ]);
        write("of:in");
        advance();

        const { servable, refused, held, upstream } = judgeCurrencyRoots(
          engine,
          {
            space: SPACE,
            roots: ["of:outer"],
            rows: [{ id: "computed:nested", scopeKey: "space" }],
            epoch: EPOCH,
          },
        );
        expect({ servable, refused, held, upstream }).toEqual({
          servable: [],
          refused: [],
          held: [{ root: "of:outer", readers: ["of:nested"] }],
          upstream: [{
            reader: "of:nested",
            slice: "space",
            id: "computed:a",
            scopeKey: "space",
            piece: "of:a",
          }],
        });
      });

      it("holds a root once for two pieces beneath it that read the first one's output, and names both as the ones whose reads hold it", () => {
        storeChain();
        const asOf = write("of:outer", "computed:nestedA", "computed:nestedB");
        store(asOf, [
          record("of:nestedA", {
            under: ["of:outer"],
            reads: [derived("computed:a")],
            produces: ["computed:nestedA"],
          }),
          record("of:nestedB", {
            under: ["of:outer"],
            reads: [derived("computed:a")],
            produces: ["computed:nestedB"],
          }),
          record("of:outer"),
        ]);
        write("of:in");
        advance();

        const { held } = judgeCurrencyRoots(engine, {
          space: SPACE,
          roots: ["of:outer"],
          rows: [
            { id: "computed:nestedA", scopeKey: "space" },
            { id: "computed:nestedB", scopeKey: "space" },
          ],
          epoch: EPOCH,
        });
        expect(held.map(({ root, readers }) => ({
          root,
          readers: [...readers].sort(),
        }))).toEqual([{
          root: "of:outer",
          readers: ["of:nestedA", "of:nestedB"],
        }]);
      });

      it("refuses the one that read no one instance of what the first one writes, once the first one's input changed", () => {
        // A read that names no instance names no instance to demand of the
        // first one, so starting the reader's own piece is what is left.

        const asOf = storeChain();
        store(asOf, [
          record("of:b", {
            reads: [derived("computed:a", ANY_INSTANCE)],
            produces: ["computed:b"],
          }),
        ]);
        write("of:in");
        advance();

        expect(upstreamOf(["of:b"])).toEqual({
          servable: [],
          refused: ["of:b"],
          held: [],
          upstream: [],
        });
      });

      it("refuses the last one when what it read is an instance the first one writes and, stored not vouched for, does not vouch for", () => {
        // The first one ran for the instance and was recorded, so a further
        // run of it vouches for no more.

        const asOf = storeChain();
        write("computed:lazy");
        const stored = write("of:c");
        store(stored, [
          record("of:a", {
            vouched: false,
            reads: [input("of:in")],
            produces: ["computed:a"],
            writes: ["computed:lazy"],
          }),
          record("of:c", {
            reads: [derived("computed:b"), derived("computed:lazy")],
            produces: ["computed:c"],
          }),
        ]);
        expect(asOf).toBeLessThan(stored);

        expect(upstreamOf(["of:c"])).toMatchObject({
          refused: ["of:c"],
          held: [],
          upstream: [],
        });
      });

      it("refuses the last one, and names nothing upstream of it, when the first one's record was stored not vouched for", () => {
        // A further run of the first one would be recorded the same way, so
        // starting it would clear nothing.

        const asOf = storeChain();
        store(asOf, [
          record("of:a", {
            vouched: false,
            reads: [input("of:in")],
            produces: ["computed:a"],
          }),
        ]);
        advance();

        expect(upstreamOf(["of:c"])).toEqual({
          servable: [],
          refused: ["of:c"],
          held: [],
          upstream: [],
        });
        expect(upstreamOf([], ["of:c"]).upstream).toEqual([]);
      });

      it("refuses the last one when what it read is also a derived document no recorded piece writes", () => {
        const asOf = storeChain();
        store(asOf, [
          record("of:c", {
            reads: [derived("computed:b"), derived("computed:unrecorded")],
            produces: ["computed:c"],
          }),
        ]);
        write("of:in");
        advance();

        expect(upstreamOf(["of:c"])).toMatchObject({
          refused: ["of:c"],
          held: [],
        });
      });
    });

    describe("with a shared slot that one viewer's run wrote", () => {
      const BOB_SESSION = resolveScopeKey("session", BOB);

      /** The shared slot, as each viewer's session demands it. */
      const SLOT = { id: "computed:out", scopeKey: "space" };
      const FOR_ALICE = { ...SLOT, demander: ALICE_SESSION };
      const FOR_BOB = { ...SLOT, demander: BOB_SESSION };

      /**
       * A record of `of:piece` whose run for Alice wrote `computed:out` at
       * her key and left a redirect at the space's, from her prefs.
       */
      const storeForAlice = (): number => {
        const asOf = write(
          "of:piece",
          "computed:out",
          { id: "of:prefs", scope: "user" },
          { id: "computed:out", scope: "user" },
        );
        store(asOf, [
          record("of:piece", {
            writes: ["computed:out"],
            slices: [{
              key: ALICE_USER,
              vouched: true,
              reads: [input("of:prefs", ALICE_USER)],
              vouches: ["computed:out"],
              decides: [SLOT],
            }],
          }),
        ]);
        return asOf;
      };

      it("returns the root for the viewer whose slice holds a row for the slot", () => {
        storeForAlice();

        expect(judge(["of:piece"], [ROOT_ROW, FOR_ALICE])).toEqual([
          "of:piece",
        ]);
      });

      it("refuses the root for a viewer no slice of whose chain holds a row for the slot", () => {
        // What the slot holds was decided by the other viewer's run, and a
        // run for this one may write it otherwise.

        storeForAlice();

        expect(refusals(["of:piece"], [ROOT_ROW, FOR_BOB])).toEqual({
          "of:piece": "unvouched-instance",
        });
      });

      it("returns the root for the slot's viewer while another viewer demands something else of the space", () => {
        storeForAlice();

        expect(
          judge(["of:piece"], [
            ROOT_ROW,
            FOR_ALICE,
            { id: "of:elsewhere", scopeKey: "space", demander: BOB_SESSION },
          ]),
        ).toEqual(["of:piece"]);
      });

      it("refuses the root for the slot's viewer once an input of the slice that wrote it changed", () => {
        storeForAlice();
        write({ id: "of:prefs", scope: "user" });
        advance();

        expect(refusals(["of:piece"], [ROOT_ROW, FOR_ALICE])).toEqual({
          "of:piece": "owner-not-clean",
        });
      });

      it("refuses the root for the slot's viewer once another run wrote the slot, and leaves the viewer's slice clean", () => {
        // The viewer's row is behind the slot's head, so a start is what
        // writes the slot as this viewer's run decides it. What else the
        // slice answers for is as current as it was.

        storeForAlice();
        write("computed:out");
        advance();

        expect(refusals(["of:piece"], [ROOT_ROW, FOR_ALICE])).toEqual({
          "of:piece": "unvouched-instance",
        });
        expect(markOf("of:piece", ALICE_USER)).toBe(0);
      });

      /**
       * Stores a record of `of:reader`, one slice of which read the slot
       * for Alice and one for Bob.
       */
      const storeReaders = () => {
        const asOf = storeForAlice();
        const read = { ...derived("computed:out"), scopeKey: "space" };
        store(Math.max(asOf, write("of:reader")), [
          record("of:reader", {
            slices: [
              {
                key: ALICE_USER,
                vouched: true,
                reads: [read, derived("computed:out", ALICE_USER)],
                vouches: [],
              },
              { key: BOB_USER, vouched: true, reads: [read], vouches: [] },
            ],
          }),
        ]);
      };

      it("stores clean a slice of another piece that read the slot at the viewer's key, and marked `1` one that read it at another viewer's", () => {
        // For the other viewer the slot is one no slice of their chain
        // answers for.

        storeReaders();

        expect([
          markOf("of:reader", ALICE_USER),
          markOf("of:reader", BOB_USER),
        ]).toEqual([0, 1]);
      });

      it("refuses the root where the slot is demanded and no session is named for it", () => {
        storeForAlice();

        expect(refusals(["of:piece"], [ROOT_ROW, SLOT])).toEqual({
          "of:piece": "unvouched-instance",
        });
      });

      it("returns the root for another viewer where the `space` slice vouches for the slot as well", () => {
        const asOf = storeForAlice();
        store(asOf, [
          record("of:piece", {
            produces: ["computed:out"],
            slices: [{
              key: ALICE_USER,
              vouched: true,
              reads: [input("of:prefs", ALICE_USER)],
              vouches: ["computed:out"],
              decides: [SLOT],
            }],
          }),
        ]);

        expect(judge(["of:piece"], [ROOT_ROW, FOR_BOB])).toEqual(["of:piece"]);
      });

      describe("where a slice is recorded as holding a later write of the slot than its own", () => {
        /**
         * Stores a record of `of:piece` in which Alice's run wrote the slot
         * and something changed it since. `produces` has the `space` slice
         * vouch for the slot as well.
         */
        const storeSuperseded = (produces: boolean) => {
          const asOf = storeForAlice();
          store(asOf, [
            record("of:piece", {
              ...(produces
                ? { produces: ["computed:out"] }
                : { writes: ["computed:out"] }),
              slices: [{
                key: ALICE_USER,
                vouched: true,
                reads: [input("of:prefs", ALICE_USER)],
                vouches: ["computed:out"],
                superseded: [SLOT],
              }],
            }),
          ]);
          return asOf;
        };

        it("refuses the root for the slice's viewer, and leaves the slice clean", () => {
          storeSuperseded(false);

          expect(refusals(["of:piece"], [ROOT_ROW, FOR_ALICE])).toEqual({
            "of:piece": "unvouched-instance",
          });
          expect(markOf("of:piece", ALICE_USER)).toBe(0);
        });

        it("refuses the root for the slice's viewer where the `space` slice vouches for the slot as well", () => {
          // A viewer whose runs never wrote the slot reads it as the `space`
          // slice left it. This viewer's run wrote it, so a run for them
          // may write it otherwise than it stands.

          storeSuperseded(true);

          expect(refusals(["of:piece"], [ROOT_ROW, FOR_ALICE])).toEqual({
            "of:piece": "unvouched-instance",
          });
          expect(judge(["of:piece"], [ROOT_ROW, FOR_BOB])).toEqual([
            "of:piece",
          ]);
        });

        it("stores marked `1` a slice of another piece that read the slot at the viewer's key", () => {
          const asOf = storeSuperseded(false);
          store(Math.max(asOf, write("of:reader")), [
            record("of:reader", {
              slices: [{
                key: ALICE_USER,
                vouched: true,
                reads: [{ ...derived("computed:out"), scopeKey: "space" }],
                vouches: [],
              }],
            }),
          ]);

          expect(markOf("of:reader", ALICE_USER)).toBe(1);
        });

        it("returns the root for the slice's viewer once a later record names the slot as one the slice decides", () => {
          const asOf = storeSuperseded(false);
          store(asOf, [
            record("of:piece", {
              writes: ["computed:out"],
              slices: [{
                key: ALICE_USER,
                vouched: true,
                reads: [input("of:prefs", ALICE_USER)],
                vouches: ["computed:out"],
                decides: [SLOT],
              }],
            }),
          ]);

          expect(judge(["of:piece"], [ROOT_ROW, FOR_ALICE])).toEqual([
            "of:piece",
          ]);
        });

        it("counts the slot as one the slice decides where a record names it as both", () => {
          const asOf = storeForAlice();
          store(asOf, [
            record("of:piece", {
              writes: ["computed:out"],
              slices: [{
                key: ALICE_USER,
                vouched: true,
                reads: [input("of:prefs", ALICE_USER)],
                vouches: ["computed:out"],
                decides: [SLOT],
                superseded: [SLOT],
              }],
            }),
          ]);

          expect(judge(["of:piece"], [ROOT_ROW, FOR_ALICE])).toEqual([
            "of:piece",
          ]);
        });
      });

      it("stores clean a slice that read the slot it decides, and marks it alone once its own input changed", () => {
        const asOf = storeForAlice();
        store(asOf, [
          record("of:piece", {
            writes: ["computed:out"],
            slices: [{
              key: ALICE_USER,
              vouched: true,
              reads: [
                input("of:prefs", ALICE_USER),
                { ...derived("computed:out"), scopeKey: "space" },
              ],
              vouches: ["computed:out"],
              decides: [SLOT],
            }],
          }),
        ]);
        expect(markOf("of:piece", ALICE_USER)).toBe(0);

        write({ id: "of:prefs", scope: "user" });
        advance();

        expect([markOf("of:piece", ALICE_USER), markOf("of:piece")]).toEqual([
          2,
          0,
        ]);
      });

      it("marks `1` a clean slice of another piece that read the slot at the viewer's key, once an input of the slice that wrote it changed", () => {
        const asOf = storeForAlice();
        store(Math.max(asOf, write("of:reader")), [
          record("of:reader", {
            slices: [{
              key: ALICE_USER,
              vouched: true,
              reads: [{ ...derived("computed:out"), scopeKey: "space" }],
              vouches: [],
            }],
          }),
        ]);
        expect(markOf("of:reader", ALICE_USER)).toBe(0);

        write({ id: "of:prefs", scope: "user" });
        advance();

        expect(markOf("of:reader", ALICE_USER)).toBe(1);
      });

      it("stores marked `1` a slice of another piece that read the slot at the viewer's key while the slice that wrote it is marked", () => {
        storeForAlice();
        write({ id: "of:prefs", scope: "user" });
        advance();
        store(write("of:reader"), [
          record("of:reader", {
            slices: [{
              key: ALICE_USER,
              vouched: true,
              reads: [{ ...derived("computed:out"), scopeKey: "space" }],
              vouches: [],
            }],
          }),
        ]);

        expect(markOf("of:reader", ALICE_USER)).toBe(1);
      });

      it("stores marked `1` a slice at the space that read the slot once another run wrote it", () => {
        // The row the viewer's slice holds is behind the slot's head, so no
        // slice answers for what the slot holds now.

        storeForAlice();
        write("computed:out");
        advance();
        store(write("of:reader"), [
          record("of:reader", {
            reads: [{ ...derived("computed:out"), scopeKey: "space" }],
          }),
        ]);

        expect(markOf("of:reader")).toBe(1);
      });

      it("marks `1` a slice of another piece that read the slot at the viewer's key once the slice that wrote it is marked", () => {
        storeReaders();
        write({ id: "of:prefs", scope: "user" });
        advance();

        expect(markOf("of:reader", ALICE_USER)).toBe(1);
      });
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

  describe("with a slice whose record expires", () => {
    /** What `Date.now()` returns in these cases. */
    let now: number;
    let clock: Stub<DateConstructor>;

    /** The time the records of these cases expire at. */
    const EXPIRES = 1_700_000_060_000;

    beforeEach(() => {
      now = 1_700_000_000_000;
      clock = stub(Date, "now", () => now);
    });

    afterEach(() => {
      clock.restore();
    });

    /**
     * Records `of:clock` as computing `computed:tick` until `EXPIRES`, and
     * `of:reader` as reading it, and returns the store's head.
     */
    const storeClock = (): number => {
      const asOf = write("of:clock", "of:reader", "computed:tick");
      store(asOf, [
        record("of:clock", {
          produces: ["computed:tick"],
          expiresAt: EXPIRES,
        }),
        record("of:reader", { reads: [derived("computed:tick")] }),
      ]);
      return asOf;
    };

    describe("storeCurrencyRecords()", () => {
      it("stores clean a slice whose record expires later", () => {
        storeClock();

        expect([markOf("of:clock"), markOf("of:reader")]).toEqual([0, 0]);
      });

      it("stores marked `2` a slice whose record has expired already", () => {
        now = EXPIRES;

        storeClock();

        expect([markOf("of:clock"), markOf("of:reader")]).toEqual([2, 1]);
      });

      it("keeps clean past its old time a slice whose later record does not expire", () => {
        const asOf = storeClock();
        store(asOf, [record("of:clock", { produces: ["computed:tick"] })]);
        now = EXPIRES;

        expect(advance()).toEqual([]);
        expect(markOf("of:clock")).toBe(0);
      });
    });

    describe("advanceCurrencyCursor()", () => {
      it("marks nothing before the time a slice expires at", () => {
        storeClock();
        now = EXPIRES - 1;

        expect(advance()).toEqual([]);
        expect(markOf("of:clock")).toBe(0);
      });

      it("marks `2` a slice once the time it expires at has come, and `1` a slice that reads what it writes, each at a seq above the head", () => {
        const head = storeClock();
        now = EXPIRES;

        expect(
          advanceCurrencyCursor(engine, { space: SPACE }).map((
            { piece, seq },
          ) => ({ piece, seq })).sort((a, b) => a.piece.localeCompare(b.piece)),
        ).toEqual([
          { piece: "of:clock", seq: head + 1 },
          { piece: "of:reader", seq: head + 1 },
        ]);
        expect([markOf("of:clock"), markOf("of:reader")]).toEqual([2, 1]);
      });

      it("reports an expired slice once", () => {
        storeClock();
        now = EXPIRES;
        advance();

        expect(advance()).toEqual([]);
      });

      it("reports nothing at the time a slice expires at once a commit marked it `2` before then", () => {
        storeClock();
        write("computed:tick");
        expect(advance()).toEqual(["of:clock", "of:reader"]);
        now = EXPIRES;

        expect(advance()).toEqual([]);
        expect(markOf("of:clock")).toBe(2);
        expect(selectCurrencyNextExpiry(engine, { space: SPACE }))
          .toBeUndefined();
      });
    });

    describe("selectCurrencyNextExpiry()", () => {
      it("returns `undefined` where no slice expires", () => {
        store(write("of:piece"), [record("of:piece")]);

        expect(selectCurrencyNextExpiry(engine, { space: SPACE }))
          .toBeUndefined();
      });

      it("returns the earliest time a slice expires at", () => {
        storeClock();
        store(write("of:later"), [
          record("of:later", { expiresAt: EXPIRES + 60_000 }),
        ]);

        expect(selectCurrencyNextExpiry(engine, { space: SPACE })).toBe(
          EXPIRES,
        );
      });

      it("returns `undefined` once the slice has been marked for its expiry", () => {
        storeClock();
        now = EXPIRES;
        advance();

        expect(selectCurrencyNextExpiry(engine, { space: SPACE }))
          .toBeUndefined();
      });
    });

    describe("registerCurrencyReads()", () => {
      it("reports current to another space what a piece with a slice that expires later writes", () => {
        const head = storeClock();

        const registered = registerCurrencyReads(engine, {
          space: SPACE,
          reader: SOURCE,
          reads: [{ id: "computed:tick", scopeKey: "space" }],
        });

        expect(registered.entries).toEqual([{
          id: "computed:tick",
          scopeKey: "space",
          head,
          stale: false,
        }]);
      });
    });

    describe("pullCurrencyExports()", () => {
      it("returns stale, once a slice has expired, what a piece that read its output writes", () => {
        const asOf = write("of:clock", "of:reader", "computed:tick", "of:out");
        store(asOf, [
          record("of:clock", {
            produces: ["computed:tick"],
            expiresAt: EXPIRES,
          }),
          record("of:reader", {
            reads: [derived("computed:tick")],
            produces: ["of:out"],
          }),
        ]);
        registerCurrencyReads(engine, {
          space: SPACE,
          reader: SOURCE,
          reads: [{ id: "of:out", scopeKey: "space" }],
        });
        now = EXPIRES;

        const pulled = pullCurrencyExports(engine, {
          space: SPACE,
          reader: SOURCE,
          since: 0,
        });

        expect(pulled.entries).toEqual([{
          id: "of:out",
          scopeKey: "space",
          head: asOf,
          stale: true,
        }]);
      });
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

      it("returns no change to what a piece computed, once the source's index starts over with its records dropped", () => {
        // What `open()` leaves of an index it drops the records of: the rows
        // the store tells its readers, and no cursor. The instance is then
        // one no recorded piece writes, which holds a value, and is read as
        // an input.

        storeReading("of:piece", "computed:far");
        storeProducer();
        pull();
        source.database.exec(`
          DELETE FROM currency_slice;
          DELETE FROM currency_read;
          DELETE FROM currency_write;
          DELETE FROM currency_vouch;
          DELETE FROM currency_cursor;
        `);

        const pulled = pullCurrencyExports(source, {
          space: SOURCE,
          reader: SPACE,
          since: selectCurrencySourcePosition(engine, {
            space: SPACE,
            source: SOURCE,
          }),
        });

        expect(pulled.entries).toEqual([]);
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

      it("returns no space for an instance a piece no longer writes, which holds what the piece wrote", () => {
        const asOf = storeProducer();
        register("computed:far");
        const before = position();

        storeSource(asOf, [record("of:producer")]);

        expect(movedSince(before)).toEqual([]);
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

      it("leaves marked `1` a slice whose source reports its instance current again while a local input of it is stale", () => {
        const head = storeProducer();
        register("computed:far");
        store(write("of:piece", "of:maker", "of:i", "computed:mine"), [
          record("of:maker", {
            reads: [input("of:i")],
            produces: ["computed:mine"],
          }),
          record("of:piece", {
            reads: [far("computed:far", head), derived("computed:mine")],
          }),
        ]);
        const changed = writeSource("of:raw");
        pull();
        write("of:i");
        advance();
        expect([markOf("of:maker"), markOf("of:piece")]).toEqual([2, 1]);

        storeSource(changed, [
          record("of:producer", {
            reads: [{ ...input("of:raw"), space: SOURCE }],
            produces: ["computed:far"],
          }),
        ]);
        pull();

        expect(markOf("of:piece")).toBe(1);
      });
    });

    describe("forgetCurrencyImports()", () => {
      /** Forgets the reading space's import of the source's `of:farA`. */
      const forgetA = () =>
        forgetCurrencyImports(engine, {
          space: SPACE,
          source: SOURCE,
          instances: [{ id: "of:farA", scopeKey: "space" }],
        });

      it("marks `2` each slice that read a forgotten instance, and no slice that read another", () => {
        storeReading("of:pieceA", "of:farA");
        storeReading("of:pieceB", "of:farB");

        expect(forgetA()).toEqual(["of:pieceA"]);

        expect([markOf("of:pieceA"), markOf("of:pieceB")]).toEqual([2, 0]);
        expect(selectCurrencyImports(engine, { space: SPACE, source: SOURCE }))
          .toEqual([{ id: "of:farB", scopeKey: "space" }]);
      });

      it("names no piece whose slice it had marked already", () => {
        storeReading("of:pieceA", "of:farA");
        forgetA();

        expect(forgetA()).toEqual([]);
        expect(markOf("of:pieceA")).toBe(2);
      });
    });

    describe("with instances of the source a serving loop wrote that no recorded piece writes", () => {
      // What wrote such an instance is something the source's index has no
      // record of, so it is read as an input. `of:owned` is a cell of
      // `of:owner`, holding the `result` back-link its piece's setup writes.

      const OWNER = "of:owner";
      const OWNED = "of:owned";
      let holder: string;

      beforeEach(() => {
        setServerExecutionConfig(true);
        holder = executionLeaseHolder(`service:${SOURCE}`);
        source.executionLeases.acquire(SOURCE, holder);
      });

      afterEach(() => {
        resetServerExecutionConfig();
      });

      /**
       * Commits to the source a serving loop's commit that writes `id`, a
       * value where `produced` is `true` and the back-link alone, as setup
       * leaves a cell no computation has written yet, where it is `false`.
       * Returns the commit's seq.
       */
      const serve = (id: string, produced = true): number => {
        localSeq += 1;
        return applyWaveCommit(source, {
          sessionId: holder,
          space: SOURCE,
          commitClass: "derived",
          holder,
          commit: {
            localSeq,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set" as const,
              id,
              value: {
                ...(produced && { value: { n: localSeq } }),
                ...(id === OWNED &&
                  { result: { "/": { "link@1": { id: OWNER, path: [] } } } }),
              },
            }],
          },
          annotations: [{ op: 0, action: "cf:module/derive" }],
          waveBasis: { basisSeq: serverSeq(source), rebasedHeads: [] },
        }).seq;
      };

      /** Whether the source reports `id` stale to the reading space now. */
      const reportedStale = (id: string): boolean =>
        registerCurrencyReads(source, {
          space: SOURCE,
          reader: SPACE,
          reads: [{ id, scopeKey: "space" }],
        }).entries[0].stale;

      describe("registerCurrencyReads()", () => {
        it("returns current an instance that holds a value", () => {
          serve("of:root");

          expect(reportedStale("of:root")).toBe(false);
        });

        it("returns current a cell that holds a value, of a piece whose record names no write of it", () => {
          const asOf = serve(OWNED);
          storeSource(asOf, [record(OWNER)]);

          expect(reportedStale(OWNED)).toBe(false);
        });

        it("returns stale a cell that holds a value, of a piece the source holds no record of", () => {
          serve(OWNED);

          expect(reportedStale(OWNED)).toBe(true);
        });

        it("returns current a cell that holds no value, of a piece whose record names no write of it", () => {
          const asOf = serve(OWNED, false);
          storeSource(asOf, [record(OWNER)]);

          expect(reportedStale(OWNED)).toBe(false);
        });

        it("returns stale a cell that holds no value, of a piece the source holds no record of", () => {
          serve(OWNED, false);

          expect(reportedStale(OWNED)).toBe(true);
        });

        it("returns stale an absent `computed:` instance", () => {
          expect(reportedStale("computed:never")).toBe(true);
        });

        it("returns stale an instance a recorded piece writes and vouches for none of", () => {
          const asOf = serve(OWNED);
          storeSource(asOf, [record(OWNER, { writes: [OWNED] })]);

          expect(reportedStale(OWNED)).toBe(true);
        });
      });

      describe("pullCurrencyExports()", () => {
        it("returns current a cell registered while its piece had no record, once a record of the piece that names no write of it is stored", () => {
          const asOf = serve(OWNED);
          register(OWNED);

          storeSource(asOf, [record(OWNER)]);

          expect(
            pullCurrencyExports(source, {
              space: SOURCE,
              reader: SPACE,
              since: 0,
            }).entries.map(({ id, stale }) => ({ id, stale })),
          ).toEqual([{ id: OWNED, stale: false }]);
        });
      });

      describe("storeCurrencyRecords()", () => {
        it("stores clean a slice that read such an instance", () => {
          const head = serve("of:root");
          register("of:root");

          store(write("of:piece"), [
            record("of:piece", { reads: [far("of:root", head)] }),
          ]);

          expect(markOf("of:piece")).toBe(0);
        });
      });

      describe("applyCurrencyImports()", () => {
        it("marks `2` a slice that read such an instance, once it is written again", () => {
          const head = serve("of:root");
          register("of:root");
          store(write("of:piece"), [
            record("of:piece", { reads: [far("of:root", head)] }),
          ]);

          serve("of:root");
          pull();

          expect(markOf("of:piece")).toBe(2);
        });
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
