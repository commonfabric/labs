/**
 * `approximateJsonSize()` stands in for the length of a value's JSON text
 * without producing it. The cases pin the two things a reader of the figure
 * relies on: that it tracks the JSON length where JSON would write the same
 * thing, and that the walk visits a tree of any depth and no byte buffer.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { approximateJsonSize } from "@commonfabric/utils/approximate-json-size";

describe("approximateJsonSize()", () => {
  it("returns the JSON length of a value holding strings, keywords and containers", () => {
    const value = {
      name: "donut",
      glazed: true,
      filling: null,
      toppings: ["sprinkles", "sugar"],
      nested: { empty: {}, none: [] },
    };
    expect(approximateJsonSize(value).bytes).toBe(
      JSON.stringify(value).length,
    );
  });

  it("counts a number as eight and a bigint as twenty, whatever they would write as", () => {
    expect(approximateJsonSize(1).bytes).toBe(8);
    expect(approximateJsonSize(123456789.25).bytes).toBe(8);
    expect(approximateJsonSize(7n).bytes).toBe(20);
  });

  it("counts `false` as five and `true` as four", () => {
    expect(approximateJsonSize([true, false]).bytes).toBe(
      JSON.stringify([true, false]).length,
    );
  });

  it("counts a string by its length in code units", () => {
    expect(approximateJsonSize("héllo").bytes).toBe("héllo".length + 2);
  });

  it("counts one node per container and per leaf", () => {
    expect(approximateJsonSize({ a: [1, 2], b: "x" }).nodes).toBe(5);
  });

  it("counts a byte buffer by its byte length without walking it", () => {
    expect(approximateJsonSize(new Uint8Array(10))).toEqual({
      bytes: 10,
      nodes: 1,
      complete: true,
    });
    expect(approximateJsonSize(new ArrayBuffer(7))).toEqual({
      bytes: 7,
      nodes: 1,
      complete: true,
    });
  });

  it("counts a sparse array's holes as JSON writes them, queuing none of them", () => {
    const sparse = new Array(100_000);
    sparse[99_999] = "end";

    expect(approximateJsonSize(sparse)).toEqual({
      bytes: JSON.stringify(sparse).length,
      nodes: 100_001,
      complete: true,
    });
  });

  it("takes an instance's size from the caller's hook when it gives one", () => {
    class Payload {
      #bytes = new Uint8Array(32);
      get length(): number {
        return this.#bytes.length;
      }
    }
    const instanceMeasure = (instance: object) =>
      instance instanceof Payload ? { bytes: instance.length } : undefined;

    expect(
      approximateJsonSize({ p: new Payload() }, { instanceMeasure }).bytes,
    ).toBe(2 + "p".length + 3 + 32);
    expect(approximateJsonSize({ p: new Payload() }).bytes)
      .toBe(JSON.stringify({ p: {} }).length);
  });

  it("walks the view the caller's hook gives of an instance, within the node limit", () => {
    class Holder {
      #state = { items: Array.from({ length: 1_000 }, () => "x") };
      get state(): unknown {
        return this.#state;
      }
    }
    const instanceMeasure = (instance: object) =>
      instance instanceof Holder ? { view: instance.state } : undefined;
    const held = { h: new Holder() };

    const whole = approximateJsonSize(held, { instanceMeasure });
    const partial = approximateJsonSize(held, {
      instanceMeasure,
      nodeLimit: 50,
    });

    expect(whole.bytes).toBe(
      JSON.stringify({ h: { items: Array(1_000).fill("x") } }).length,
    );
    expect(whole.complete).toBe(true);
    expect(partial).toMatchObject({ nodes: 50, complete: false });
  });

  it("stops before visiting an instance's view once the node limit is reached", () => {
    // Views that are empty reach no child-loop guard, so the guard has to
    // sit ahead of the view itself.
    class Empty {}
    const instanceMeasure = (instance: object) =>
      instance instanceof Empty ? { view: {} } : undefined;
    const queued = Array.from({ length: 98 }, () => new Empty());

    const partial = approximateJsonSize(queued, {
      instanceMeasure,
      nodeLimit: 100,
    });

    expect(partial.nodes).toBe(100);
    expect(partial.complete).toBe(false);
  });

  it("consumes an iterable only as far as the node limit lets it", () => {
    let pulled = 0;
    const endless = {
      *[Symbol.iterator]() {
        while (true) {
          pulled++;
          yield "item";
        }
      },
    };

    const partial = approximateJsonSize({ items: endless }, { nodeLimit: 10 });

    expect(partial.complete).toBe(false);
    expect(partial.nodes).toBe(10);
    expect(pulled).toBe(8);
  });

  it("walks a `Map` and a `Set` through their entries", () => {
    const value = {
      m: new Map([["k", "v"], ["key", "value"]]),
      s: new Set(["a", "bb"]),
    };

    expect(approximateJsonSize(value)).toEqual({
      bytes: JSON.stringify({
        m: [["k", "v"], ["key", "value"]],
        s: ["a", "bb"],
      }).length,
      nodes: 11,
      complete: true,
    });
  });

  it("walks a class instance through its own enumerable properties alone", () => {
    class Glaze {
      flavor = "maple";
      get thickness(): number {
        return 2;
      }
    }
    expect(approximateJsonSize(new Glaze()).bytes).toBe(
      JSON.stringify({ flavor: "maple" }).length,
    );
  });

  it("stops at the node limit and reports the walk incomplete", () => {
    const wide = { a: Array.from({ length: 1_000 }, () => "x"), b: { c: 1 } };

    const partial = approximateJsonSize(wide, { nodeLimit: 100 });
    const whole = approximateJsonSize(wide);

    expect(partial.complete).toBe(false);
    expect(partial.nodes).toBe(100);
    expect(partial.bytes).toBeLessThan(whole.bytes);
    expect(whole.complete).toBe(true);
    expect(approximateJsonSize(wide, { nodeLimit: whole.nodes })).toEqual(
      whole,
    );
  });

  it("walks a value deeper than a recursive walk could", () => {
    let value: unknown[] = [];
    for (let depth = 0; depth < 100_000; depth++) value = [value];
    expect(approximateJsonSize(value).nodes).toBe(100_001);
  });
});
