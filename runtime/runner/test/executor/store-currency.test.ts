import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import {
  type CurrencyBatch,
  type CurrencyMarked,
  type CurrencyRecord,
  type CurrencyStored,
  selectCurrencyPiece,
  storeCurrencyRecords,
} from "@commonfabric/memory/v2/currency-index";
import {
  applyCommit,
  close,
  type Engine,
  open,
} from "@commonfabric/memory/v2/engine";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import type { HostMemoryServer } from "../../src/executor/host-memory-server.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
} from "../../src/executor/stats.ts";
import {
  type CurrencyIndexMode,
  type CurrencyRearm,
  StoreCurrency,
} from "../../src/executor/store-currency.ts";
import type { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { captureLogs } from "../support/captured-logs.ts";

const SPACE = "did:key:z6Mk-store-currency-test-space" as MemorySpace;

/** What the memory server judges of the roots a loop asks about. */
type Judgment = Awaited<ReturnType<HostMemoryServer["judgeCurrencyRoots"]>>;

describe("StoreCurrency", () => {
  let engine: Engine;
  let path: string;

  /** The batches the server was handed, in order. */
  let batches: Array<Omit<CurrencyBatch, "space">>;

  /** How many times a stored record left a piece owed another snapshot. */
  let owed: number;

  /** What the next request to store records rejects with, once. */
  let failure: Error | undefined;

  let currency: StoreCurrency;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    batches = [];
    owed = 0;
    failure = undefined;
    currency = new StoreCurrency({
      space: SPACE,
      server: {
        storeCurrencyRecords: (space, batch) => {
          if (failure !== undefined) {
            const error = failure;
            failure = undefined;
            return Promise.reject(error);
          }
          batches.push(batch);
          return Promise.resolve(
            storeCurrencyRecords(engine, { space, ...batch }),
          );
        },
      } as Pick<HostMemoryServer, "storeCurrencyRecords"> as HostMemoryServer,
      mode: "record",
      epoch: "epoch-one",
      serviceIdentity: "did:key:service",
      stats: emptyServingLoopStats(),
      onOwed: () => {
        owed += 1;
      },
      onMarked: () => {},
    });
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  /**
   * Records of `count` pieces in a ring, each reading the document the piece
   * before it writes, and the seq of the commit that wrote those documents.
   */
  const ring = (count: number): { asOf: number; records: CurrencyRecord[] } => {
    const ids = Array.from({ length: count }, (_, at) => `computed:out-${at}`);
    const asOf = applyCommit(engine, {
      sessionId: "session-one",
      principal: "did:key:alice",
      space: SPACE,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: ids.map((id) => ({
          op: "set" as const,
          id,
          value: { value: { n: 1 } },
        })),
      },
    }).seq;
    return {
      asOf,
      records: ids.map((id, at) => ({
        piece: `of:piece-${at}`,
        under: [],
        vouched: true,
        writes: [id],
        owned: [],
        slices: [{
          key: "space",
          vouched: true,
          reads: [{
            space: SPACE,
            id: ids[(at + count - 1) % count],
            scopeKey: "space",
            derived: true,
          }],
          vouches: [id],
        }],
      })),
    };
  };

  /** The marks the pieces of `records` hold, each counted. */
  const marksOf = (records: CurrencyRecord[]) => {
    const counts: Record<number, number> = {};
    for (const { piece } of records) {
      const mark = selectCurrencyPiece(engine, { piece })!.mark;
      counts[mark] = (counts[mark] ?? 0) + 1;
    }
    return counts;
  };

  /** What the next request of a `scriptedLoop()` to store records finds. */
  let stored: CurrencyStored;

  /** What the memory server judges of the roots it is asked about. */
  let judgment: (roots: readonly string[]) => Judgment;

  /** The roots each judgment asked about. */
  let judgedRoots: string[][];

  /** What the next advance of the marks finds. */
  let advanced: CurrencyMarked[];

  /** How many times the marks were advanced. */
  let advances: number;

  /** The keys each call of `onMarked` re-armed. */
  let marked: CurrencyRearm[][];

  /** How many times a stored record left a piece owed. */
  let owedCalls: number;

  /** The pieces that run on the tenure's runtime. */
  let runningPieces: Set<string>;

  /** The pieces the scheduler reports as changed, once. */
  let changedPieces: string[];

  /** Whether the scheduler reports a piece as reading an unstarted one. */
  let readsUnstarted: boolean;

  /** Whether the runner finds a pattern behind each piece. */
  let patterned: boolean;

  /** What the loops `scriptedLoop()` makes counted. */
  let loopStats: ServingLoopStats;

  /** A memory server that judges every root servable, on its own piece. */
  const servableJudgment = (roots: readonly string[]): Judgment => ({
    servable: roots.map((root) => ({ root, piece: root, origins: [] })),
    held: [],
    upstream: [],
    refused: {},
    marked: [],
  });

  /** The read that keeps `of:reader` stale, of an output of `producer`. */
  const upstreamRead = (reader: string, producer = "of:producer") => ({
    reader,
    slice: "space",
    id: `computed:out-of-${producer}`,
    scopeKey: "space",
    piece: producer,
  });

  /**
   * A memory server that holds each root as stale only through the read
   * of `reads` whose reader is the root's own piece.
   */
  const heldJudgment =
    (reads: Array<ReturnType<typeof upstreamRead>>) =>
    (roots: readonly string[]): Judgment => ({
      servable: [],
      held: roots.map((root) => ({
        root,
        piece: root,
        readers: reads.filter(({ reader }) => reader === root).map((
          { reader },
        ) => reader),
      })),
      upstream: reads,
      refused: {},
      marked: [],
    });

  /**
   * A loop that keeps the index as `mode` says, over a memory server whose
   * answers each case sets through `stored`, `judgment` and `advanced`.
   */
  const scriptedLoop = (mode: CurrencyIndexMode) =>
    new StoreCurrency({
      space: SPACE,
      server: {
        storeCurrencyRecords: () => Promise.resolve(stored),
        judgeCurrencyRoots: (_space, roots) => {
          judgedRoots.push([...roots]);
          return Promise.resolve(judgment(roots));
        },
        advanceCurrency: () => {
          advances += 1;
          return Promise.resolve(advanced);
        },
      } as Pick<
        HostMemoryServer,
        "storeCurrencyRecords" | "judgeCurrencyRoots" | "advanceCurrency"
      > as HostMemoryServer,
      mode,
      epoch: "epoch-one",
      serviceIdentity: "did:key:service",
      stats: loopStats,
      onOwed: () => {
        owedCalls += 1;
      },
      onMarked: (rearm) => {
        marked.push(rearm);
      },
      runs: (piece) => runningPieces.has(piece),
    });

  /**
   * A runtime that runs the pieces of `runningPieces`, and whose scheduler
   * reports each piece it is asked about with one clean slice.
   */
  const cleanRuntime = {
    scheduler: {
      hasNodesUnderDemandRoot: (piece: string) => runningPieces.has(piece),
      takeChangedPieces: () => changedPieces.splice(0),
      pieceCurrencySnapshot: (_space: string, piece: string) => ({
        piece,
        rootScope: "space",
        under: [],
        unvouched: [],
        writes: [],
        readsUnstarted,
        slices: [{
          key: "space",
          unvouched: [],
          reads: [],
          vouches: [],
          decides: [],
          superseded: [],
        }],
      }),
    },
    runner: {
      pieceCurrencyFacts: () =>
        patterned ? { owned: [], absentAsDefault: [] } : undefined,
    },
    getCellFromLink: () => ({}),
  } as unknown as Runtime;

  /** Judges each of `ids` under a key of the same name. */
  const judgeEach = (currency: StoreCurrency, ...ids: string[]) =>
    currency.judge(
      cleanRuntime,
      new Map(ids.map((id) => [id, { id, scope: "space" }])),
      () => true,
      true,
    );

  /** A snapshot with one record of each of `pieces`, at `asOf`. */
  const snapshotOf = (asOf: number, ...pieces: string[]) => ({
    asOf,
    seen: [],
    records: pieces.map((piece) => ({
      piece,
      under: [],
      vouched: true,
      writes: [],
      owned: [],
      slices: [{ key: "space", vouched: true, reads: [], vouches: [] }],
    })),
  });

  /** A mark of a slice of `piece` at `seq`. */
  const markOf = (
    piece: string,
    seq: number,
    extra: { under?: string[]; upstream?: true } = {},
  ): CurrencyMarked => ({
    piece,
    slice: "space",
    seq,
    under: extra.under ?? [],
    ...(extra.upstream && { upstream: true as const }),
  });

  beforeEach(() => {
    stored = {
      marked: [],
      falseClean: [],
      blocked: [],
      blockedBy: [],
      behind: [],
      unread: [],
    };
    judgment = servableJudgment;
    judgedRoots = [];
    advanced = [];
    advances = 0;
    marked = [];
    owedCalls = 0;
    runningPieces = new Set();
    changedPieces = [];
    readsUnstarted = false;
    patterned = true;
    loopStats = emptyServingLoopStats();
  });

  describe("instance members", () => {
    describe("store()", () => {
      it("stores clean a ring of pieces that takes more than one request, and owes none of them another snapshot", async () => {
        const { asOf, records } = ring(65);

        currency.store({ asOf, seen: [], records });
        await currency.stored;

        expect(batches.map((batch) => batch.records.length)).toEqual([64, 1]);
        expect(batches[0].settle).toBeUndefined();
        expect(batches[1].settle).toHaveLength(64);
        expect(marksOf(records)).toEqual({ 0: 65 });
        expect(owed).toBe(0);
      });

      it("names no pieces to settle in a snapshot that takes one request", async () => {
        const { asOf, records } = ring(3);

        currency.store({ asOf, seen: [], records });
        await currency.stored;

        expect(batches.map((batch) => batch.settle)).toEqual([undefined]);
        expect(marksOf(records)).toEqual({ 0: 3 });
      });

      it("has the next snapshot cover the pieces of one whose request failed", async () => {
        const { asOf, records } = ring(2);
        failure = new Error("the store is gone");

        currency.store({ asOf, seen: [], records });
        await currency.stored;

        expect(batches).toEqual([]);
        expect(currency.storing).toBe(false);
        expect([...currency.accessForTestingOnly.owed]).toEqual(
          records.map(({ piece }) => piece),
        );
      });

      it("warns of the pieces the index held clean that wrote a different value, and counts them", async () => {
        using logs = captureLogs("store-currency");
        const currency = scriptedLoop("record");
        currency.store(snapshotOf(1, "of:a", "of:b"));
        await currency.stored;
        expect(logs.textsOf("currency-false-clean")).toEqual([]);

        stored.falseClean = ["of:a", "of:b"];
        currency.store(snapshotOf(2, "of:a", "of:b"));
        await currency.stored;

        const lines = logs.textsOf("currency-false-clean");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(SPACE);
        expect(lines[0]).toContain("2 piece(s)");
        expect(lines[0]).toContain("of:a, of:b");
        expect(loopStats.currency.falseClean).toBe(2);
      });

      it("re-arms each key left unloaded whose piece, or a piece beneath it, a stored record finds marked, at the lowest seq", async () => {
        const currency = scriptedLoop("skip");
        await judgeEach(currency, "of:a", "of:b");
        stored.marked = [markOf("of:elsewhere", 2)];
        currency.store(snapshotOf(1, "of:x"));
        await currency.stored;
        expect(marked).toEqual([]);

        stored.marked = [
          markOf("of:nested", 7, { under: ["of:a"] }),
          markOf("of:a", 5),
          markOf("of:nested", 9, { under: ["of:a"] }),
        ];
        currency.store(snapshotOf(2, "of:x"));
        await currency.stored;

        expect(marked).toEqual([[{ key: "of:a", seq: 5 }]]);
        expect(loopStats.currency.rearmed).toBe(1);
        expect(currency.servesFromStore).toBe(true);
      });

      it("owes a snapshot of the pieces that keep a stored one marked, with that one, once until they change", async () => {
        const currency = scriptedLoop("record");
        stored.blocked = ["of:reader"];
        stored.blockedBy = ["of:writer"];

        currency.store(snapshotOf(1, "of:reader"));
        await currency.stored;
        expect(owedCalls).toBe(1);
        expect([...currency.accessForTestingOnly.owed].sort()).toEqual([
          "of:reader",
          "of:writer",
        ]);

        currency.snapshot(cleanRuntime, 2, []);
        currency.store(snapshotOf(2, "of:reader"));
        await currency.stored;
        expect(owedCalls).toBe(1);
        expect(currency.accessForTestingOnly.owed.size).toBe(0);

        changedPieces = ["of:writer"];
        currency.snapshot(cleanRuntime, 3, []);
        currency.store(snapshotOf(3, "of:reader"));
        await currency.stored;
        expect(owedCalls).toBe(2);
        expect([...currency.accessForTestingOnly.owed]).toEqual([
          "of:writer",
        ]);
      });
    });

    describe("snapshot()", () => {
      const FAR = "did:key:z6Mk-store-currency-test-far";

      /** The reads the scheduler reports for each piece, by piece. */
      let reads: Map<string, Array<{ space: string; id: string }>>;

      /** The pieces the scheduler reports as changed, once. */
      let changed: string[];

      /** The scope the scheduler reports each piece's root at. */
      let rootScope: "space" | "session";

      /**
       * The instances at another key the scheduler reports each piece's
       * slice as deciding and as holding a later write of, by piece.
       */
      let slots: Map<string, {
        decides: Array<{ id: string; scopeKey: "space" }>;
        superseded: Array<{ id: string; scopeKey: "space" }>;
      }>;

      /**
       * A runtime whose scheduler reports `changed` as the pieces that
       * changed, each with one user's slice that read what `reads` holds
       * for it, and no piece that `reads` does not name.
       */
      const runtime = {
        scheduler: {
          takeChangedPieces: () => changed.splice(0),
          pieceCurrencySnapshot: (_space: string, piece: string) => {
            const read = reads.get(piece);
            return read === undefined ? undefined : {
              rootScope,
              under: [],
              unvouched: [],
              writes: [],
              slices: [{
                key: "user:alice",
                unvouched: [],
                reads: read.map(({ space, id }) => ({
                  space,
                  id,
                  scopeKey: "space",
                  derived: false,
                })),
                vouches: [],
                decides: slots.get(piece)?.decides ?? [],
                superseded: slots.get(piece)?.superseded ?? [],
              }],
            };
          },
        },
        runner: {
          pieceCurrencyFacts: () => ({ owned: [], absentAsDefault: [] }),
        },
        getCellFromLink: () => ({}),
      } as unknown as Runtime;

      beforeEach(() => {
        reads = new Map();
        changed = [];
        slots = new Map();
        rootScope = "space";
      });

      it("records the instances a slice decides and those it holds a later write of, and names neither list for a slice with none", () => {
        reads.set("of:piece", []);
        reads.set("of:plain", []);
        slots.set("of:piece", {
          decides: [{ id: "computed:held", scopeKey: "space" }],
          superseded: [{ id: "computed:lost", scopeKey: "space" }],
        });
        changed = ["of:piece", "of:plain"];

        const snapshot = currency.snapshot(runtime, 0, []);

        expect(
          snapshot?.records.map(({ piece, slices }) => ({
            piece,
            slices: slices.map(({ key, decides, superseded }) => ({
              key,
              decides,
              superseded,
            })),
          })),
        ).toEqual([
          {
            piece: "of:piece",
            slices: [{
              key: "user:alice",
              decides: [{ id: "computed:held", scopeKey: "space" }],
              superseded: [{ id: "computed:lost", scopeKey: "space" }],
            }],
          },
          {
            piece: "of:plain",
            slices: [{
              key: "user:alice",
              decides: undefined,
              superseded: undefined,
            }],
          },
        ]);
      });

      it("keeps what a piece's runs read in another space, with the slice each run belongs to", () => {
        reads.set("of:piece", [
          { space: FAR, id: "of:far" },
          { space: SPACE, id: "of:near" },
        ]);
        changed = ["of:piece"];

        currency.snapshot(runtime, 0, []);

        expect([...currency.foreignReads]).toEqual([["of:piece", [{
          slice: "user:alice",
          space: FAR,
          id: "of:far",
          scopeKey: "space",
        }]]]);
        expect(currency.takeForeignReadsChanged()).toBe(true);
        expect(currency.takeForeignReadsChanged()).toBe(false);
      });

      it("vouches for a piece that records a source origin, and says so in its record", () => {
        reads.set("of:piece", [{ space: SPACE, id: "of:near" }]);
        changed = ["of:piece"];
        const following = {
          ...runtime,
          runner: {
            pieceCurrencyFacts: () => ({
              owned: [],
              absentAsDefault: [],
              followsOrigin: true,
            }),
          },
        } as unknown as Runtime;

        const snapshot = currency.snapshot(following, 0, []);

        expect(
          snapshot?.records.map(({ piece, vouched, followsOrigin }) => ({
            piece,
            vouched,
            followsOrigin,
          })),
        ).toEqual([{ piece: "of:piece", vouched: true, followsOrigin: true }]);
      });

      describe("for a piece whose root each viewer holds an instance of", () => {
        /** The scope of the cell the runner was asked the facts of. */
        let asked: unknown;

        /** A runtime whose runner reports `facts` for every piece. */
        const scopedRuntime = (facts: {
          owned: string[];
          absentAsDefault: string[];
          followsOrigin?: boolean;
        }) =>
          ({
            ...runtime,
            getCellFromLink: (link: { scope: unknown }) => {
              asked = link.scope;
              return {};
            },
            runner: { pieceCurrencyFacts: () => facts },
          }) as unknown as Runtime;

        beforeEach(() => {
          rootScope = "session";
          reads.set("of:piece", [{ space: SPACE, id: "of:near" }]);
          changed = ["of:piece"];
        });

        it("asks the runner about the root at its own scope, and vouches for the piece", () => {
          const snapshot = currency.snapshot(
            scopedRuntime({
              owned: ["of:owned"],
              absentAsDefault: ["of:owned"],
            }),
            0,
            [],
          );

          expect(asked).toBe("session");
          expect(
            snapshot?.records.map((
              { piece, vouched, owned, absentAsDefault },
            ) => ({ piece, vouched, owned, absentAsDefault })),
          ).toEqual([{
            piece: "of:piece",
            vouched: true,
            owned: ["of:owned"],
            absentAsDefault: ["of:owned"],
          }]);
        });

        it("does not vouch for the piece where an instance of its root records a source origin, and records no origin for it", () => {
          // An origin is followed through one result document, and such a
          // piece holds one for each viewer.

          const snapshot = currency.snapshot(
            scopedRuntime({
              owned: [],
              absentAsDefault: [],
              followsOrigin: true,
            }),
            0,
            [],
          );

          expect(
            snapshot?.records.map(({ piece, vouched, followsOrigin }) => ({
              piece,
              vouched,
              followsOrigin,
            })),
          ).toEqual([{
            piece: "of:piece",
            vouched: false,
            followsOrigin: undefined,
          }]);
        });
      });

      it("reports no change for a piece that reads no other space", () => {
        reads.set("of:piece", [{ space: SPACE, id: "of:near" }]);
        changed = ["of:piece"];

        currency.snapshot(runtime, 0, []);

        expect(currency.foreignReads.size).toBe(0);
        expect(currency.takeForeignReadsChanged()).toBe(false);
      });

      it("drops the reads of a piece that is gone, and reports the change though it returns no record", () => {
        reads.set("of:piece", [{ space: FAR, id: "of:far" }]);
        changed = ["of:piece"];
        currency.snapshot(runtime, 0, []);
        currency.takeForeignReadsChanged();
        reads.clear();
        changed = ["of:piece"];

        expect(currency.snapshot(runtime, 0, [])).toBeUndefined();

        expect(currency.foreignReads.size).toBe(0);
        expect(currency.takeForeignReadsChanged()).toBe(true);
      });

      it("records a changed piece named by a document id, and none named by anything else", () => {
        const currency = scriptedLoop("record");
        changedPieces = ["of:piece", "piece-without-scheme"];

        const snapshot = currency.snapshot(cleanRuntime, 1, []);

        expect(snapshot?.records.map(({ piece }) => piece)).toEqual([
          "of:piece",
        ]);
      });

      it("does not vouch for a piece the runner finds no pattern behind, and counts the reason", () => {
        const currency = scriptedLoop("record");
        changedPieces = ["of:piece"];
        patterned = false;
        const unpatterned = currency.snapshot(cleanRuntime, 1, []);
        changedPieces = ["of:other"];
        patterned = true;
        const patternedSnapshot = currency.snapshot(cleanRuntime, 1, []);

        expect(unpatterned?.records.map(({ vouched }) => vouched)).toEqual([
          false,
        ]);
        expect(patternedSnapshot?.records.map(({ vouched }) => vouched))
          .toEqual([true]);
        expect(loopStats.currency.unvouched).toEqual({ "no-pattern": 1 });
      });

      it("takes a piece a stored record left behind a commit again only at a settle that covers more", async () => {
        const currency = scriptedLoop("record");
        stored.behind = ["of:piece"];

        currency.store(snapshotOf(3, "of:piece"));
        await currency.stored;

        expect(owedCalls).toBe(1);
        expect(currency.snapshot(cleanRuntime, 3, [])).toBeUndefined();
        expect([...currency.accessForTestingOnly.owed]).toEqual(["of:piece"]);
        expect(
          currency.snapshot(cleanRuntime, 4, [])?.records.map(({ piece }) =>
            piece
          ),
        ).toEqual(["of:piece"]);
        expect(currency.accessForTestingOnly.owed.size).toBe(0);
      });

      it("follows the marks for a running piece that reads the output of an unstarted one only where it starts what is upstream", () => {
        const starting = scriptedLoop("start-upstream");
        const skipping = scriptedLoop("skip");
        readsUnstarted = true;

        changedPieces = ["of:piece"];
        starting.snapshot(cleanRuntime, 1, []);
        changedPieces = ["of:piece"];
        skipping.snapshot(cleanRuntime, 1, []);

        expect([starting.followsMarks, skipping.followsMarks]).toEqual([
          true,
          false,
        ]);

        readsUnstarted = false;
        changedPieces = ["of:piece"];
        starting.snapshot(cleanRuntime, 2, []);

        expect(starting.followsMarks).toBe(false);
      });
    });

    describe("judge()", () => {
      it("asks the memory server about the space-scoped roots and the `computed:` roots of any scope, and about no other narrower root", async () => {
        const asked: string[][] = [];
        const currency = new StoreCurrency({
          space: SPACE,
          server: {
            judgeCurrencyRoots: (_space, roots) => {
              asked.push([...roots]);
              return Promise.resolve({
                servable: roots.map((root) => ({
                  root,
                  piece: "of:piece",
                  origins: [],
                })),
                held: [],
                upstream: [],
                refused: {},
                marked: [],
              });
            },
          } as Pick<HostMemoryServer, "judgeCurrencyRoots"> as HostMemoryServer,
          mode: "skip",
          epoch: "epoch-one",
          serviceIdentity: "did:key:service",
          stats: emptyServingLoopStats(),
          onOwed: () => {},
          onMarked: () => {},
        });
        const idleRuntime = {
          scheduler: { hasNodesUnderDemandRoot: () => false },
        } as unknown as Runtime;

        const judged = await currency.judge(
          idleRuntime,
          new Map([
            ["shared", { id: "of:result", scope: "space" }],
            ["derived", { id: "computed:total", scope: "space" }],
            ["own-derived", { id: "computed:draft", scope: "user" }],
            ["own-state", { id: "of:draft", scope: "user" }],
          ]),
          () => true,
          true,
        );

        expect(asked).toEqual([[
          "of:result",
          "computed:total",
          "computed:draft",
        ]]);
        expect(judged.servable).toEqual(["shared", "derived", "own-derived"]);
      });

      describe("for a root the memory server finds plain", () => {
        const idleRuntime = {
          scheduler: { hasNodesUnderDemandRoot: () => false },
        } as unknown as Runtime;

        /** A loop in `mode` whose memory server finds `of:data` plain. */
        const plainIn = (
          mode: CurrencyIndexMode,
          stats: ServingLoopStats,
        ) =>
          new StoreCurrency({
            space: SPACE,
            server: {
              judgeCurrencyRoots: (_space, roots) =>
                Promise.resolve({
                  servable: roots.filter((root) => root !== "of:data").map((
                    root,
                  ) => ({ root, piece: "of:piece", origins: [] })),
                  plain: roots.filter((root) => root === "of:data"),
                  held: [],
                  upstream: [],
                  refused: {},
                  marked: [],
                }),
            } as Pick<
              HostMemoryServer,
              "judgeCurrencyRoots"
            > as HostMemoryServer,
            mode,
            epoch: "epoch-one",
            serviceIdentity: "did:key:service",
            stats,
            onOwed: () => {},
            onMarked: () => {},
          });

        /** Judges `of:data` under the key `data` beside `of:result`. */
        const judgeBoth = (currency: StoreCurrency) =>
          currency.judge(
            idleRuntime,
            new Map([
              ["data", { id: "of:data", scope: "space" }],
              ["result", { id: "of:result", scope: "space" }],
            ]),
            () => true,
            true,
          );

        it("returns its key apart from the servable ones, and counts it as plain and not as left unloaded, under `skip`", async () => {
          const stats = emptyServingLoopStats();
          const currency = plainIn("skip", stats);

          const judged = await judgeBoth(currency);

          expect(judged.plain).toEqual(["data"]);
          expect(judged.servable).toEqual(["result"]);
          expect(stats.currency.plainRoots).toBe(1);
          expect(stats.currency.servable).toBe(1);
          expect(stats.currency.servedFromStore).toBe(1);
        });

        it("returns its key and counts it as plain, under `record`", async () => {
          const stats = emptyServingLoopStats();
          const currency = plainIn("record", stats);

          const judged = await judgeBoth(currency);

          expect(judged.plain).toEqual(["data"]);
          expect(stats.currency.plainRoots).toBe(1);
          expect(stats.currency.servedFromStore).toBe(0);
        });
      });

      describe("for a root that rests on a piece recording a source origin", () => {
        let judgments: number;
        let currency: StoreCurrency;
        const idleRuntime = {
          scheduler: { hasNodesUnderDemandRoot: () => false },
        } as unknown as Runtime;

        /** Judges the one root, saying whether the demand changed. */
        const judgeRoot = (demandChanged: boolean) =>
          currency.judge(
            idleRuntime,
            new Map([["key", { id: "of:result", scope: "space" }]]),
            () => true,
            demandChanged,
          );

        beforeEach(() => {
          judgments = 0;
          currency = new StoreCurrency({
            space: SPACE,
            server: {
              judgeCurrencyRoots: (_space, roots) => {
                judgments += 1;
                return Promise.resolve({
                  servable: roots.map((root) => ({
                    root,
                    piece: "of:piece",
                    origins: ["of:piece", "of:nested"],
                  })),
                  held: [],
                  upstream: [],
                  refused: {},
                  marked: [],
                });
              },
            } as Pick<
              HostMemoryServer,
              "judgeCurrencyRoots"
            > as HostMemoryServer,
            mode: "skip",
            epoch: "epoch-one",
            serviceIdentity: "did:key:service",
            stats: emptyServingLoopStats(),
            onOwed: () => {},
            onMarked: () => {},
          });
        });

        it("returns those pieces with the root's key, and again while it asks the memory server nothing new", async () => {
          const first = await judgeRoot(true);

          const second = await judgeRoot(false);

          expect(judgments).toBe(1);
          expect([[...first.origins], [...second.origins]]).toEqual([
            [["key", ["of:piece", "of:nested"]]],
            [["key", ["of:piece", "of:nested"]]],
          ]);
        });

        it("counts the root no longer among those left unloaded once the caller loads it", async () => {
          await judgeRoot(true);
          expect(currency.servesFromStore).toBe(true);

          currency.load("key");

          expect(currency.servesFromStore).toBe(false);
        });
      });

      it("loads a root it left unloaded once the root's piece has started some other way, and asks the memory server nothing for it", async () => {
        const currency = scriptedLoop("skip");
        expect((await judgeEach(currency, "of:a")).servable).toEqual(["of:a"]);

        runningPieces.add("of:a");
        const started = await judgeEach(currency, "of:a");

        expect(started.servable).toEqual([]);
        expect(currency.servesFromStore).toBe(false);
        expect(judgedRoots).toEqual([["of:a"]]);
      });

      it("counts the roots the memory server refused by reason, across judgments", async () => {
        const currency = scriptedLoop("record");
        judgment = (roots) => ({
          ...servableJudgment(roots),
          refused: { marked: 2, "no-record": 1 },
        });

        await judgeEach(currency, "of:a");
        judgment = (roots) => ({
          ...servableJudgment(roots),
          refused: { marked: 1 },
        });
        await judgeEach(currency, "of:a");

        expect(loopStats.currency.refused).toEqual({
          marked: 3,
          "no-record": 1,
        });
      });

      it("holds a root again once a judgment names a piece upstream of an abandoned reader that was not named before", async () => {
        const currency = scriptedLoop("start-upstream");
        judgment = heldJudgment([upstreamRead("of:reader")]);
        await judgeEach(currency, "of:reader");
        currency.abandonUpstream("of:reader");
        expect((await judgeEach(currency, "of:reader")).held).toEqual([]);

        judgment = heldJudgment([
          upstreamRead("of:reader"),
          upstreamRead("of:reader", "of:other-producer"),
        ]);

        expect((await judgeEach(currency, "of:reader")).held).toEqual([
          "of:reader",
        ]);
        expect(currency.staleUpstream).toBe(true);
      });

      it("asks afresh about an abandoned reader once a judgment asked about it names nothing upstream of it", async () => {
        const currency = scriptedLoop("start-upstream");
        judgment = heldJudgment([upstreamRead("of:reader")]);
        await judgeEach(currency, "of:reader");
        currency.abandonUpstream("of:reader");
        judgment = (roots) => ({
          ...servableJudgment(roots),
          servable: roots.map((root) => ({
            root,
            piece: "of:reader",
            origins: [],
          })),
        });
        await judgeEach(currency, "of:reader");

        judgment = heldJudgment([upstreamRead("of:reader")]);

        expect((await judgeEach(currency, "of:reader")).held).toEqual([
          "of:reader",
        ]);
      });

      it("owes a snapshot of a piece upstream that runs here when a judgment first names it", async () => {
        const currency = scriptedLoop("start-upstream");
        runningPieces.add("of:producer");
        judgment = heldJudgment([
          upstreamRead("of:reader"),
          upstreamRead("of:reader", "of:stopped"),
        ]);

        await judgeEach(currency, "of:reader");

        expect([...currency.accessForTestingOnly.owed]).toEqual([
          "of:producer",
        ]);
      });
    });

    describe("judge(), for a root the memory server returns as stale only upstream", () => {
      /** The read that keeps `of:reader` stale, of an output of `of:producer`. */
      const UPSTREAM = {
        reader: "of:reader",
        slice: "space",
        id: "computed:out",
        scopeKey: "space",
        piece: "of:producer",
      };

      /**
       * The read that keeps `of:nested`, a piece beneath `of:reader`, stale,
       * of the same output.
       */
      const NESTED = { ...UPSTREAM, reader: "of:nested" };

      /** The pieces that run on the runtime the judgments are made for. */
      let running: Set<string>;

      /** Whether the memory server returns the root as held. */
      let stale: boolean;

      /** The reads the memory server returns as upstream of a held root. */
      let reads: Array<typeof UPSTREAM>;

      /** What the loops of a case counted. */
      let stats: ServingLoopStats;

      /** A loop that keeps the index as `mode` says. */
      const loop = (mode: CurrencyIndexMode) =>
        new StoreCurrency({
          space: SPACE,
          server: {
            judgeCurrencyRoots: (_space, roots) =>
              Promise.resolve({
                servable: stale
                  ? []
                  : roots.map((root) => ({ root, piece: root, origins: [] })),
                held: stale
                  ? roots.map((root) => ({
                    root,
                    piece: "of:reader",
                    readers: reads.map(({ reader }) => reader),
                  }))
                  : [],
                upstream: stale ? reads : [],
                refused: {},
                marked: [],
              }),
          } as Pick<HostMemoryServer, "judgeCurrencyRoots"> as HostMemoryServer,
          mode,
          epoch: "epoch-one",
          serviceIdentity: "did:key:service",
          stats,
          onOwed: () => {},
          onMarked: () => {},
          runs: (piece) => running.has(piece),
        });

      /** A runtime that runs the pieces of `running`. */
      const runtime = {
        scheduler: {
          hasNodesUnderDemandRoot: (piece: string) => running.has(piece),
        },
      } as unknown as Runtime;

      /** Judges the root `of:reader`, with the sessions' demand changed. */
      const judge = (currency: StoreCurrency) =>
        currency.judge(
          runtime,
          new Map([["key", { id: "of:reader", scope: "space" }]]),
          () => true,
          true,
        );

      beforeEach(() => {
        running = new Set();
        stale = true;
        reads = [UPSTREAM];
        stats = emptyServingLoopStats();
      });

      it("carries demand in every mode but `skip`", () => {
        expect(
          (["record", "skip", "start-upstream"] as const).map((mode) =>
            loop(mode).carriesDemand
          ),
        ).toEqual([true, false, true]);
      });

      it("holds no root under `skip`, counts the root as refused for `stale-upstream`, and names nothing to demand", async () => {
        const currency = loop("skip");

        expect(await judge(currency)).toEqual({
          servable: [],
          origins: new Map(),
          plain: [],
          held: [],
          rearm: [],
        });
        expect(currency.staleUpstream).toBe(false);
        expect(currency.servesFromStore).toBe(false);
        expect(currency.upstreamReads).toEqual([]);
        expect([...currency.upstreamProducers]).toEqual([]);
        expect(currency.takeUpstreamChanged()).toBe(false);
        expect(stats.currency.refused).toEqual({ "stale-upstream": 1 });
        expect(stats.currency.heldUpstream).toBe(0);
      });

      it("counts no root as refused for `stale-upstream` under `start-upstream` or `record`", async () => {
        await judge(loop("start-upstream"));
        await judge(loop("record"));

        expect(stats.currency.refused).toEqual({});
        expect(stats.currency.heldUpstream).toBe(1);
      });

      it("keeps no running piece as one that is stale upstream under `skip`", async () => {
        const currency = loop("skip");
        running.add("of:reader");

        expect((await judge(currency)).held).toEqual([]);
        expect(currency.staleUpstream).toBe(false);
        expect(currency.upstreamReads).toEqual([]);
      });

      it("takes a root it had left unloaded under `skip` out of those once the memory server returns it as stale only upstream", async () => {
        const currency = loop("skip");
        stale = false;
        expect((await judge(currency)).servable).toEqual(["key"]);
        stale = true;

        expect(await judge(currency)).toEqual({
          servable: [],
          origins: new Map(),
          plain: [],
          held: [],
          rearm: [],
        });
        expect(currency.servesFromStore).toBe(false);
        expect(currency.staleUpstream).toBe(false);
        expect(stats.currency.rearmed).toBe(1);
      });

      it("holds the root under `start-upstream`, and returns the instance that keeps it stale as one to demand", async () => {
        const currency = loop("start-upstream");

        expect(await judge(currency)).toEqual({
          servable: [],
          origins: new Map(),
          plain: [],
          held: ["key"],
          rearm: [],
        });
        expect(currency.staleUpstream).toBe(true);
        expect(currency.upstreamReads).toEqual([{
          slice: "space",
          space: SPACE,
          id: "computed:out",
          scopeKey: "space",
        }]);
        expect([...currency.upstreamProducers]).toEqual([
          ["of:reader", new Set(["of:producer"])],
        ]);
      });

      it("holds no root under `record`, and keeps the root's piece as one that is stale while it runs", async () => {
        const currency = loop("record");
        running.add("of:reader");

        expect((await judge(currency)).held).toEqual([]);
        expect(currency.staleUpstream).toBe(true);
        expect(currency.upstreamReads).toHaveLength(1);
      });

      it("serves the root, and demands nothing, once the memory server returns it as servable", async () => {
        const currency = loop("start-upstream");
        await judge(currency);
        expect(currency.takeUpstreamChanged()).toBe(true);
        stale = false;

        expect(await judge(currency)).toEqual({
          servable: ["key"],
          origins: new Map(),
          plain: [],
          held: [],
          rearm: [],
        });
        expect(currency.staleUpstream).toBe(false);
        expect(currency.upstreamReads).toEqual([]);
        expect(currency.takeUpstreamChanged()).toBe(true);
      });

      it("reports a piece upstream as just named at the first judgment that names it, and not at the next", async () => {
        const currency = loop("start-upstream");

        await judge(currency);
        expect(currency.producerProgress("of:producer").named).toBe(true);
        await judge(currency);

        expect(currency.producerProgress("of:producer")).toEqual({
          named: false,
          unrecorded: true,
        });
      });

      it("holds the root no longer once what is upstream of it was given up on, while the same piece is named for it", async () => {
        const currency = loop("start-upstream");
        await judge(currency);

        expect(currency.abandonUpstream("of:reader")).toEqual(["key"]);

        expect(currency.staleUpstream).toBe(false);
        expect(currency.upstreamReads).toEqual([]);
        expect((await judge(currency)).held).toEqual([]);
        expect(currency.staleUpstream).toBe(false);
      });

      it("holds the root under `start-upstream` for a read of a piece beneath its own", async () => {
        const currency = loop("start-upstream");
        reads = [NESTED];

        expect(await judge(currency)).toEqual({
          servable: [],
          origins: new Map(),
          plain: [],
          held: ["key"],
          rearm: [],
        });
        expect(currency.staleUpstream).toBe(true);
        expect([...currency.upstreamProducers]).toEqual([
          ["of:nested", new Set(["of:producer"])],
        ]);
      });

      it("keeps the piece beneath the root's own as one that is stale while the root's piece runs", async () => {
        const currency = loop("record");
        reads = [NESTED];
        running.add("of:reader");

        expect((await judge(currency)).held).toEqual([]);
        expect(currency.staleUpstream).toBe(true);
        stale = false;
        await judge(currency);
        expect(currency.staleUpstream).toBe(false);
      });

      it("holds nothing once everything upstream was given up on, and holds the root no more while the same piece is named", async () => {
        const currency = loop("start-upstream");
        reads = [UPSTREAM, NESTED];
        await judge(currency);

        expect(currency.abandonAllUpstream()).toEqual(["key"]);

        expect(currency.staleUpstream).toBe(false);
        expect(currency.upstreamReads).toEqual([]);
        expect((await judge(currency)).held).toEqual([]);
        expect(currency.staleUpstream).toBe(false);
      });

      it("asks the memory server again at the next judgment once one is owed", async () => {
        const currency = loop("start-upstream");
        const settled = () =>
          currency.judge(
            runtime,
            new Map([["key", { id: "of:reader", scope: "space" }]]),
            () => true,
            false,
          );
        await settled();
        stale = false;
        expect((await settled()).held).toEqual(["key"]);

        currency.oweJudgment();

        expect((await settled()).servable).toEqual(["key"]);
      });

      it("asks the memory server once about a running piece that each stored record leaves stale with nothing upstream to start", async () => {
        const asked: string[][] = [];
        const currency = new StoreCurrency({
          space: SPACE,
          server: {
            judgeCurrencyRoots: (_space, _roots, options) => {
              asked.push([...(options.running ?? [])]);
              return Promise.resolve({
                servable: [],
                held: [],
                upstream: [],
                refused: {},
                marked: [],
              });
            },
            storeCurrencyRecords: () =>
              Promise.resolve({
                marked: [],
                falseClean: [],
                blocked: ["of:reader"],
                blockedBy: [],
                behind: [],
                unread: [],
              }),
          } as Pick<
            HostMemoryServer,
            "judgeCurrencyRoots" | "storeCurrencyRecords"
          > as HostMemoryServer,
          mode: "record",
          epoch: "epoch-one",
          serviceIdentity: "did:key:service",
          stats: emptyServingLoopStats(),
          onOwed: () => {},
          onMarked: () => {},
          runs: () => true,
        });
        const snapshot = {
          asOf: 1,
          seen: [],
          records: [{
            piece: "of:reader",
            under: [],
            vouched: true,
            writes: [],
            owned: [],
            slices: [{ key: "space", vouched: true, reads: [], vouches: [] }],
          }],
        };
        const judgeNoRoot = () =>
          currency.judge(runtime, new Map(), () => true, false);

        currency.store(snapshot);
        await currency.stored;
        await judgeNoRoot();
        currency.store(snapshot);
        await currency.stored;
        await judgeNoRoot();

        expect(asked).toEqual([["of:reader"]]);
        expect(currency.staleUpstream).toBe(false);
      });

      it("asks the memory server nothing about a running piece that a stored record leaves stale, under `skip`", async () => {
        const asked: string[][] = [];
        const currency = new StoreCurrency({
          space: SPACE,
          server: {
            judgeCurrencyRoots: (_space, _roots, options) => {
              asked.push([...(options.running ?? [])]);
              return Promise.resolve({
                servable: [],
                held: [],
                upstream: [],
                refused: {},
                marked: [],
              });
            },
            storeCurrencyRecords: () =>
              Promise.resolve({
                marked: [{
                  piece: "of:reader",
                  slice: "space",
                  under: [],
                  seq: 1,
                  upstream: true as const,
                }],
                falseClean: [],
                blocked: ["of:reader"],
                blockedBy: [],
                behind: [],
                unread: [],
              }),
          } as Pick<
            HostMemoryServer,
            "judgeCurrencyRoots" | "storeCurrencyRecords"
          > as HostMemoryServer,
          mode: "skip",
          epoch: "epoch-one",
          serviceIdentity: "did:key:service",
          stats,
          onOwed: () => {},
          onMarked: () => {},
          runs: () => true,
        });

        currency.store({
          asOf: 1,
          seen: [],
          records: [{
            piece: "of:reader",
            under: [],
            vouched: true,
            writes: [],
            owned: [],
            slices: [{ key: "space", vouched: true, reads: [], vouches: [] }],
          }],
        });
        await currency.stored;
        await currency.judge(runtime, new Map(), () => true, false);

        expect(asked).toEqual([]);
        expect(currency.staleUpstream).toBe(false);
        expect(currency.nextExpiry).toBeUndefined();
      });

      it("holds the root until what is upstream of each piece whose read holds it was given up on", async () => {
        const currency = loop("start-upstream");
        reads = [UPSTREAM, NESTED];
        await judge(currency);

        expect(currency.abandonUpstream("of:reader")).toEqual([]);
        expect(currency.staleUpstream).toBe(true);
        expect((await judge(currency)).held).toEqual(["key"]);
        expect(currency.abandonUpstream("of:nested")).toEqual(["key"]);
        expect(currency.staleUpstream).toBe(false);
      });
    });

    describe("noteIndexChanged()", () => {
      /** The root every judgment of these cases is asked about. */
      const ROOT = "of:root";

      /** How many judgments the memory server was asked for. */
      let judgments: number;

      /** What holds a judgment back until it is resolved, where one is set. */
      let held: PromiseWithResolvers<void> | undefined;

      /** A loop that leaves unloaded each root the store can serve. */
      let skipping: StoreCurrency;

      /** A runtime that runs no piece. */
      const idleRuntime = {
        scheduler: { hasNodesUnderDemandRoot: () => false },
      } as unknown as Runtime;

      beforeEach(() => {
        judgments = 0;
        held = undefined;
        skipping = new StoreCurrency({
          space: SPACE,
          server: {
            judgeCurrencyRoots: async (_space, roots) => {
              judgments += 1;
              await held?.promise;
              return {
                servable: roots.map((root) => ({
                  root,
                  piece: root,
                  origins: [],
                })),
                held: [],
                upstream: [],
                refused: {},
                marked: [],
              };
            },
          } as Pick<HostMemoryServer, "judgeCurrencyRoots"> as HostMemoryServer,
          mode: "skip",
          epoch: "epoch-one",
          serviceIdentity: "did:key:service",
          stats: emptyServingLoopStats(),
          onOwed: () => {},
          onMarked: () => {},
        });
      });

      /** Judges `ROOT` with no session's demand changed. */
      const judge = () =>
        skipping.judge(
          idleRuntime,
          new Map([["key", { id: ROOT, scope: "space" }]]),
          () => true,
          false,
        );

      it("returns `false` while no root is left unloaded and no judgment is under way", () => {
        expect(skipping.noteIndexChanged()).toBe(false);
      });

      it("returns `true` once a root is left unloaded, and has the next judgment ask the memory server again", async () => {
        await judge();
        await judge();
        expect(judgments).toBe(1);

        expect(skipping.noteIndexChanged()).toBe(true);
        await judge();

        expect(judgments).toBe(2);
      });

      it("returns `true` while a judgment is under way, and has the one after it ask the memory server again", async () => {
        held = Promise.withResolvers<void>();
        const judging = judge();

        expect(skipping.noteIndexChanged()).toBe(true);
        held.resolve();
        await judging;
        await judge();

        expect(judgments).toBe(2);
      });
    });
    describe("producerProgress()", () => {
      it("reports a piece upstream as unrecorded until a record of it is stored, while records are on their way, and while it is owed", async () => {
        const currency = scriptedLoop("start-upstream");
        judgment = heldJudgment([upstreamRead("of:reader")]);
        await judgeEach(currency, "of:reader");
        expect(currency.producerProgress("of:producer").unrecorded).toBe(
          true,
        );

        currency.store(snapshotOf(1, "of:producer"));
        await currency.stored;
        expect(currency.producerProgress("of:producer").unrecorded).toBe(
          false,
        );

        currency.store(snapshotOf(2, "of:unrelated"));
        expect(currency.producerProgress("of:producer").unrecorded).toBe(
          true,
        );
        await currency.stored;
        expect(currency.producerProgress("of:producer").unrecorded).toBe(
          false,
        );

        currency.owe(snapshotOf(3, "of:producer"));
        expect(currency.producerProgress("of:producer").unrecorded).toBe(
          true,
        );
      });
    });

    describe("abandonUpstream()", () => {
      it("releases nothing, and counts nothing, for a piece the last judgment named no read of", async () => {
        const currency = scriptedLoop("start-upstream");
        judgment = heldJudgment([upstreamRead("of:reader")]);
        await judgeEach(currency, "of:reader");

        expect(currency.abandonUpstream("of:unknown")).toEqual([]);
        expect(loopStats.currency.upstreamAbandoned).toBe(0);
        expect(currency.staleUpstream).toBe(true);
        expect(currency.abandonUpstream("of:reader")).toEqual(["of:reader"]);
        expect(loopStats.currency.upstreamAbandoned).toBe(1);
      });

      it("keeps held a root that only another piece's read holds", async () => {
        const currency = scriptedLoop("start-upstream");
        judgment = heldJudgment([
          upstreamRead("of:reader"),
          upstreamRead("of:other"),
        ]);
        await judgeEach(currency, "of:reader", "of:other");

        expect(currency.abandonUpstream("of:reader")).toEqual(["of:reader"]);

        expect(currency.staleUpstream).toBe(true);
        expect([...currency.upstreamProducers.keys()]).toEqual(["of:other"]);
      });
    });

    describe("abandonAllUpstream()", () => {
      it("releases a held root no read of which the last judgment named", async () => {
        const currency = scriptedLoop("start-upstream");
        judgment = heldJudgment([upstreamRead("of:reader")]);
        await judgeEach(currency, "of:reader");
        judgment = servableJudgment;
        await judgeEach(currency, "of:elsewhere");
        expect(currency.upstreamReads).toEqual([]);
        expect(currency.staleUpstream).toBe(true);

        expect(currency.abandonAllUpstream()).toEqual(["of:reader"]);

        expect(currency.staleUpstream).toBe(false);
      });
    });

    describe("advance()", () => {
      it("asks the memory server only while a root is left unloaded and the head has moved, and re-arms the keys it finds marked", async () => {
        const currency = scriptedLoop("skip");
        expect(await currency.advance(5)).toEqual([]);
        expect(advances).toBe(0);
        await judgeEach(currency, "of:a", "of:b");
        advanced = [markOf("of:a", 3)];

        expect(await currency.advance(5)).toEqual([{ key: "of:a", seq: 3 }]);
        expect(await currency.advance(5)).toEqual([]);
        expect(advances).toBe(1);
        advanced = [];
        expect(await currency.advance(6)).toEqual([]);
        expect(advances).toBe(2);
        expect(currency.servesFromStore).toBe(true);
        expect(loopStats.currency.rearmed).toBe(1);
      });

      it("takes a running piece found marked upstream as one that is stale upstream, where the loop starts what is upstream", async () => {
        const starting = scriptedLoop("start-upstream");
        const skipping = scriptedLoop("skip");
        runningPieces.add("of:running");
        await judgeEach(starting, "of:a");
        await judgeEach(skipping, "of:a");
        advanced = [
          markOf("of:running", 3, { upstream: true }),
          markOf("of:stopped", 3, { upstream: true }),
        ];

        expect(await starting.advance(1)).toEqual([]);
        expect(await skipping.advance(1)).toEqual([]);

        expect([starting.staleUpstream, skipping.staleUpstream]).toEqual([
          true,
          false,
        ]);
        await judgeEach(starting, "of:a");
        expect(starting.staleUpstream).toBe(false);
      });
    });

    describe("forget()", () => {
      it("takes a key out of those left unloaded and those held", async () => {
        const skipping = scriptedLoop("skip");
        await judgeEach(skipping, "of:a");
        const starting = scriptedLoop("start-upstream");
        judgment = heldJudgment([upstreamRead("of:reader")]);
        await judgeEach(starting, "of:reader");

        skipping.forget("of:a");
        starting.forget("of:reader");

        expect(skipping.servesFromStore).toBe(false);
        expect(starting.servesFromStore).toBe(false);
        expect(starting.staleUpstream).toBe(false);
      });
    });
  });
});
