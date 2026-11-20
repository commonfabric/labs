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
          vouches: [],
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
  });
});
