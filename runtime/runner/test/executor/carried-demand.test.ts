import { expect } from "@std/expect";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import type { CarriedDemandRow } from "@commonfabric/memory/v2/server";
import { beforeEach, describe, it } from "@commonfabric/test-support/test";

import {
  CarriedDemand,
  type CarriedPair,
  carriedRowsOf,
} from "../../src/executor/carried-demand.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
} from "../../src/executor/stats.ts";
import type { ForeignRead } from "../../src/executor/store-currency.ts";

/** The space whose loop carries the demand. */
const SPACE = "did:key:z6Mk-carried-demand-test-space";

/** A space a run read. */
const SOURCE = "did:key:z6Mk-carried-demand-test-source";

/** Another space a run read. */
const OTHER = "did:key:z6Mk-carried-demand-test-other";
const SERVICE = "did:key:z6Mk-carried-demand-test-service";
const ALICE = "did:key:z6Mk-carried-demand-test-alice";
const BOB = "did:key:z6Mk-carried-demand-test-bob";

/** A pair of `principal` that demands in `SPACE` through `sessionId`. */
const pair = (principal: string, sessionId: string): CarriedPair => ({
  principal,
  sessionId: sessionId as CarriedPair["sessionId"],
  origin: { space: SPACE, sessionId },
});

/** The key of `principal`'s slice, or of one session's where one is named. */
const sliceOf = (principal: string, sessionId?: string): string =>
  sessionId === undefined
    ? resolveScopeKey("user", { principal })
    : resolveScopeKey("session", {
      principal,
      sessionId: sessionId as CarriedPair["sessionId"],
    });

/** A read of the shared instance of `id` in `SOURCE`, made in `slice`. */
const shared = (id: string, slice = "space"): ForeignRead => ({
  slice,
  space: SOURCE,
  id,
  scopeKey: "space",
});

/** The rows `carried` holds for `source`, as `id for session` strings. */
const rowsFor = (
  carried: ReturnType<typeof carriedRowsOf>,
  source = SOURCE,
): string[] =>
  [...carried.get(source)?.values() ?? []].map((row) =>
    `${row.id} at ${row.scopeKey} for ${row.origin.sessionId}`
  ).sort();

describe("carried-demand", () => {
  const pairs = [
    pair(ALICE, "alice-one"),
    pair(ALICE, "alice-two"),
    pair(BOB, "bob-one"),
  ];

  describe("carriedRowsOf()", () => {
    it("carries a read made in the `space` slice for every pair", () => {
      expect(rowsFor(carriedRowsOf([shared("of:far")], pairs))).toEqual([
        "of:far at space for alice-one",
        "of:far at space for alice-two",
        "of:far at space for bob-one",
      ]);
    });

    it("carries a read made in a user's slice for that user's pairs", () => {
      expect(
        rowsFor(carriedRowsOf([shared("of:far", sliceOf(ALICE))], pairs)),
      ).toEqual([
        "of:far at space for alice-one",
        "of:far at space for alice-two",
      ]);
    });

    it("carries a read made in a session's slice for that one pair", () => {
      expect(
        rowsFor(
          carriedRowsOf(
            [shared("of:far", sliceOf(ALICE, "alice-two"))],
            pairs,
          ),
        ),
      ).toEqual(["of:far at space for alice-two"]);
    });

    it("carries each user's own instance of one document for that user's pairs and no other's", () => {
      const reads = [ALICE, BOB].map((principal): ForeignRead => ({
        slice: sliceOf(principal),
        space: SOURCE,
        id: "of:prefs",
        scopeKey: sliceOf(principal),
      }));

      expect(rowsFor(carriedRowsOf(reads, pairs))).toEqual([
        `of:prefs at ${sliceOf(ALICE)} for alice-one`,
        `of:prefs at ${sliceOf(ALICE)} for alice-two`,
        `of:prefs at ${sliceOf(BOB)} for bob-one`,
      ]);
    });

    it("carries no pair a user's own instance that a run in the `space` slice read", () => {
      const read: ForeignRead = {
        slice: "space",
        space: SOURCE,
        id: "of:prefs",
        scopeKey: sliceOf(ALICE),
      };

      expect(rowsFor(carriedRowsOf([read], [pair(BOB, "bob-one")]))).toEqual(
        [],
      );
    });

    it("carries the reads made in the `space` slice, and no other, for a demand that has no pair", () => {
      const origin = { space: OTHER, sessionId: "alice-elsewhere" };
      const carried = carriedRowsOf(
        [shared("of:far"), shared("of:near", sliceOf(ALICE))],
        [{ origin }],
      );

      expect(rowsFor(carried)).toEqual([
        "of:far at space for alice-elsewhere",
      ]);
    });

    it("names the row's scope after its scope key", () => {
      const [row] = carriedRowsOf([{
        slice: sliceOf(ALICE),
        space: SOURCE,
        id: "of:prefs",
        scopeKey: sliceOf(ALICE),
      }], [pair(ALICE, "alice-one")]).get(SOURCE)!.values();

      expect(row).toEqual({
        id: "of:prefs",
        scope: "user",
        scopeKey: sliceOf(ALICE),
        origin: { space: SPACE, sessionId: "alice-one" },
      });
    });

    it("carries a pair that reached the space carried with the origin it came with", () => {
      const origin = { space: OTHER, sessionId: "alice-elsewhere" };
      const carried = carriedRowsOf([shared("of:far")], [{
        ...pair(ALICE, "alice-elsewhere"),
        origin,
      }]);

      expect([...carried.get(SOURCE)!.values()].map((row) => row.origin))
        .toEqual([origin]);
    });

    it("holds the rows of each space that was read apart", () => {
      const carried = carriedRowsOf(
        [shared("of:far"), { ...shared("of:near"), space: OTHER }],
        [pair(ALICE, "alice-one")],
      );

      expect(rowsFor(carried)).toEqual(["of:far at space for alice-one"]);
      expect(rowsFor(carried, OTHER)).toEqual([
        "of:near at space for alice-one",
      ]);
    });

    it("returns no space for reads that no pair demands", () => {
      expect(carriedRowsOf([shared("of:far")], []).size).toBe(0);
    });
  });

  describe("CarriedDemand", () => {
    let stats: ServingLoopStats;

    /** What the server was sent, in order. */
    let sent: Array<{ source: string; reader: string; rows: string[] }>;

    /** What the next request rejects with, once. */
    let failure: Error | undefined;

    /** How many rows of each request the server refuses. */
    let refuses: number;

    let carried: CarriedDemand;

    beforeEach(() => {
      stats = emptyServingLoopStats();
      sent = [];
      failure = undefined;
      refuses = 0;
      carried = new CarriedDemand({
        space: SPACE,
        serviceIdentity: SERVICE,
        stats,
        server: {
          setCarriedDemand: (source, reader, rows, options) => {
            expect(options).toEqual({ excludePrincipal: SERVICE });
            if (failure !== undefined) {
              const thrown = failure;
              failure = undefined;
              return Promise.reject(thrown);
            }
            sent.push({
              source,
              reader,
              rows: rows.map((row: CarriedDemandRow) => row.id),
            });
            return Promise.resolve({ refused: refuses });
          },
        },
      });
    });

    /** The rows a read of each of `ids` in `SOURCE` carries for alice. */
    const rowsOf = (...ids: string[]) =>
      carriedRowsOf(
        ids.map((id) => shared(id)),
        [pair(ALICE, "alice-one")],
      );

    describe("instance members", () => {
      describe("send()", () => {
        it("sends each space its rows, as carried by the loop's space", async () => {
          carried.send(rowsOf("of:far", "of:near"));
          await carried.settled;

          expect(sent).toEqual([{
            source: SOURCE,
            reader: SPACE,
            rows: ["of:far", "of:near"],
          }]);
        });

        it("sends nothing to a space whose rows are the ones it was last sent", async () => {
          carried.send(rowsOf("of:far"));
          carried.send(rowsOf("of:far"));
          await carried.settled;

          expect(sent).toHaveLength(1);
        });

        it("sends an empty set to a space that has no rows any longer", async () => {
          carried.send(rowsOf("of:far"));
          carried.send(new Map());
          await carried.settled;

          expect(sent.map(({ rows }) => rows)).toEqual([["of:far"], []]);
          expect(carried.carries).toBe(false);
        });

        it("counts the rows the spaces hold, and the rows a space refused", async () => {
          refuses = 1;
          carried.send(rowsOf("of:far", "of:near"));
          carried.send(rowsOf("of:far"));
          await carried.settled;

          expect(stats.currency.carried).toBe(1);
          expect(stats.currency.carriedRefused).toBe(2);
        });

        it("sends a set again that the space did not take", async () => {
          failure = new Error("not taken");
          carried.send(rowsOf("of:far"));
          await carried.settled;
          expect(carried.retryOwed).toBe(true);

          carried.send(rowsOf("of:far"));
          await carried.settled;

          expect(sent.map(({ rows }) => rows)).toEqual([["of:far"]]);
          expect(carried.retryOwed).toBe(false);
        });

        it("sends an empty set again that the space did not take", async () => {
          carried.send(rowsOf("of:far"));
          await carried.settled;
          failure = new Error("not taken");
          carried.send(new Map());
          await carried.settled;

          carried.send(new Map());
          await carried.settled;

          expect(sent.map(({ rows }) => rows)).toEqual([["of:far"], []]);
        });
      });

      describe("withdraw()", () => {
        it("sends every space it carried into an empty set, and counts nothing as carried", async () => {
          carried.send(
            carriedRowsOf(
              [shared("of:far"), { ...shared("of:near"), space: OTHER }],
              [pair(ALICE, "alice-one")],
            ),
          );

          carried.withdraw();
          await carried.settled;

          expect(sent.slice(2)).toEqual([
            { source: SOURCE, reader: SPACE, rows: [] },
            { source: OTHER, reader: SPACE, rows: [] },
          ]);
          expect(stats.currency.carried).toBe(0);
        });
      });
    });
  });
});
