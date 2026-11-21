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
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import { StoreCurrency } from "../../src/executor/store-currency.ts";
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
                servable: roots.map((root) => ({ root, piece: root })),
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
