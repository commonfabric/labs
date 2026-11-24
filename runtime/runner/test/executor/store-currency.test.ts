import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  type CurrencyBatch,
  type CurrencyRecord,
  selectCurrencyPiece,
  storeCurrencyRecords,
} from "@commonfabric/memory/v2/currency-index";
import {
  applyCommit,
  close,
  type Engine,
  open,
} from "@commonfabric/memory/v2/engine";
import type { HostMemoryServer } from "../../src/executor/host-memory-server.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
} from "../../src/executor/stats.ts";
import {
  type CurrencyIndexMode,
  StoreCurrency,
} from "../../src/executor/store-currency.ts";
import type { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";

const SPACE = "did:key:z6Mk-store-currency-test-space" as MemorySpace;

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
        runner: { pieceCurrencyFacts: () => ({ owned: [] }) },
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
            pieceCurrencyFacts: () => ({ owned: [], followsOrigin: true }),
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
            scopedRuntime({ owned: ["of:owned"] }),
            0,
            [],
          );

          expect(asked).toBe("session");
          expect(
            snapshot?.records.map(({ piece, vouched, owned }) => ({
              piece,
              vouched,
              owned,
            })),
          ).toEqual([{
            piece: "of:piece",
            vouched: true,
            owned: ["of:owned"],
          }]);
        });

        it("does not vouch for the piece where an instance of its root records a source origin, and records no origin for it", () => {
          // An origin is followed through one result document, and such a
          // piece holds one for each viewer.

          const snapshot = currency.snapshot(
            scopedRuntime({ owned: [], followsOrigin: true }),
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

      it("holds no root under `skip`, counts the root as refused for `stale-upstream`, and names nothing to demand", async () => {
        const currency = loop("skip");

        expect(await judge(currency)).toEqual({
          servable: [],
          origins: new Map(),
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
  });
});
