import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  artifactsOf,
  CASES,
  change,
  measure,
  OPERATIONS,
  start,
} from "../../compare/parts-growth.ts";
import {
  artifacts as rowArtifacts,
  CASES as ROW_CASES,
  keystrokes,
  polled,
} from "../../compare/rekey-cost.ts";
import { DOCUMENT_MAX_BYTES } from "../parts.ts";

// The executor with its documents laid out in part documents
// (provisional decision P20), on `fixtures/lists.tsx`: a `map` over an
// array of references, over an array of plain values in place with no
// declared key, the same with `ArrayByKey`, and over the result of a
// `filter` of plain values in place. Nothing here is over a plain array
// generated from scratch or over a `flatMap`.
describe("the executor's documents in part documents (P20)", () => {
  for (const wide of [false, true]) {
    const rows = wide ? "2,000 bytes" : "23 bytes";
    for (const one of CASES) {
      it(`reads from the part documents what each document holds after each change: ${one.name}, rows of ${rows}`, async () => {
        const patterns = await artifactsOf();
        const artifact = patterns.find(({ name }) => name === one.pattern)!;
        const length = wide ? 300 : 4_000;
        const instance = start(artifact, one, length, wide);
        const parts = instance.store.parts!;
        expect(parts.size).toBeGreaterThan(instance.store.docs.size);
        let turn = 0;
        for (const operation of [...OPERATIONS, ...OPERATIONS]) {
          change(instance, one, operation, length, wide, turn++);
          for (const [id, { value }] of instance.store.docs) {
            expect(parts.materialize(id)).toEqual(value);
          }
        }
      });

      it(`writes documents of a bounded size for one change, at any length: ${one.name}, rows of ${rows}`, async () => {
        const patterns = await artifactsOf();
        const artifact = patterns.find(({ name }) => name === one.pattern)!;
        const [short, long] = wide ? [200, 2_000] : [1_000, 10_000];
        for (const length of [short, long]) {
          for (const row of measure(artifact, one, length, wide)) {
            // The argument and the result: for each a holder, a chunk and
            // a part, and two more chunks where one splits.
            expect(row.bytes).toBeLessThanOrEqual(6 * DOCUMENT_MAX_BYTES);
            expect(row.documents).toBeLessThanOrEqual(10);
            expect(row.readOne).toBeLessThanOrEqual(4);
            expect(row.readTwenty).toBeLessThanOrEqual(24);
          }
        }
      });
    }
  }
});

// `fixtures/rows-state.tsx` through part documents: each row has a state
// cell, a handler binding, a `lift` and an instance called through
// `asInstance()`, over an array of plain values in place with no
// declared key, the same with `ArrayByKey`, and over an array of
// references.
describe("a row that has state, in part documents (P20)", () => {
  it("writes part documents of a bounded size for one keystroke, at any number of rows", async () => {
    const patterns = await rowArtifacts();
    for (const one of ROW_CASES) {
      const [few, many] = [
        keystrokes(patterns, one, 100),
        keystrokes(patterns, one, 3_000),
      ];
      expect(many.partedBytes).toBeLessThanOrEqual(4 * DOCUMENT_MAX_BYTES);
      expect(many.partedDocuments).toBeLessThanOrEqual(
        few.partedDocuments + 2,
      );
    }
  });

  it("keeps the part documents of every value that a list with no declared key ever held", async () => {
    const patterns = await rowArtifacts();
    const [unkeyed, keyed] = ROW_CASES;
    const [first, last] = polled(patterns, unkeyed, 10, 5, [0, 5]);
    expect(last.partDocuments - first.partDocuments).toBe(100);
    const [before, after] = polled(patterns, keyed, 10, 5, [0, 5]);
    expect(after.partDocuments).toBe(before.partDocuments);
  });
});
