import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ProblematicValue,
  UnknownValue,
} from "@commonfabric/data-model/codec-common";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricHash,
  FabricRegExp,
} from "@commonfabric/data-model/fabric-primitives";
import type { EntityDocument } from "@commonfabric/memory/v2";
import { approximateJsonSize } from "@commonfabric/utils/approximate-json-size";
import {
  DocumentSizeEstimate,
  type MeasurableSpace,
  type MeasureBudget,
  measureDocumentSizes,
  type SpaceDocumentSizes,
} from "../../src/storage/document-sizes.ts";

const document = (text: string): EntityDocument => ({ value: { text } });

/**
 * A space of `documents` documents, each of `nodesEach` nodes, measured the
 * way a replica measures its own: whole documents while the budget lasts,
 * and the budgets it was handed recorded.
 */
function spaceOf(
  space: string,
  documents: number,
  nodesEach: number,
): MeasurableSpace & { budgets: number[] } {
  const budgets: number[] = [];
  let measured = 0;
  return {
    budgets,
    getDocumentSizes(budget: MeasureBudget): SpaceDocumentSizes {
      budgets.push(budget.remaining);
      while (measured < documents && budget.remaining > 0) {
        budget.remaining -= nodesEach;
        measured++;
      }
      return {
        space: space as SpaceDocumentSizes["space"],
        documents,
        watched: 0,
        measuredDocuments: measured,
        truncatedDocuments: 0,
        approxBytes: measured * nodesEach * 10,
      };
    },
  };
}

describe("document-sizes", () => {
  describe("measureDocumentSizes()", () => {
    it("gives every space a share first, so each reports a sample of its own", () => {
      const first = spaceOf("first", 100, 10);
      const second = spaceOf("second", 100, 10);

      const sizes = measureDocumentSizes([first, second], 100);

      expect(first.budgets[0]).toBe(50);
      expect(second.budgets[0]).toBe(50);
      expect(sizes.map((entry) => entry.measuredDocuments)).toEqual([5, 5]);
    });

    it("gives the division's remainder to the first spaces, so the shares add up to the budget", () => {
      const spaces = [
        spaceOf("a", 100, 1),
        spaceOf("b", 100, 1),
        spaceOf("c", 100, 1),
      ];

      measureDocumentSizes(spaces, 100);

      expect(spaces.map((space) => space.budgets[0])).toEqual([34, 33, 33]);
    });

    it("hands the pooled budget to a space whose documents were only truncated, so they complete", () => {
      // Two real estimates behind the spaces: the second space's one document
      // takes 62 nodes, more than its 50-node share, and completes from the
      // pooled budget on the read after the one that cut it short.
      const small = new DocumentSizeEstimate();
      const large = new DocumentSizeEstimate();
      const whole: EntityDocument = {
        value: Array.from({ length: 60 }, () => 0),
      };
      const spaces: MeasurableSpace[] = [
        {
          getDocumentSizes: (budget) => ({
            space: "small" as SpaceDocumentSizes["space"],
            watched: 0,
            ...small.measure([{ value: 1 }], budget),
          }),
        },
        {
          getDocumentSizes: (budget) => ({
            space: "large" as SpaceDocumentSizes["space"],
            watched: 0,
            ...large.measure([whole], budget),
          }),
        },
      ];

      const first = measureDocumentSizes(spaces, 100);
      const second = measureDocumentSizes(spaces, 100);

      expect(first[1]).toMatchObject({
        measuredDocuments: 0,
        truncatedDocuments: 1,
      });
      expect(second[1]).toMatchObject({
        measuredDocuments: 1,
        truncatedDocuments: 0,
        approxBytes: approximateJsonSize(whole).bytes,
      });
    });

    it("hands what the shares leave unspent to the spaces still unmeasured, in order", () => {
      const small = spaceOf("small", 1, 10);
      const large = spaceOf("large", 100, 10);

      const sizes = measureDocumentSizes([small, large], 100);

      // The small space spent 10 of its 50; the large one got its own 50
      // and then the 40 left over.
      expect(large.budgets).toEqual([50, 40]);
      expect(sizes.map((entry) => entry.measuredDocuments)).toEqual([1, 9]);
    });

    it("leaves a space alone once every document is measured or held as a bound", () => {
      const done = spaceOf("done", 2, 10);

      measureDocumentSizes([done], 100);

      expect(done.budgets).toEqual([100]);
    });

    it("returns nothing for no spaces", () => {
      expect(measureDocumentSizes([], 100)).toEqual([]);
    });
  });
});

describe("DocumentSizeEstimate", () => {
  describe("instance members", () => {
    describe("measure()", () => {
      it("measures every value while the budget lasts, and reports them all measured", () => {
        const estimate = new DocumentSizeEstimate();
        const values = [document("a"), document("bb"), undefined];
        const budget = { remaining: 1_000 };

        expect(estimate.measure(values, budget)).toEqual({
          documents: 3,
          measuredDocuments: 3,
          truncatedDocuments: 0,
          approxBytes: approximateJsonSize(values[0]).bytes +
            approximateJsonSize(values[1]).bytes,
        });
      });

      it("counts a stored byte payload by its bytes", () => {
        const estimate = new DocumentSizeEstimate();
        const value: EntityDocument = {
          value: { payload: new FabricBytes(new Uint8Array(1_000_000)) },
        };

        const measured = estimate.measure([value], { remaining: 1_000 });

        expect(measured.measuredDocuments).toBe(1);
        expect(measured.approxBytes).toBeGreaterThanOrEqual(1_000_000);
      });

      it("counts a stored instance by the size of its realm encoding", () => {
        const estimate = new DocumentSizeEstimate();
        const value: EntityDocument = {
          value: {
            failure: new FabricError({
              type: "Error",
              message: "x".repeat(1_000_000),
              stack: undefined,
              cause: undefined,
            }),
          },
        };

        const measured = estimate.measure([value], { remaining: 1_000 });

        expect(measured.measuredDocuments).toBe(1);
        expect(measured.approxBytes).toBeGreaterThanOrEqual(1_000_000);
      });

      it("walks a stored instance's state within the budget, so a large payload inside one is cut short like any other", () => {
        const estimate = new DocumentSizeEstimate();
        const value: EntityDocument = {
          value: {
            payload: new FabricError({
              type: "Error",
              message: "large cause",
              stack: undefined,
              cause: Array.from({ length: 50_000 }, () => 0),
            }),
          },
        };
        const budget = { remaining: 1_000 };

        const measured = estimate.measure([value], budget);

        expect(budget.remaining).toBe(0);
        expect(measured).toMatchObject({
          measuredDocuments: 0,
          truncatedDocuments: 1,
        });
      });

      it("counts any Fabric class by the state its codec hands over, a preserved unknown value and a regular expression's source among them", () => {
        const estimate = new DocumentSizeEstimate();
        const payloads: EntityDocument[] = [
          { value: new UnknownValue("FutureType@1", "x".repeat(1_000_000)) },
          {
            value: new ProblematicValue(
              "FutureType@1",
              "x".repeat(1_000_000),
              "bad state",
            ),
          },
          { value: new FabricRegExp("es2025", "x".repeat(1_000_000), "") },
        ];

        for (const payload of payloads) {
          const measured = estimate.measure([payload], { remaining: 1_000 });
          expect(measured.measuredDocuments).toBe(1);
          expect(measured.approxBytes).toBeGreaterThanOrEqual(1_000_000);
        }
      });

      it("counts a hash by the state its codec hands over, more than the empty object it walks as", () => {
        const estimate = new DocumentSizeEstimate();
        const value: EntityDocument = {
          value: { hash: new FabricHash(new Uint8Array(32), "fid1") },
        };

        const measured = estimate.measure([value], { remaining: 1_000 });

        expect(measured.approxBytes).toBeGreaterThan(
          JSON.stringify({ value: { hash: {} } }).length + 32,
        );
      });

      it("consumes an error's extras only as far as the budget lets it, whatever the bag holds", () => {
        // The same budget stops at the same point in a bag ten times the
        // size, which is what says the bag is not copied ahead of the walk.
        const withExtras = (count: number): EntityDocument => ({
          value: {
            payload: new FabricError({
              type: "Error",
              message: "many extras",
              stack: undefined,
              cause: undefined,
              extras: Array.from(
                { length: count },
                (_, i) => [`key${i}`, 0] as [string, number],
              ),
            }),
          },
        });
        const small = { remaining: 1_000 };
        const large = { remaining: 1_000 };

        const fewer = new DocumentSizeEstimate().measure(
          [withExtras(10_000)],
          small,
        );
        const more = new DocumentSizeEstimate().measure(
          [withExtras(100_000)],
          large,
        );

        expect(small.remaining).toBe(0);
        expect(large.remaining).toBe(0);
        expect(fewer).toMatchObject({ truncatedDocuments: 1 });
        expect(more).toEqual(fewer);
      });

      it("stops inside a document the budget runs out in, holding its size as a lower bound", () => {
        const estimate = new DocumentSizeEstimate();
        const giant: EntityDocument = {
          value: Array.from({ length: 5_000 }, () => 0),
        };
        const budget = { remaining: 1_000 };

        const measured = estimate.measure([giant], budget);

        expect(budget.remaining).toBe(0);
        expect(measured).toMatchObject({
          documents: 1,
          measuredDocuments: 0,
          truncatedDocuments: 1,
        });
        expect(measured.approxBytes).toBeGreaterThan(0);
        expect(measured.approxBytes).toBeLessThan(
          approximateJsonSize(giant).bytes,
        );
      });

      it("measures a truncated document again once a read has more budget than the last walk spent", () => {
        const estimate = new DocumentSizeEstimate();
        const giant: EntityDocument = {
          value: Array.from({ length: 5_000 }, () => 0),
        };
        estimate.measure([giant], { remaining: 1_000 });

        const stillShort = estimate.measure([giant], { remaining: 1_000 });
        const enough = estimate.measure([giant], { remaining: 10_000 });

        expect(stillShort.truncatedDocuments).toBe(1);
        expect(enough).toEqual({
          documents: 1,
          measuredDocuments: 1,
          truncatedDocuments: 0,
          approxBytes: approximateJsonSize(giant).bytes,
        });
      });

      it("draws the budget down by the nodes it visits", () => {
        const estimate = new DocumentSizeEstimate();
        const value = document("a");
        const budget = { remaining: 1_000 };

        estimate.measure([value], budget);

        expect(budget.remaining).toBe(1_000 - approximateJsonSize(value).nodes);
      });

      it("leaves values unmeasured once the budget is spent, scaling the measured ones to all", () => {
        const estimate = new DocumentSizeEstimate();
        const values = [document("aa"), document("bb"), document("cc")];
        const each = approximateJsonSize(values[0]);

        const measured = estimate.measure(values, { remaining: each.nodes });

        expect(measured).toEqual({
          documents: 3,
          measuredDocuments: 1,
          truncatedDocuments: 0,
          approxBytes: each.bytes * 3,
        });
      });

      it("remembers a measured value, so a later read without budget still counts it", () => {
        const estimate = new DocumentSizeEstimate();
        const values = [document("aa"), document("bb")];
        estimate.measure(values, { remaining: 1_000 });

        const again = estimate.measure(values, { remaining: 0 });

        expect(again.measuredDocuments).toBe(2);
        expect(again.approxBytes).toBe(
          approximateJsonSize(values[0]).bytes * 2,
        );
      });

      it("measures a replaced value afresh", () => {
        const estimate = new DocumentSizeEstimate();
        estimate.measure([document("a")], { remaining: 1_000 });
        const replaced = document("a much longer text than before");

        const measured = estimate.measure([replaced], { remaining: 1_000 });

        expect(measured.approxBytes).toBe(approximateJsonSize(replaced).bytes);
      });

      it("returns zero bytes for values none of which the budget admitted", () => {
        const estimate = new DocumentSizeEstimate();

        expect(estimate.measure([document("a")], { remaining: 0 })).toEqual({
          documents: 1,
          measuredDocuments: 0,
          truncatedDocuments: 0,
          approxBytes: 0,
        });
      });
    });
  });
});
