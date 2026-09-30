import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createNodeFactory } from "../src/builder/module.ts";
import { pattern } from "../src/builder/pattern.ts";
import { Runtime } from "../src/runtime.ts";
import { RuntimeTelemetryEvent } from "../src/telemetry.ts";
import {
  type AggregateWorkload,
  createAggregateFixture,
} from "./aggregate-fixture.ts";

const signer = await Identity.fromPassphrase("aggregate");
const space = signer.did();

describe("aggregate", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await storageManager.synced();
    await runtime.dispose();
    await storageManager.close();
  });

  it("requires transformation for raw predicate and score callbacks", () => {
    const items = runtime.getCell<number[]>(space, "raw callbacks");
    expect(() => items.count((value) => value > 0)).toThrow("count");
    expect(() => items.minBy((value) => value)).toThrow("minBy");
    expect(() => items.maxBy((value) => value)).toThrow("maxBy");
  });

  it("updates a sum through its tree and reconciles changed membership", async () => {
    const aggregate = createNodeFactory({
      type: "ref",
      implementation: "aggregate",
    });
    const compiled = pattern<{ list: number[] }>(
      ({ list }) => ({ value: aggregate({ list, operation: "sum" }) }),
      {
        type: "object",
        properties: { list: { type: "array", items: { type: "number" } } },
      },
      { type: "object", properties: { value: { type: "number" } } },
    );
    const tx = runtime.edit();
    const list = runtime.getCell<number[]>(space, "source", undefined, tx);
    list.set([1, 2, 3, 4]);
    const output = runtime.getCell<{ value: number }>(
      space,
      "output",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(tx, compiled, { list }, output);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      expect(await result.key("value").pull()).toBe(10);
      const edit = runtime.edit();
      list.withTx(edit).key(1).set(12);
      await edit.commit();
      await runtime.idle();
      expect(await result.key("value").pull()).toBe(20);
      const replace = runtime.edit();
      list.withTx(replace).set([10, 20]);
      await replace.commit();
      await runtime.idle();
      expect(await result.key("value").pull()).toBe(30);
      const clear = runtime.edit();
      list.asSchema(true).withTx(clear).set(undefined);
      await clear.commit();
      await runtime.idle();
      expect(await result.key("value").pull()).toBeUndefined();
      const restore = runtime.edit();
      list.withTx(restore).set([7, 8]);
      await restore.commit();
      await runtime.idle();
      expect(await result.key("value").pull()).toBe(15);
    } finally {
      cancel();
    }
  });
  it("publishes nothing over a linked value that has not arrived", async () => {
    // A leaf reads each element's value through its link. A document nothing
    // has written yet reads as undefined, and the leaf then leaves the sum
    // unpublished rather than counting the absence as a number; the value
    // arriving re-runs the leaf. More than 32 entries also requires a parent
    // combine node, which must wait for the incomplete child's state.
    const aggregate = createNodeFactory({
      type: "ref",
      implementation: "aggregate",
    });
    const compiled = pattern<{ list: number[] }>(
      ({ list }) => ({ value: aggregate({ list, operation: "sum" }) }),
      {
        type: "object",
        properties: { list: { type: "array", items: { type: "number" } } },
      },
      { type: "object", properties: { value: { type: "number" } } },
    );
    const tx = runtime.edit();
    const present = runtime.getCell<number>(
      space,
      "present value",
      undefined,
      tx,
    );
    present.set(5);
    const absent = runtime.getCell<number>(
      space,
      "absent value",
      undefined,
      tx,
    );
    const list = runtime.getCell<number[]>(
      space,
      "list with an absent value",
      undefined,
      tx,
    );
    list.set([...Array.from({ length: 32 }, () => present), absent]);
    const output = runtime.getCell<{ value: number }>(
      space,
      "output over an absent value",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(tx, compiled, { list }, output);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      expect(await result.key("value").pull()).toBeUndefined();
      const arrive = runtime.edit();
      absent.withTx(arrive).set(7);
      await arrive.commit();
      await runtime.idle();
      expect(await result.key("value").pull()).toBe(167);
    } finally {
      cancel();
    }
  });

  it("compiles all named aggregates and updates predicate and score dependencies", async () => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
        import { pattern, Writable } from "commonfabric";
        export default pattern<{items: Writable<{name: string; n: number}[]>; threshold: number; numbers: Writable<number[]>}>(({items, threshold, numbers}) => {

          return {
            count: items.count(),
            positive: items.count(item => item.n > threshold),
            sum: numbers.sum(), min: numbers.min(), max: numbers.max(),
            minimum: items.minBy(item => item.n), maximum: items.maxBy(item => item.n),
          };
        });
      `,
      }],
    });
    const tx = runtime.edit();
    const items = runtime.getCell<{ name: string; n: number }[]>(
      space,
      "items",
      undefined,
      tx,
    );
    items.set([{ name: "a", n: 1 }, { name: "b", n: 2 }, { name: "c", n: 3 }]);
    const threshold = runtime.getCell<number>(
      space,
      "threshold",
      undefined,
      tx,
    );
    threshold.set(1);
    const output = runtime.getCell<Record<string, unknown>>(
      space,
      "all",
      compiled.resultSchema,
      tx,
    );
    const numbers = runtime.getCell<number[]>(space, "numbers", undefined, tx);
    numbers.set([1, 2, 3]);
    const result = runtime.run(
      tx,
      compiled,
      { items, threshold, numbers },
      output,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      expect(await result.pull()).toEqual({
        count: 3,
        positive: 2,
        sum: 6,
        min: 1,
        max: 3,
        minimum: { name: "a", n: 1 },
        maximum: { name: "c", n: 3 },
      });
      const edit = runtime.edit();
      items.withTx(edit).key(0, "n").set(10);
      numbers.withTx(edit).key(0).set(10);
      threshold.withTx(edit).set(2);
      await edit.commit();
      await runtime.idle();
      expect(await result.pull()).toEqual({
        count: 3,
        positive: 2,
        sum: 15,
        min: 2,
        max: 10,
        minimum: { name: "b", n: 2 },
        maximum: { name: "a", n: 10 },
      });
    } finally {
      cancel();
    }
  });

  it("lowers callback aggregates on explicit cells inside computed", async () => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
        import { pattern, Writable, computed } from "commonfabric";
        export default pattern<{items: Writable<{n: number}[]>}>(({items}) => ({
          count: computed(() => items.count(item => item.n > 0)),
          minimum: computed(() => items.minBy(item => item.n)),
          maximum: computed(() => items.maxBy(item => item.n)),
        }));
      `,
      }],
    });
    const tx = runtime.edit();
    const items = runtime.getCell<{ n: number }[]>(
      space,
      "items",
      undefined,
      tx,
    );
    items.set([{ n: 1 }, { n: 2 }, { n: -1 }]);
    const output = runtime.getCell<Record<string, unknown>>(
      space,
      "computed",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(tx, compiled, { items }, output);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      expect(await result.pull()).toEqual({
        count: 2,
        minimum: { n: -1 },
        maximum: { n: 2 },
      });
      const edit = runtime.edit();
      items.withTx(edit).key(2, "n").set(10);
      await edit.commit();
      await runtime.idle();
      expect(await result.pull()).toEqual({
        count: 3,
        minimum: { n: 1 },
        maximum: { n: 10 },
      });
    } finally {
      cancel();
    }
  });

  it("produces the same exact sum across membership and edit histories", async () => {
    const aggregate = createNodeFactory({
      type: "ref",
      implementation: "aggregate",
    });
    const compiled = pattern<{ a: number[]; b: number[] }>(
      ({ a, b }) => ({
        a: aggregate({ list: a, operation: "sum" }),
        b: aggregate({ list: b, operation: "sum" }),
      }),
      {
        type: "object",
        properties: {
          a: { type: "array", items: { type: "number" } },
          b: { type: "array", items: { type: "number" } },
        },
      },
      {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
    );
    const tx = runtime.edit();
    const a = runtime.getCell<number[]>(space, "a", undefined, tx);
    const b = runtime.getCell<number[]>(space, "b", undefined, tx);
    const values = Array.from({ length: 65 }, (_, index) => {
      const value = runtime.getCell<number>(
        space,
        { value: index },
        undefined,
        tx,
      );
      value.set(index === 0 ? 1e16 : index === 1 ? 1 : index === 2 ? -1e16 : 0);
      return value;
    });
    a.set(values);
    b.set([]);
    const result = runtime.run(
      tx,
      compiled,
      { a, b },
      runtime.getCell<{ a: number; b: number }>(
        space,
        "histories",
        compiled.resultSchema,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      expect(await result.key("a").pull()).toBe(1);
      expect(await result.key("b").pull()).toBe(0);
      for (
        const membership of [
          values.slice(0, 2),
          values.slice(0, 33),
          [...values].reverse(),
          values.slice(0, 32),
          values,
        ]
      ) {
        const edit = runtime.edit();
        b.withTx(edit).set(membership);
        await edit.commit();
        await runtime.idle();
      }
      expect(await result.pull()).toEqual({ a: 1, b: 1 });
      for (
        const intermediate of [Infinity, NaN, -Infinity, Number.MAX_VALUE, 1]
      ) {
        const edit = runtime.edit();
        values[1].withTx(edit).set(intermediate);
        await edit.commit();
        await runtime.idle();
      }
      expect(await result.pull()).toEqual({ a: 1, b: 1 });
    } finally {
      cancel();
    }
  });

  it("preserves extrema identities through ties, reorders, and empty transitions", async () => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
      import {pattern, Writable} from "commonfabric";
      export default pattern<{items: Writable<{name: string; n: number}[]>; numbers: Writable<number[]>}>(({items, numbers}) => ({
        count: items.count(), min: numbers.min(), max: numbers.max(), sum: numbers.sum(),
        minimum: items.minBy(item => item.n), maximum: items.maxBy(item => item.n)
      }));
    `,
      }],
    });
    const tx = runtime.edit();
    const rows = ["a", "b"].map((name) => {
      const cell = runtime.getCell<{ name: string; n: number }>(
        space,
        { row: name },
        undefined,
        tx,
      );
      cell.set({ name, n: 5 });
      return cell;
    });
    const items = runtime.getCell<{ name: string; n: number }[]>(
      space,
      "items",
      undefined,
      tx,
    );
    const numbers = runtime.getCell<number[]>(space, "numbers", undefined, tx);
    items.set(rows);
    numbers.set([0, -0]);
    const result = runtime.run(
      tx,
      compiled,
      { items, numbers },
      runtime.getCell<Record<string, unknown>>(
        space,
        "extrema",
        compiled.resultSchema,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    const cancel = result.sink(() => {});
    try {
      await runtime.idle();
      const winner = await result.key("minimum", "name")
        .asSchema<string>({ type: "string" }).pull();
      expect(["a", "b"]).toContain(winner);
      expect(await result.key("maximum", "name").pull()).toBe(winner);
      expect(Object.is(await result.key("min").pull(), -0)).toBe(true);
      expect(Object.is(await result.key("max").pull(), 0)).toBe(true);
      const reorder = runtime.edit();
      items.withTx(reorder).set([...rows].reverse());
      await reorder.commit();
      await runtime.idle();
      expect(await result.key("minimum", "name").pull()).toBe(winner);
      expect(await result.key("maximum", "name").pull()).toBe(winner);
      const rename = runtime.edit();
      rows[winner === "a" ? 0 : 1].withTx(rename).key("name").set("renamed");
      await rename.commit();
      await runtime.idle();
      expect(await result.key("minimum", "name").pull()).toBe("renamed");
      const nanScore = runtime.edit();
      rows[0].withTx(nanScore).key("n").set(NaN);
      rows[1].withTx(nanScore).key("n").set(Infinity);
      await nanScore.commit();
      await runtime.idle();
      expect(await result.key("minimum", "n").pull()).toBeNaN();
      expect(await result.key("maximum", "n").pull()).toBeNaN();
      const tiedScores = runtime.edit();
      rows[1].withTx(tiedScores).key("n").set(NaN);
      await tiedScores.commit();
      await runtime.idle();
      expect(await result.key("minimum", "name").pull()).toBe("renamed");
      expect(await result.key("maximum", "name").pull()).toBe("renamed");
      const nonfinite = runtime.edit();
      numbers.withTx(nonfinite).set([Infinity, -Infinity, NaN]);
      await nonfinite.commit();
      await runtime.idle();
      for (const key of ["sum", "min", "max"]) {
        expect(await result.key(key).pull()).toBeNaN();
      }
      const sparse = runtime.edit();
      const sparseNumbers = new Array<number>(5);
      sparseNumbers[1] = 4;
      sparseNumbers[3] = -2;
      numbers.withTx(sparse).set(sparseNumbers);
      await sparse.commit();
      await runtime.idle();
      expect(await result.key("sum").pull()).toBe(2);
      expect(await result.key("min").pull()).toBe(-2);
      expect(await result.key("max").pull()).toBe(4);
      const empty = runtime.edit();
      items.withTx(empty).set([]);
      numbers.withTx(empty).set([]);
      await empty.commit();
      await runtime.idle();
      expect(await result.key("count").pull()).toBe(0);
      expect(await result.key("sum").pull()).toBe(0);
      expect(await result.key("min").pull()).toBe(Infinity);
      expect(await result.key("max").pull()).toBe(-Infinity);
      expect(await result.key("minimum").pull()).toBeUndefined();
      expect(await result.key("maximum").pull()).toBeUndefined();
    } finally {
      cancel();
    }
  });

  for (
    const operation of [
      "count",
      "sum",
      "min",
      "max",
      "minBy",
      "maxBy",
    ] satisfies AggregateWorkload[]
  ) {
    it(`updates ${operation} without rescanning 1000 linked rows`, async () => {
      const fixture = await createAggregateFixture(operation, 1000, false);
      try {
        fixture.runtime.scheduler.setReadStatsEnabled(true);
        let accesses = 0;
        let links = 0;
        fixture.runtime.telemetry.addEventListener("telemetry", (event) => {
          const marker = (event as RuntimeTelemetryEvent).marker;
          if (marker.type === "scheduler.run.complete") {
            accesses += marker.reads?.proxyAccesses ?? 0;
            links += marker.reads?.linkResolutions ?? 0;
          }
        });
        for (let edit = 0; edit < 2; edit++) {
          accesses = 0;
          links = 0;
          await fixture.update();
          expect(accesses).toBeLessThan(250);
          expect(links).toBeLessThan(500);
        }
      } finally {
        await fixture.dispose();
      }
    });
  }

  for (const generic of [false, true]) {
    for (const size of [10, 100, 1000]) {
      it(`updates ${generic ? "reduce" : "tree"} with ${size} independently linked values`, async () => {
        const aggregate = createNodeFactory({
          type: "ref",
          implementation: "aggregate",
        });
        const compiled = generic
          ? await runtime.patternManager.compilePattern({
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: `
          import { pattern, computed } from "commonfabric";
          export default pattern<{list: number[]}>(({list}) => ({
            value: computed(() => list.reduce((sum, value) => sum + value, 0))
          }));
        `,
            }],
          })
          : pattern<{ list: number[] }>(
            ({ list }) => ({ value: aggregate({ list, operation: "sum" }) }),
            {
              type: "object",
              properties: {
                list: { type: "array", items: { type: "number" } },
              },
            },
            { type: "object", properties: { value: { type: "number" } } },
          );
        const tx = runtime.edit();
        const values = Array.from({ length: size }, (_, index) => {
          const cell = runtime.getCell<number>(
            space,
            { value: index },
            undefined,
            tx,
          );
          cell.set(index);
          return cell;
        });
        const list = runtime.getCell<number[]>(space, "source", undefined, tx);
        list.set(values);
        const output = runtime.getCell<{ value: number }>(
          space,
          "output",
          compiled.resultSchema,
          tx,
        );
        const result = runtime.run(tx, compiled, { list }, output);
        runtime.prepareTxForCommit(tx);
        await tx.commit();
        const cancel = result.sink(() => {});
        try {
          await runtime.idle();
          expect(await result.key("value").pull()).toBe(size * (size - 1) / 2);
          let accesses = 0;
          runtime.scheduler.setReadStatsEnabled(true);
          runtime.telemetry.addEventListener("telemetry", (event) => {
            const marker = (event as RuntimeTelemetryEvent).marker;
            if (marker.type === "scheduler.run.complete") {
              accesses += marker.reads?.proxyAccesses ?? 0;
            }
          });
          const edit = runtime.edit();
          values[0].withTx(edit).set(100);
          await edit.commit();
          await runtime.idle();
          expect(await result.key("value").pull()).toBe(
            size * (size - 1) / 2 + 100,
          );
          if (generic) expect(accesses).toBeGreaterThanOrEqual(size);
          else {
            expect(accesses).toBeLessThanOrEqual(
              12 * Math.ceil(Math.log2(size)) + 10,
            );
          }
        } finally {
          cancel();
        }
      });
    }
  }
});
