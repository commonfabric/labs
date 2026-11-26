import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { inlined, kinds, sizesOf, stored, widened } from "../cost.ts";
import type { CostPlan } from "../cost-model.ts";
import { median, phasesOf, quantile } from "../cost-report.ts";

const long = { confidentiality: [{ anyOf: ["a".repeat(150), "b"] }] };
const short = { confidentiality: ["a"] };
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

describe("stored", () => {
  it("counts the bytes of the value, of the meta fields, and of the envelope apart", () => {
    const cfc = { labelMap: { entries: [{ path: [], label: short }] } };
    const total = stored([
      { value: { a: 1 }, result: { "/": "x" }, cfc },
      { value: "é" },
    ]);
    expect(total.documents).toBe(2);
    expect(total.valueBytes).toBe(bytes({ a: 1 }) + 4);
    expect(total.metaBytes).toBe(bytes({ result: { "/": "x" } }));
    expect(total.envelopes).toBe(1);
    expect(total.labelEntries).toBe(1);
    expect(total.envelopeBytes).toBe(bytes(cfc));
  });

  it("keeps a label of at most 128 bytes in place", () => {
    const cfc = { labelMap: { entries: [{ path: [], label: short }] } };
    const total = stored([{ cfc }]);
    expect(total.envelopeBytesByReference).toBe(total.envelopeBytes);
    expect(total.labelDocuments).toBe(0);
  });

  it("counts a longer label as a reference of 63 bytes, and its text once for every entry that has it", () => {
    const cfc = {
      labelMap: {
        entries: [{ path: [], label: long }, { path: ["a"], label: long }],
      },
    };
    const total = stored([{ cfc }, { cfc }]);
    expect(total.labelEntries).toBe(4);
    expect(total.envelopeBytesByReference).toBe(
      total.envelopeBytes - 4 * (bytes(long) - 63),
    );
    expect(total.labelDocuments).toBe(1);
    expect(total.labelDocumentBytes).toBe(bytes(long));
  });
});

describe("kinds", () => {
  it("names a document by its identifier and its meta links", () => {
    const key = (id: string) => JSON.stringify([id, "space"]);
    const found = kinds(
      new Map([
        [key("of:r"), {
          value: {},
          argument: { "/": { "link@1": { id: "of:a", path: [] } } },
        }],
        [key("of:a"), { value: {}, result: {} }],
        [key("of:i"), { value: 1, result: {} }],
        [key("computed:c"), { value: 1 }],
        [key("cid:s"), { value: { type: "number" } }],
        [key("of:o"), { value: 1 }],
      ]),
    );
    expect([...found.values()]).toEqual([
      "result",
      "argument",
      "internal",
      "computed",
      "schema",
      "other",
    ]);
  });
});

describe("widened", () => {
  it("leaves a value that is no array, and an empty array", () => {
    expect(widened(3, 4)).toBe(3);
    expect(widened([], 4)).toEqual([]);
  });

  it("adds elements made from the ones the array has, each with strings of its own", () => {
    expect(widened([{ t: "x-0", n: 3 }, { t: "x-1", n: 3 }], 4)).toEqual([
      { t: "x-0", n: 3 },
      { t: "x-1", n: 3 },
      { t: "x-0-2", n: 3 },
      { t: "x-1-3", n: 3 },
    ]);
  });
});

describe("sizesOf", () => {
  const plan = {
    slots: [
      { root: { kind: "argument" }, path: ["rows"] },
      { root: { kind: "element", collection: 0 }, path: ["tags"] },
      { root: { kind: "state", cell: 0 }, path: [] },
    ],
    collections: [
      { construct: "map", source: { slot: 0 } },
      { construct: "map", source: { slot: 1 }, within: [{ element: 0 }] },
      { construct: "filter", source: { collection: 0 } },
      { construct: "map", source: { slot: 2 } },
      { construct: "map", source: { output: 0 } },
    ],
  } as unknown as CostPlan;
  const inputs = {
    rows: { value: [{ tags: ["a", "b", "c"] }, { tags: [] }] },
  };

  it("reads the length of an array of the argument and of the first element", () => {
    const { size } = sizesOf(plan, inputs, 7);
    expect(size(0)).toBe(2);
    expect(size(1)).toBe(3);
  });

  it("gives a derived collection the size of the one it is derived from", () => {
    expect(sizesOf(plan, inputs, 7).size(2)).toBe(2);
  });

  it("gives the assumed size where the plan and the inputs give none, and counts those", () => {
    const { size, unknown } = sizesOf(plan, inputs, 7);
    expect(size(3)).toBe(7);
    expect(size(4)).toBe(7);
    expect(unknown).toBe(2);
  });
});

describe("quantile", () => {
  it("is the middle value of an odd count and the mean of the two middle ones of an even count", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("interpolates between the two nearest values", () => {
    expect(quantile([0, 10], 0.1)).toBe(1);
    expect(quantile([0, 10, 20], 0.9)).toBe(18);
  });

  it("is not a number for no values", () => {
    expect(median([])).toBeNaN();
  });
});

describe("phasesOf", () => {
  it("names the phases the pipeline times, counts the evaluation once, and leaves the remainder as the rest", () => {
    const phases = phasesOf({
      resolve: 5,
      compile: 100,
      phases: {
        "js-compiler/phase/createProgram": { count: 1, milliseconds: 10 },
        "js-compiler/phase/typeCheckFile": { count: 3, milliseconds: 30 },
        "js-compiler/phase/declCheckFile": { count: 3, milliseconds: 5 },
        "js-compiler/phase/emitFile": { count: 2, milliseconds: 20 },
        "engine/evaluateRecordGraph": { count: 1, milliseconds: 15 },
        "pattern-manager/compile-cache/evaluate": {
          count: 1,
          milliseconds: 15,
        },
        "pattern-manager/compile-cache/read": { count: 1, milliseconds: 2 },
        "pattern-manager/compile-cache/writeback": {
          count: 1,
          milliseconds: 8,
        },
      },
    });
    expect(phases).toEqual({
      resolve: 5,
      program: 10,
      check: 35,
      emit: 20,
      evaluate: 15,
      cache: 10,
      rest: 10,
    });
  });
});

describe("inlined", () => {
  const link = (id: string | undefined, ...path: string[]) => ({
    "/": { "link@1": { ...(id === undefined ? {} : { id }), path } },
  });
  const documents = new Map<string, Record<string, unknown>>([
    ["r", {
      value: {
        title: link("n1"),
        rows: link("list"),
        input: link("in", "name"),
        self: link(undefined, "title"),
      },
    }],
    ["n1", { value: "computed" }],
    ["list", { value: [link("row", "out"), link("in")] }],
    ["row", { value: { out: { n: 1, back: link("r") } } }],
    ["in", { value: { name: "given" } }],
  ]);
  const owned = new Set(["r", "n1", "list", "row"]);

  it("replaces a link to a document of the instance by what it names, through further links", () => {
    const value = inlined("r", documents, owned) as Record<string, unknown>;
    expect(value.title).toBe("computed");
    expect((value.rows as unknown[])[0]).toEqual({ n: 1, back: link("r") });
  });

  it("keeps a link to a document that is not the instance's", () => {
    const value = inlined("r", documents, owned) as Record<string, unknown>;
    expect(value.input).toEqual(link("in", "name"));
    expect((value.rows as unknown[])[1]).toEqual(link("in"));
  });

  it("resolves a link with no identifier in the document that holds it", () => {
    const value = inlined("r", documents, owned) as Record<string, unknown>;
    expect(value.self).toBe("computed");
  });

  it("keeps a link whose target holds nothing", () => {
    expect(
      inlined(
        "a",
        new Map([["a", { value: link("b", "x") }], ["b", {}]]),
        new Set(["a", "b"]),
      ),
    ).toEqual(link("b", "x"));
  });
});
