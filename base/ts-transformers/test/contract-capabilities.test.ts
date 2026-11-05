import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { CapabilityParamSummary } from "../src/core/mod.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { narrowEventCapabilities } from "../src/transformers/contract-capabilities.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule } from "./transformed-ast.ts";
import { transformFiles } from "./utils.ts";

describe("contract-capabilities", () => {
  /**
   * The event schema of the one handler, with `event` for its event type, in
   * a module declaring `declaration`, whose callback is `callback`; and the
   * diagnostics compiling it reports, type-checked first where `typeCheck`
   * is set.
   */
  async function eventSchema(
    declaration: string,
    event: string,
    callback: string,
    typeCheck = true,
  ): Promise<{
    event: Record<string, unknown>;
    reported: { type: string; severity: string }[];
  }> {
    const diagnostics: TransformationDiagnostic[] = [];
    const files = await transformFiles({
      "/main.tsx": `/// <cts-enable />
import { handler, pattern, Writable, WriteAuthorizedBy } from "commonfabric";
${declaration}
const h = handler<${event}, { c: Writable<number> }>(${callback});
export default pattern<{ c: Writable<number> }>(({ c }) => ({ h: h({ c }) }));`,
    }, {
      types: COMMONFABRIC_TYPES,
      typeCheck,
      pipelineDiagnostics: diagnostics,
    });
    const [schema] = callSchemas(parseModule(files["/main.tsx"]!), "handler");
    return {
      event: schema!,
      reported: diagnostics.map(({ type, severity }) => ({ type, severity })),
    };
  }

  /** Every `asCell` entry list in `schema`, in reading order. */
  function capabilitiesOf(schema: unknown): unknown[] {
    if (Array.isArray(schema)) return schema.flatMap(capabilitiesOf);
    if (typeof schema !== "object" || schema === null) return [];
    const { asCell, ...rest } = schema as Record<string, unknown>;
    return [
      ...(asCell === undefined ? [] : [asCell]),
      ...Object.values(rest).flatMap(capabilitiesOf),
    ];
  }

  describe("narrowEventCapabilities()", () => {
    /** A summary of a body that makes `uses` of the event. */
    const summaryOf = (
      uses: Partial<CapabilityParamSummary>,
    ): CapabilityParamSummary => ({
      name: "event",
      capability: "opaque",
      readPaths: [],
      writePaths: [],
      opaquePaths: [],
      passthrough: false,
      wildcard: false,
      ...uses,
    });
    const cell = (kind: unknown) => ({ type: "number", asCell: [kind] });
    const event = (properties: Record<string, unknown>) => ({
      type: "object",
      properties,
    });

    it("gives each cell the capability the body earns at its path", () => {
      const narrowed = narrowEventCapabilities(
        event({
          w: cell("cell"),
          r: cell("cell"),
          q: cell("cell"),
          u: cell("cell"),
        }),
        summaryOf({
          writePaths: [["w"]],
          readPaths: [["r"]],
          comparablePaths: [["q"]],
        }),
      );

      expect(narrowed).toEqual(event({
        w: cell("cell"),
        r: cell("readonly"),
        q: cell("comparable"),
        u: cell("opaque"),
      }));
    });

    it("gives a cell no more than the capability written for it", () => {
      const narrowed = narrowEventCapabilities(
        event({ w: cell("writeonly"), r: cell("readonly") }),
        summaryOf({ writePaths: [["w"], ["r"]] }),
      );

      expect(narrowed).toEqual(
        event({ w: cell("writeonly"), r: cell("readonly") }),
      );
    });

    it("keeps a stream and a SQLite handle as written", () => {
      const schema = event({ s: cell("stream"), d: cell("sqlite") });

      expect(narrowEventCapabilities(schema, summaryOf({}))).toBe(schema);
    });

    it("narrows a scoped cell in its scope", () => {
      const narrowed = narrowEventCapabilities(
        event({ s: cell({ kind: "cell", scope: "user" }) }),
        summaryOf({ readPaths: [["s"]] }),
      );

      expect(narrowed).toEqual(
        event({ s: cell({ kind: "readonly", scope: "user" }) }),
      );
    });

    it("keeps the capability written for a cell at or below an escape, or strictly below a wildcard", () => {
      const narrowed = narrowEventCapabilities(
        event({
          escaped: event({ x: cell("cell") }),
          wild: event({ x: cell("cell") }),
          atWildcard: cell("cell"),
        }),
        summaryOf({
          escapedPaths: [["escaped"]],
          wildcardPaths: [["wild"], ["atWildcard"]],
        }),
      );

      expect(narrowed).toEqual(event({
        escaped: event({ x: cell("cell") }),
        wild: event({ x: cell("cell") }),
        atWildcard: cell("opaque"),
      }));
    });

    it("gives an index signature's cells what the body does under a key the object does not declare", () => {
      const map = {
        type: "object",
        properties: { 0: cell("cell") },
        additionalProperties: cell("cell"),
      };

      expect(
        narrowEventCapabilities(map, summaryOf({ readPaths: [["0"]] })),
      ).toEqual({
        ...map,
        properties: { 0: cell("readonly") },
        additionalProperties: cell("opaque"),
      });
      expect(
        narrowEventCapabilities(map, summaryOf({ readPaths: [["1"]] })),
      ).toEqual({
        ...map,
        properties: { 0: cell("opaque") },
        additionalProperties: cell("readonly"),
      });
    });

    it("reads an array's element at any index, and each member of a union at the union's path", () => {
      const narrowed = narrowEventCapabilities(
        event({
          list: { type: "array", items: cell("cell") },
          either: { anyOf: [cell("cell"), { type: "null" }] },
        }),
        summaryOf({ readPaths: [["list", "3"], ["either"]] }),
      );

      expect(narrowed).toEqual(event({
        list: { type: "array", items: cell("readonly") },
        either: { anyOf: [cell("readonly"), { type: "null" }] },
      }));
    });

    it("marks a plain position the body compares by identity alone `comparable`", () => {
      const narrowed = narrowEventCapabilities(
        event({ v: { type: "string" } }),
        summaryOf({ identityCellPaths: [["v"]] }),
      );

      expect(narrowed).toEqual(
        event({ v: { type: "string", asCell: ["comparable"] } }),
      );
    });

    it("leaves a cell's value as written", () => {
      const narrowed = narrowEventCapabilities(
        event({ c: { ...event({ inner: cell("cell") }), asCell: ["cell"] } }),
        summaryOf({ readPaths: [["c"]] }),
      );

      expect(narrowed).toEqual(
        event({
          c: { ...event({ inner: cell("cell") }), asCell: ["readonly"] },
        }),
      );
    });

    it("tells the event from a member the empty string names", () => {
      const narrowed = narrowEventCapabilities(
        event({ "": cell("cell"), n: { type: "number" } }),
        summaryOf({ readPaths: [[]] }),
      );

      expect(narrowed).toEqual(
        event({ "": cell("opaque"), n: { type: "number" } }),
      );
    });

    it("keeps a reference to a definition the narrowing leaves as it is", () => {
      const schema = {
        ...event({ p: { $ref: "#/$defs/Plain" } }),
        $defs: { Plain: event({ name: { type: "string" } }) },
      };

      expect(narrowEventCapabilities(schema, summaryOf({}))).toBe(schema);
    });

    it("writes out a definition the narrowing changes, with the reference's own keywords", () => {
      const narrowed = narrowEventCapabilities(
        {
          ...event({ b: { $ref: "#/$defs/Box", description: "A box." } }),
          $defs: { Box: event({ c: cell("cell") }) },
        },
        summaryOf({ readPaths: [["b", "c"]] }),
      );

      expect(narrowed).toEqual(event({
        b: { ...event({ c: cell("readonly") }), description: "A box." },
      }));
    });

    it("narrows a definition apart for each set of uses, telling property `0` from property `1`", () => {
      const pair = event({ 0: cell("cell"), 1: cell("cell") });
      const narrowed = narrowEventCapabilities(
        {
          ...event({
            a: { $ref: "#/$defs/Pair" },
            b: { $ref: "#/$defs/Pair" },
          }),
          $defs: { Pair: pair },
        },
        summaryOf({ readPaths: [["a", "0"], ["b", "1"]] }),
      );

      expect(narrowed).toEqual(event({
        a: event({ 0: cell("readonly"), 1: cell("opaque") }),
        b: event({ 0: cell("opaque"), 1: cell("readonly") }),
      }));
    });

    it("narrows a recursion as a definition under the name of the one it narrows, where nothing else refers to that", () => {
      const narrowed = narrowEventCapabilities(
        {
          $ref: "#/$defs/Tree",
          $defs: {
            Tree: event({
              c: cell("cell"),
              kids: { type: "array", items: { $ref: "#/$defs/Tree" } },
            }),
          },
        },
        summaryOf({}),
      );

      expect(narrowed).toEqual({
        $ref: "#/$defs/Tree",
        $defs: {
          Tree: event({
            c: cell("opaque"),
            kids: { type: "array", items: { $ref: "#/$defs/Tree" } },
          }),
        },
      });
    });

    it("narrows a recursion as a definition of its own, where a cell's value still refers to the one it narrows", () => {
      const tree = event({
        c: cell("cell"),
        kids: { type: "array", items: { $ref: "#/$defs/Tree" } },
      });
      const narrowed = narrowEventCapabilities(
        {
          ...event({
            tree: { $ref: "#/$defs/Tree" },
            held: { $ref: "#/$defs/Tree", asCell: ["cell"] },
          }),
          $defs: { Tree: tree },
        },
        summaryOf({ readPaths: [["held"]] }),
      );

      expect(narrowed).toEqual({
        ...event({
          tree: { $ref: "#/$defs/Tree_narrowed" },
          held: { $ref: "#/$defs/Tree", asCell: ["readonly"] },
        }),
        $defs: {
          Tree: tree,
          Tree_narrowed: event({
            c: cell("opaque"),
            kids: { type: "array", items: { $ref: "#/$defs/Tree_narrowed" } },
          }),
        },
      });
    });

    it("keeps the name of a recursion that holds nothing to narrow", () => {
      const schema = {
        $ref: "#/$defs/Person",
        $defs: {
          Person: event({
            name: { type: "string" },
            sameAs: { $ref: "#/$defs/Person" },
          }),
        },
      };

      expect(narrowEventCapabilities(schema, summaryOf({}))).toBe(schema);
    });

    it("leaves the schema it narrows as it was", () => {
      const shared = cell("cell");
      const schema = event({ a: shared, b: shared });
      const before = structuredClone(schema);

      narrowEventCapabilities(schema, summaryOf({ readPaths: [["a"]] }));

      expect(schema).toEqual(before);
    });

    it("keeps every cell as written where the body uses a cell in a way the summary cannot verify", () => {
      // A dynamic mutator call (`e.c[e.method](1)`) leaves the summary's
      // writes incomplete, so no cell's capability may be narrowed below what
      // the author wrote.

      const schema = event({ c: cell("cell"), d: cell("cell") });

      expect(
        narrowEventCapabilities(
          schema,
          summaryOf({ readPaths: [["d"]], hasUnverifiedCellUse: true }),
        ),
      ).toBe(schema);
    });

    it("marks a position whose schema admits any value `comparable` where the body compares it by identity alone", () => {
      expect(
        narrowEventCapabilities(
          event({ v: true, never: false }),
          summaryOf({ identityCellPaths: [["v"], ["never"]] }),
        ),
      ).toEqual(event({ v: { asCell: ["comparable"] }, never: false }));
      expect(
        narrowEventCapabilities(true, summaryOf({ identityCellPaths: [[]] })),
      ).toEqual({ asCell: ["comparable"] });
    });

    it("leaves a compared position as written where the body also reads or writes below it", () => {
      // Comparing one entry of a map and writing a cell in another meet at
      // the map's `additionalProperties`; a comparable cell there would hide
      // the entry the write reaches.

      const entries = event({ c: cell("cell") });
      const map = { type: "object", additionalProperties: entries };
      expect(
        narrowEventCapabilities(
          event({ map }),
          summaryOf({
            identityCellPaths: [["map", "a"]],
            writePaths: [["map", "b", "c"]],
          }),
        ),
      ).toEqual(event({ map }));
      expect(
        narrowEventCapabilities(
          event({ v: event({ c: cell("cell") }) }),
          summaryOf({ identityCellPaths: [["v"]], readPaths: [["v", "c"]] }),
        ),
      ).toEqual(event({ v: event({ c: cell("readonly") }) }));
    });

    it("leaves a position whose schema admits any value as written where the body also reads below it", () => {
      const map = { type: "object", additionalProperties: true };

      expect(
        narrowEventCapabilities(
          event({ map }),
          summaryOf({
            identityCellPaths: [["map", "a"]],
            readPaths: [["map", "b", "x"]],
          }),
        ),
      ).toEqual(event({ map }));
    });

    it("narrows a definition apart for uses whose paths differ only in where a key's segments break", () => {
      const box = event({
        "a\x00b": cell("cell"),
        a: event({ b: cell("cell") }),
      });
      expect(
        narrowEventCapabilities(
          {
            ...event({
              first: { $ref: "#/$defs/Box" },
              second: { $ref: "#/$defs/Box" },
            }),
            $defs: { Box: box },
          },
          summaryOf({ readPaths: [["first", "a\x00b"], ["second", "a", "b"]] }),
        ),
      ).toEqual(event({
        first: event({
          "a\x00b": cell("readonly"),
          a: event({ b: cell("opaque") }),
        }),
        second: event({
          "a\x00b": cell("opaque"),
          a: event({ b: cell("readonly") }),
        }),
      }));

      const blank = event({ "": cell("cell") });
      expect(
        narrowEventCapabilities(
          {
            ...event({
              x: { $ref: "#/$defs/Blank" },
              y: { $ref: "#/$defs/Blank" },
            }),
            $defs: { Blank: blank },
          },
          summaryOf({ readPaths: [["x"], ["y", ""]] }),
        ),
      ).toEqual(event({
        x: event({ "": cell("opaque") }),
        y: event({ "": cell("readonly") }),
      }));
    });

    it("leaves a `$ref` inside a definition's data as written when it renames the definition", () => {
      const marker = { $ref: "#/$defs/Tree_narrowed" };
      const narrowed = narrowEventCapabilities(
        {
          $ref: "#/$defs/Tree",
          $defs: {
            Tree: event({
              c: cell("cell"),
              kids: { type: "array", items: { $ref: "#/$defs/Tree" } },
              marker: { type: "object", default: marker, const: marker },
            }),
          },
        },
        summaryOf({}),
      );

      expect(narrowed).toEqual({
        $ref: "#/$defs/Tree",
        $defs: {
          Tree: event({
            c: cell("opaque"),
            kids: { type: "array", items: { $ref: "#/$defs/Tree" } },
            marker: { type: "object", default: marker, const: marker },
          }),
        },
      });
    });
  });

  it("reports nothing unread for an event holding arrays of objects nested nine deep", async () => {
    // Compiled with no type check first, as `cf` deploys a pattern unless
    // asked to check it, the checker instantiates the arrays as the reading
    // meets them, each after the one enclosing it, and they nest deeper than
    // a recursion is cut at. An array no alias writes is not counted: only a
    // declaration, or an alias's own tuple or array, recurses without end.

    const keys = ["r", "s", "t", "u", "w", "x", "y", "z", "q"];
    const deep = `${keys.map((key) => `{ ${key}: `).join("")}string${
      " }[]".repeat(keys.length)
    }`;
    const { event, reported } = await eventSchema(
      `type Ev = { c: Writable<number>; d: { r: ${deep} } };`,
      "Ev",
      "(e, { c }) => { c.set(e.c.get()); }",
      false,
    );

    expect(event.type).toBe("object");
    expect(reported).toEqual([]);
  });

  it("overlays the capability the callback earns on a cell a generic event alias holds under arrays of objects nested nine deep", async () => {
    // Compiled with no type check first, the nested arrays are each
    // instantiated after the one enclosing it, but the search for a cell does
    // not count an array no alias writes, so it finds the cell nine arrays
    // in, and the reference expands to overlay it.

    const deep = `${"{ a: ".repeat(9)}Writable<number>${" }[]".repeat(9)}`;
    const { event } = await eventSchema(
      `type Box<T> = { v: T; d: ${deep} };`,
      "Box<string>",
      "(e, { c }) => { c.set(e.v.length); }",
      false,
    );
    let level = (event.properties as Record<string, Record<string, unknown>>)
      .d!;
    for (let depth = 0; depth < 9; depth++) {
      const items = level.items as Record<string, unknown>;
      level = (items.properties as Record<string, Record<string, unknown>>).a!;
    }

    expect(level.asCell).toEqual(["opaque"]);
  });

  describe("an event alias that instantiates itself without end", () => {
    // Each `Nest<T[]>` is a new type, so neither the search for a cell nor
    // the expansion of a reference meets one it has read, and both end where
    // `cutsExpansion()` cuts the recursion. Every cell past the cut is
    // opaque.

    for (
      const [shape, declaration, event] of [
        [
          "an object",
          "type Nest<T> = { v: T; inner?: Nest<T[]> };",
          "Nest<string>",
        ],
        ["a tuple", "type Tup<T> = [T, Tup<T[]>?];", "Tup<string>"],
      ] as const
    ) {
      it(`reports what an event alias of ${shape} holding no cell leaves unread past the cut`, async () => {
        const { event: schema, reported } = await eventSchema(
          declaration,
          event,
          "(e, { c }) => { c.set(e ? 1 : 0); }",
        );

        expect(schema).toBeDefined();
        expect(reported.length).toBeGreaterThan(0);
        for (const diagnostic of reported) {
          expect(diagnostic).toEqual({
            type: "schema-type:unread",
            severity: "warning",
          });
        }
      });
    }

    it("gives a cell the event holds the capability the callback earns, and every other cell, past the cut too, opaque", async () => {
      const { event, reported } = await eventSchema(
        "type Nest<T> = { c: Writable<number>; v: T; children: Nest<T[]>[] };",
        "Nest<string>",
        "(e, { c }) => { c.set(e.c.get()); }",
      );
      const properties = event.properties as Record<
        string,
        Record<string, unknown>
      >;
      const child = (properties.children!.items as Record<string, unknown>)
        .properties as Record<string, Record<string, unknown>>;

      expect(properties.c!.asCell).toEqual(["readonly"]);
      expect(child.c!.asCell).toEqual(["opaque"]);
      expect(
        capabilitiesOf(event).filter((capability) =>
          JSON.stringify(capability) !== '["opaque"]'
        ),
      ).toEqual([["readonly"]]);
      for (const diagnostic of reported) {
        expect(diagnostic).toEqual({
          type: "schema-type:unread",
          severity: "warning",
        });
      }
    });
  });

  describe("an event holding a finite chain of one declaration twelve deep", () => {
    // Each level of these chains is a newer instantiation of one declaration,
    // as in a recursion without end. The schema reads each chain to its end,
    // and every cell takes the capability the body earns at its path.

    /** `Chain<[1, …]>`, `length` ones long. */
    const chainOf = (length: number) =>
      `Chain<[${Array.from({ length }, () => "1").join(", ")}]>`;
    const chain =
      `type Chain<N extends unknown[]> = N extends [unknown, ...infer R]
  ? { value: string; next: Chain<R> }
  : { c: Writable<number> };`;

    it("gives the cell at the end of a chain twelve long the `opaque` capability", async () => {
      const { event, reported } = await eventSchema(
        chain,
        chainOf(12),
        "(e, { c }) => { c.set(e ? 1 : 0); }",
      );

      expect(capabilitiesOf(event)).toEqual([["opaque"]]);
      expect(reported).toEqual([]);
    });

    it("gives the cell at the end of a chain twelve long, which the body reads, the `readonly` capability", async () => {
      const { event } = await eventSchema(
        chain,
        chainOf(12),
        `(e, { c }) => { c.set(e${".next".repeat(12)}.c.get()); }`,
      );

      expect(capabilitiesOf(event)).toEqual([["readonly"]]);
    });

    it("defines every type a recursive cell value at the end of a chain refers to", async () => {
      // At the end of the chain, `Inner` is read with its cells opaque, and
      // the value of its `self` cell as written: that value refers to the
      // definition the schema holds.

      const { event } = await eventSchema(
        `interface Inner { c: Writable<number>; self: Writable<Inner> }
type Chain<N extends unknown[]> = N extends [unknown, ...infer R]
  ? { next: Chain<R> }
  : { inner: Inner };`,
        chainOf(12),
        "(e, { c }) => { c.set(e ? 1 : 0); }",
      );
      const referenced = [
        ...JSON.stringify(event).matchAll(/"#\/\$defs\/([^"]+)"/g),
      ].map(([, name]) => name);

      const { $defs, ...narrowed } = event;

      expect(new Set(referenced)).toEqual(new Set(["Inner"]));
      expect(Object.keys($defs as object)).toEqual(["Inner"]);
      expect(capabilitiesOf(narrowed)).toEqual([["opaque"], ["opaque"]]);
      expect(capabilitiesOf($defs)).toEqual([["cell"], ["cell"]]);
    });

    for (const deepFirst of [true, false]) {
      it(
        `gives \`opaque\` to the cells of a deep and a shallow chain, ${
          deepFirst ? "the deep one" : "the shallow one"
        } declared first`,
        async () => {
          // Cutting the deep chain leaves its search incomplete, which no
          // reading of the shallow chain may take for a search that found no
          // cell.

          const members = [`deep: ${chainOf(12)};`, `shallow: ${chainOf(5)};`];
          const { event } = await eventSchema(
            `${chain}
type Ev<T> = { v: T; ${
              (deepFirst ? members : [...members].reverse()).join(" ")
            } };`,
            "Ev<string>",
            "(e, { c }) => { c.set(e.v.length); }",
          );

          expect(capabilitiesOf(event)).toEqual([["opaque"], ["opaque"]]);
        },
      );
    }

    it("gives a cell read through a short chain `readonly`, and the cell at the end of a chain that grows to it past the cut `opaque`", async () => {
      const { event } = await eventSchema(
        `type Step<N extends unknown[]> = N["length"] extends 9
  ? { c: Writable<number> }
  : { deep: Step<[...N, 1]> };
type Ev<T> = { near: Step<[1, 1, 1, 1, 1, 1, 1]>; far: Step<[]>; v: T };`,
        "Ev<string>",
        "(e, { c }) => { c.set(e.near.deep.deep.c.get()); }",
      );

      expect(capabilitiesOf(event)).toEqual([["readonly"], ["opaque"]]);
    });
  });

  describe("a reference to a generic declaration", () => {
    // The reference's type is the declaration instantiated with the
    // reference's arguments, and its schema reads that type, not the nodes
    // the declaration writes in its own type parameters.

    it("reads a member written as the alias's type parameter as the argument the reference gives", async () => {
      const { event, reported } = await eventSchema(
        "type Box<T> = { c: Writable<number>; v: T };",
        "Box<string>",
        "(e, { c }) => { c.set(e.c.get()); }",
      );

      expect(event).toEqual({
        type: "object",
        properties: {
          c: { type: "number", asCell: ["readonly"] },
          v: { type: "string" },
        },
        required: ["c", "v"],
      });
      expect(reported).toEqual([]);
    });

    it("overlays the capability the callback earns on a cell the reference gives as an argument", async () => {
      const { event, reported } = await eventSchema(
        "type Pair<T> = { v: T };",
        "Pair<Writable<number>>",
        "(e, { c }) => { c.set(e.v.get()); }",
      );

      expect(event).toEqual({
        type: "object",
        properties: { v: { type: "number", asCell: ["readonly"] } },
        required: ["v"],
      });
      expect(reported).toEqual([]);
    });

    for (
      const [shape, declaration, event, written] of [
        [
          "a generic interface",
          "interface Box<T> { c: Writable<number>; v: T }",
          "Box<string>",
          "interface Box { c: Writable<number>; v: string }",
        ],
        [
          "an interface extending a generic one",
          `interface Base<T> { v: T }
interface Box extends Base<string> { c: Writable<number> }`,
          "Box",
          "interface Box { c: Writable<number>; v: string }",
        ],
        [
          "a cell written around the type parameter",
          "type Box<T> = { c: Writable<T>; v: T[] };",
          "Box<number>",
          "type Box = { c: Writable<number>; v: number[] };",
        ],
        [
          "a generic alias the member instantiates in turn",
          `type Inner<U> = { w: Writable<U> };
type Box<T> = { c: Writable<number>; i: Inner<T> };`,
          "Box<string>",
          "type Box = { c: Writable<number>; i: { w: Writable<string> } };",
        ],
        [
          "a mapped type",
          "type Box<T> = { [K in keyof T]: Writable<T[K]> };",
          "Box<{ c: number; v: string }>",
          "type Box = { c: Writable<number>; v: Writable<string> };",
        ],
        [
          "a mapped type that makes members optional",
          "type Ev = { c: Writable<number>; v: string };",
          "Partial<Ev>",
          "type Box = { c?: Writable<number>; v?: string };",
        ],
        [
          "an index signature",
          "type Box<T> = { c: Writable<number>; [key: string]: T | Writable<number> };",
          "Box<string>",
          "type Box = { c: Writable<number>; [key: string]: string | Writable<number> };",
        ],
        [
          "an alias of a cell",
          `type Ref<T> = Writable<T>;
type Box = { c: Writable<number>; r: Ref<string> };`,
          "Box",
          "type Box = { c: Writable<number>; r: Writable<string> };",
        ],
        [
          "an alias of an array",
          `type List<T> = T[];
type Box = { c: Writable<number>; l: List<Writable<string>> };`,
          "Box",
          "type Box = { c: Writable<number>; l: Writable<string>[] };",
        ],
      ] as const
    ) {
      it(`gives ${shape} the event schema of the same type written out`, async () => {
        const callback = event === "Partial<Ev>"
          ? "(e, { c }) => { c.set(e.c?.get() ?? 0); }"
          : "(e, { c }) => { c.set(e.c.get()); }";
        const generic = await eventSchema(declaration, event, callback);
        const plain = await eventSchema(written, "Box", callback);

        expect(capabilitiesOf(plain.event)).toContainEqual(["readonly"]);
        expect(generic.event).toEqual(plain.event);
        expect(generic.reported).toEqual(plain.reported);
      });
    }

    for (
      const [shape, argument, written] of [
        ["an object", "{ name: string }", "{ name: string }"],
        ["an array", "string[]", "string[]"],
      ] as const
    ) {
      it(`marks ${shape} the reference gives as an argument \`comparable\` where the callback only compares its identity, as written out`, async () => {
        const callback = "(e, { c }) => { c.set(equals(e.v, e.v) ? 1 : 0); }";
        const generic = await eventSchema(
          `import { equals } from "commonfabric";
type Box<T> = { c: Writable<number>; v: T };`,
          `Box<${argument}>`,
          callback,
        );
        const plain = await eventSchema(
          `import { equals } from "commonfabric";
type Box = { c: Writable<number>; v: ${written} };`,
          "Box",
          callback,
        );
        const v = (schema: Record<string, unknown>) =>
          (schema.properties as Record<string, Record<string, unknown>>).v!;

        expect(v(plain.event).asCell).toEqual(["comparable"]);
        expect(generic.event).toEqual(plain.event);
      });
    }

    it("reads an optional member whose generic alias denotes a union of several members without the `undefined` its `?` adds", async () => {
      const callback = "(e, { c }) => { c.set(e.c.get()); }";
      const generic = await eventSchema(
        `type Identity<T> = T;
type Box = { c: Writable<number>; v?: Identity<Writable<number> | string> };`,
        "Box",
        callback,
      );
      const plain = await eventSchema(
        "type Box = { c: Writable<number>; v?: Writable<number> | string };",
        "Box",
        callback,
      );
      const alternatives = (schema: Record<string, unknown>) =>
        (schema.properties as Record<string, Record<string, unknown>>).v!
          .anyOf as unknown[];

      expect(alternatives(generic.event)).toHaveLength(2);
      expect(alternatives(generic.event)).toEqual(
        expect.arrayContaining(alternatives(plain.event)),
      );
    });

    it("reads a reference to a generic union alias as the union, overlaying the cell in a member", async () => {
      const { event } = await eventSchema(
        "type Maybe<T> = T | undefined;",
        "Maybe<{ c: Writable<number> }>",
        "(e, { c }) => { c.set(e?.c.get() ?? 0); }",
      );

      expect(event.anyOf).toHaveLength(2);
      expect(event.anyOf).toEqual(expect.arrayContaining([
        { type: "undefined" },
        {
          type: "object",
          properties: { c: { type: "number", asCell: ["readonly"] } },
          required: ["c"],
        },
      ]));
    });

    it("keeps a reference to a generic tuple alias as written, as a tuple written out is", async () => {
      const generic = await eventSchema(
        "type Tup<T> = [Writable<number>, T];",
        "Tup<string>",
        "(e, { c }) => { c.set(e[0].get()); }",
      );
      const plain = await eventSchema(
        "type Tup = [Writable<number>, string];",
        "Tup",
        "(e, { c }) => { c.set(e[0].get()); }",
      );
      const items = (schema: Record<string, unknown>) =>
        (schema.items as Record<string, unknown>).anyOf;

      expect(generic.event.type).toBe("array");
      expect(items(generic.event)).toHaveLength(2);
      expect(items(generic.event)).toEqual(
        expect.arrayContaining(items(plain.event) as unknown[]),
      );
    });
  });

  describe("a scoped cell", () => {
    // A scoped cell takes the capability the body earns like any cell, and
    // keeps its scope.

    for (
      const [spelling, declaration, event] of [
        [
          "written out",
          "type Ev = { c: Writable<number>; s: PerUser<Writable<number>> };",
          "Ev",
        ],
        [
          "given as a generic alias's argument",
          "type Box<T> = { c: Writable<number>; s: T };",
          "Box<PerUser<Writable<number>>>",
        ],
      ] as const
    ) {
      it(`makes a scoped cell ${spelling} that no use reaches \`opaque\`, in its scope`, async () => {
        const { event: schema } = await eventSchema(
          `import type { PerUser } from "commonfabric";\n${declaration}`,
          event,
          "(e, { c }) => { c.set(e.c.get()); }",
        );

        expect(schema.properties).toEqual({
          c: { type: "number", asCell: ["readonly"] },
          s: { type: "number", asCell: [{ kind: "opaque", scope: "user" }] },
        });
      });
    }

    for (
      const [use, callback, kind] of [
        ["reads", "(e, { c }) => { c.set(e.get()); }", "readonly"],
        ["writes", "(e, { c }) => { e.set(c.get()); }", "cell"],
      ] as const
    ) {
      it(`gives a scoped cell the event is, which the body ${use}, the \`${kind}\` capability in its scope`, async () => {
        const { event } = await eventSchema(
          'import type { PerUser } from "commonfabric";',
          "PerUser<Writable<number>>",
          callback,
        );

        expect(event).toEqual({
          type: "number",
          asCell: [{ kind, scope: "user" }],
        });
      });
    }

    it("gives a scoped cell the body reads the `readonly` capability in its scope", async () => {
      const { event: schema } = await eventSchema(
        `import type { PerUser } from "commonfabric";
type Ev = { c: Writable<number>; s: PerUser<Writable<number>> };`,
        "Ev",
        "(e, { c }) => { c.set(e.s.get()); }",
      );

      expect(
        (schema.properties as Record<string, unknown>).s,
      ).toEqual({
        type: "number",
        asCell: [{ kind: "readonly", scope: "user" }],
      });
    });
  });

  describe("an event that is a cell", () => {
    // A use at any path reaches the event itself, so a cell the event is
    // earns the capability of every use the body makes.

    for (
      const [use, callback, capability] of [
        ["reads", "(e, { c }) => { c.set(e.get()); }", "readonly"],
        ["writes", "(e, { c }) => { e.set(1); c.set(-1); }", "cell"],
        [
          "only compares",
          "(e, { c }) => { if (e.equals(e)) c.set(1); }",
          "comparable",
        ],
        ["never uses", "(e, { c }) => { c.set(1); }", "opaque"],
      ] as const
    ) {
      it(`gives a cell the event is the \`${capability}\` capability where the body ${use} it`, async () => {
        const { event } = await eventSchema("", "Writable<number>", callback);

        expect(event).toEqual({ type: "number", asCell: [capability] });
      });
    }

    it("gives a cell the event is through an alias the capability the body's use earns", async () => {
      const { event } = await eventSchema(
        "type Ref = Writable<number>;",
        "Ref",
        "(e, { c }) => { c.set(e.get()); }",
      );

      expect(event).toEqual({ type: "number", asCell: ["readonly"] });
    });
  });

  describe("a tuple, an index signature, a symbol key, or a recursion", () => {
    // Each cell takes the capability the body earns at its data path, in
    // whatever shape holds it: the elements of a tuple or an array share the
    // path `*`, and the cells an index signature types take what the body
    // does under a key the object does not declare.

    const callback = "(e, { c }) => { c.set(e.c.get()); }";
    const opaqueNumber = { type: "number", asCell: ["opaque"] };

    for (
      const [shape, declaration, expected] of [
        [
          "a tuple",
          "type Ev = { c: Writable<number>; x: [Writable<number>, string] };",
          {
            type: "array",
            items: { anyOf: [opaqueNumber, { type: "string" }] },
          },
        ],
        [
          "a `readonly` array",
          "type Ev = { c: Writable<number>; x: readonly Writable<number>[] };",
          { type: "array", items: opaqueNumber },
        ],
        [
          "an interface whose cells only an index signature types",
          `interface Ix { [key: string]: Writable<number> }
type Ev = { c: Writable<number>; x: Ix };`,
          {
            type: "object",
            properties: {},
            additionalProperties: opaqueNumber,
          },
        ],
      ] as const
    ) {
      it(`makes the cells of ${shape} no use reaches \`opaque\``, async () => {
        const { event } = await eventSchema(declaration, "Ev", callback);

        expect((event.properties as Record<string, unknown>).x).toEqual(
          expected,
        );
      });
    }

    it("makes a cell an index signature types `opaque` where no use reaches an undeclared key", async () => {
      const { event } = await eventSchema(
        "type Ev = { c: Writable<number>; [key: string]: Writable<number> };",
        "Ev",
        callback,
      );

      expect(event.additionalProperties).toEqual(opaqueNumber);
    });

    it("keeps an index signature that types no cell as written", async () => {
      const { event } = await eventSchema(
        "type Ev = { c: Writable<number>; [key: string]: unknown };",
        "Ev",
        callback,
      );

      expect(event.additionalProperties).toEqual({ type: "unknown" });
    });

    it("keeps a cell an index signature types as written where the body reads it under a key it computes", async () => {
      const { event } = await eventSchema(
        "type Ev = { dict: { [key: string]: Writable<number> }; key: string };",
        "Ev",
        "(e, { c }) => { c.set(e.dict[e.key]?.get() ?? 0); }",
      );
      const dict = (event.properties as Record<string, Record<string, unknown>>)
        .dict!;

      expect(dict.additionalProperties).toEqual({
        type: "number",
        asCell: ["cell"],
      });
    });

    it("tells a numeric key the literal declares from one only its index signature types", async () => {
      const declaration =
        "type Ev = { 0: Writable<number>; [key: number]: Writable<number> };";
      const undeclared = await eventSchema(
        declaration,
        "Ev",
        "(e, { c }) => { c.set(e[1]?.get() ?? 0); }",
      );
      const declared = await eventSchema(
        declaration,
        "Ev",
        "(e, { c }) => { c.set(e[0].get()); }",
      );

      expect(undeclared.event.additionalProperties).toEqual({
        type: "number",
        asCell: ["readonly"],
      });
      expect(declared.event.additionalProperties).toEqual(opaqueNumber);
    });

    for (
      const [use, event, callback] of [
        [
          "a destructured parameter",
          "Tup",
          "([a, b], { c }) => { c.set(a.get() + b.get().length); }",
        ],
        [
          "a destructuring declaration",
          "Tup",
          "(e, { c }) => { const [a] = e; c.set(a.get()); }",
        ],
        [
          "a rest element",
          "Holder",
          "({ c: x, ...rest }, { c }) => { c.set(x.get() + rest.t[0].get()); }",
        ],
        [
          "a function that leaves no summary",
          "Holder",
          "(e, { c }) => { sink(e.t); c.set(e.c.get()); }",
        ],
      ] as const
    ) {
      it(`keeps the cells of a tuple as written where the body reaches them through ${use}`, async () => {
        const { event: schema } = await eventSchema(
          `declare function sink(value: unknown): void;
type Tup = [Writable<number>, Writable<string>];
type Holder = { c: Writable<number>; t: [Writable<number>, string] };`,
          event,
          callback,
        );

        expect(capabilitiesOf(schema)).not.toContainEqual(["opaque"]);
      });
    }

    it("keeps a tuple as written where the body reads the value above it under a key it computes", async () => {
      const { event } = await eventSchema(
        `type Ev = {
  holder: { [key: string]: { t: [Writable<number>, string] } };
  key: string;
};`,
        "Ev",
        "(e, { c }) => { c.set(e.holder[e.key]?.t[0].get() ?? 0); }",
      );

      expect(capabilitiesOf(event)).toEqual([["cell"]]);
    });

    for (
      const [shape, declaration, event] of [
        [
          "a tuple",
          "type Ev = [Writable<string>, WriteAuthorizedBy<number, typeof saver>];",
          "Ev",
        ],
        [
          "a generic tuple",
          "type Ev<T> = [Writable<T>, WriteAuthorizedBy<number, typeof saver>];",
          "Ev<string>",
        ],
      ] as const
    ) {
      it(`keeps the writer ${shape} names by its syntax where no use reaches its cells`, async () => {
        const { event: schema } = await eventSchema(
          `const saver = handler<unknown, {}>(() => {});
${declaration}`,
          event,
          "(e, { c }) => { c.set(1); }",
        );

        expect(schema).toEqual({
          type: "array",
          items: {
            anyOf: [
              { type: "string", asCell: ["opaque"] },
              {
                type: "number",
                ifc: {
                  writeAuthorizedBy: {
                    __ctWriterIdentityOf: {
                      file: "/main.tsx",
                      path: ["saver"],
                    },
                  },
                },
              },
            ],
          },
        });
      });
    }

    it("keeps a tuple as written where the body reads its parent under a key it computes", async () => {
      const { event } = await eventSchema(
        `type Ev = {
  box: { pair: [Writable<number>]; other: [Writable<number>] };
  key: "pair" | "other";
};`,
        "Ev",
        "(e, { c }) => { c.set(e.box[e.key][0].get()); }",
      );

      expect(capabilitiesOf(event)).toEqual([["cell"], ["cell"]]);
    });

    it("gives the cells of a tuple `readonly` where the body reads it at an index of the array holding it", async () => {
      const { event } = await eventSchema(
        "type Ev = { list: { t: [Writable<number>] }[] };",
        "Ev",
        "(e, { c }) => { c.set(e.list[1]!.t[0].get()); }",
      );

      expect(capabilitiesOf(event)).toEqual([["readonly"]]);
    });

    it("makes the cells of a tuple `opaque` where a rest element reaches only a value beside it", async () => {
      const { event } = await eventSchema(
        `type Ev = {
  dict: { a: Writable<number>; b: Writable<number> };
  t: [Writable<number>];
};`,
        "Ev",
        "(e, { c }) => { const { a, ...rest } = e.dict; c.set(a.get() + rest.b.get()); }",
      );

      expect((event.properties as Record<string, unknown>).t).toEqual({
        type: "array",
        items: opaqueNumber,
      });
    });

    for (
      const [where, callback, expected] of [
        [
          "on the object the index signature is in, keeps them as written",
          `(e, { c }) => { const { ...rest } = e.m; c.set(rest["k"]?.get() ?? 0); }`,
          { type: "number", asCell: ["cell"] },
        ],
        [
          "only beside it, makes them `opaque`",
          "(e, { c }) => { const { a, ...rest } = e.d; c.set(a + rest.b); }",
          opaqueNumber,
        ],
      ] as const
    ) {
      it(`reads the cells an index signature types where a rest element is ${where}`, async () => {
        const { event } = await eventSchema(
          `type Ev = {
  m: { [key: string]: Writable<number> };
  d: { a: number; b: number };
};`,
          "Ev",
          callback,
        );
        const m = (event.properties as Record<string, Record<string, unknown>>)
          .m!;

        expect(m.additionalProperties).toEqual(expected);
      });
    }

    it("gives a cell an index signature types `readonly` where the body reads it under an undeclared key", async () => {
      const { event } = await eventSchema(
        "type Ev = { c: Writable<number>; [key: string]: Writable<number> };",
        "Ev",
        "(e, { c }) => { c.set(e.other?.get() ?? 0); }",
      );

      expect(event.additionalProperties).toEqual({
        type: "number",
        asCell: ["readonly"],
      });
    });

    it("makes the cells of a type with a symbol-keyed property `opaque` where no use reaches them", async () => {
      const { event } = await eventSchema(
        `declare const K: unique symbol;
interface S { [K]: string; w: Writable<number> }
type Ev = { c: Writable<number>; s: S };`,
        "Ev",
        callback,
      );

      expect(capabilitiesOf(event)).toEqual([["readonly"], ["opaque"]]);
    });

    it("makes the cells past a recursion's cycle `opaque` where no use reaches them", async () => {
      const { event } = await eventSchema(
        "interface Tree { c: Writable<number>; kids: Tree[] }",
        "Tree",
        callback,
      );

      expect(capabilitiesOf(event)).toEqual([
        ["readonly"],
        ["opaque"],
      ]);
    });

    it("makes the cells of an event tuple the body never reads `opaque`, and gives those of one it reads `readonly`", async () => {
      const unread = await eventSchema(
        "type Tup = [Writable<number>, string];",
        "Tup",
        "(e, { c }) => { c.set(1); }",
      );
      const read = await eventSchema(
        "type Tup = [Writable<number>, string];",
        "Tup",
        "(e, { c }) => { c.set(e[0].get()); }",
      );

      expect(capabilitiesOf(unread.event)).toEqual([["opaque"]]);
      expect(capabilitiesOf(read.event)).toEqual([["readonly"]]);
    });

    for (
      const [shape, member] of [
        ["a mapped type", "{ [K in 'a' | 'b']: Writable<number> }"],
        ["a `Record`", "Record<'a' | 'b', Writable<number>>"],
      ] as const
    ) {
      it(`overlays the cells of ${shape}: \`readonly\` where the body reads, \`opaque\` elsewhere`, async () => {
        const { event } = await eventSchema(
          `type Ev = { c: Writable<number>; m: ${member} };`,
          "Ev",
          "(e, { c }) => { c.set(e.m.a.get()); }",
        );

        expect((event.properties as Record<string, unknown>).m).toEqual({
          type: "object",
          properties: {
            a: { type: "number", asCell: ["readonly"] },
            b: opaqueNumber,
          },
          required: ["a", "b"],
        });
      });
    }
  });

  describe("a writer policy", () => {
    // A writer is named only by the `typeof` its syntax writes. The schema is
    // generated from that syntax, and narrowing a cell keeps the writer.

    const saver = "const saver = handler<unknown, {}>(() => {});";
    const policy = "Writable<WriteAuthorizedBy<number, typeof saver>>";
    const writer = {
      __ctWriterIdentityOf: { file: "/main.tsx", path: ["saver"] },
    };

    /** Every `ifc.writeAuthorizedBy` in `schema`, in reading order. */
    function writersOf(schema: unknown): unknown[] {
      if (Array.isArray(schema)) return schema.flatMap(writersOf);
      if (typeof schema !== "object" || schema === null) return [];
      const { ifc, ...rest } = schema as Record<string, unknown>;
      const own = (ifc as { writeAuthorizedBy?: unknown } | undefined)
        ?.writeAuthorizedBy;
      return [
        ...(own === undefined ? [] : [own]),
        ...Object.values(rest).flatMap(writersOf),
      ];
    }

    for (
      const [shape, event, callback, capabilities] of [
        [
          "a `Record` whose cells hold one",
          `Record<"a" | "b", ${policy}>`,
          "(e, { c }) => { e.a.get(); c.set(1); }",
          [["readonly"], ["opaque"]],
        ],
        [
          "a generic declaration's argument",
          "Box<typeof saver>",
          "(e, { c }) => { c.set(e.c.get()); }",
          [["readonly"]],
        ],
        [
          "a scoped cell no use reaches",
          `{ x: PerUser<${policy}>; n: number }`,
          "(e, { c }) => { c.set(e.n); }",
          [[{ kind: "opaque", scope: "user" }]],
        ],
        [
          "the cells an index signature types where no use reaches them",
          `{ m: { [key: string]: ${policy} }; n: number }`,
          "(e, { c }) => { c.set(e.n); }",
          [["opaque"]],
        ],
      ] as const
    ) {
      it(`keeps the writer of ${shape}`, async () => {
        const { event: schema, reported } = await eventSchema(
          `import type { PerUser } from "commonfabric";
${saver}
type Box<B> = { c: Writable<number>; p: WriteAuthorizedBy<number, B> };`,
          event,
          callback,
        );

        expect(capabilitiesOf(schema)).toEqual(capabilities);
        expect(writersOf(schema)).toEqual(
          writersOf(schema).map(() => writer),
        );
        expect(writersOf(schema).length).toBeGreaterThan(0);
        expect(reported).toEqual([]);
      });
    }
  });

  it("keeps the cells of a `Record` as written where a rest element reaches them, and makes those beside it `opaque`", async () => {
    const { event } = await eventSchema(
      "",
      `{ dict: Record<"a" | "b", Writable<number>>; other: Writable<number> }`,
      "(e, { c }) => { const { ...rest } = e.dict; c.set(rest.a.get()); }",
    );

    expect(capabilitiesOf(event)).toEqual([["cell"], ["cell"], ["opaque"]]);
  });

  it("reads an optional member at its type without the `undefined` its `?` adds", async () => {
    const callback = "(e, { c }) => { c.set(e.c.get()); }";
    const { event } = await eventSchema(
      `interface Reply { message: Writable<number>; shownIn: string }
interface Ev { c: Writable<number>; r?: Reply }`,
      "Ev",
      callback,
    );
    const written = await eventSchema(
      `type Ev = {
  c: Writable<number>;
  r?: { message: Writable<number>; shownIn: string };
};`,
      "Ev",
      callback,
    );

    expect((event.properties as Record<string, unknown>).r).toEqual({
      type: "object",
      properties: {
        message: { type: "number", asCell: ["opaque"] },
        shownIn: { type: "string" },
      },
      required: ["message", "shownIn"],
    });
    expect(event).toEqual(written.event);
  });

  describe("a cell the callback uses in a way its summary does not record", () => {
    // A use the capability analysis does not follow member by member gives no
    // capability narrower than the one written to show sufficient, so a cell
    // it reaches keeps the one written, and a cell it does not reach still
    // earns its own.

    const cell = (asCell: string) => ({ type: "number", asCell: [asCell] });
    for (
      const [use, declaration, event, callback, expected] of [
        [
          "a rest element of an object destructuring",
          `import type { ReadonlyCell } from "commonfabric";
type Ev = { a: Writable<number>; b: ReadonlyCell<number> };`,
          "Ev",
          "(e, { c }) => { const { ...rest } = e; c.set(rest.a.get()); }",
          {
            type: "object",
            properties: { a: cell("cell"), b: cell("readonly") },
            required: ["a", "b"],
          },
        ],
        [
          "an array destructuring",
          "type Ev = Writable<number>[];",
          "Ev",
          "(e, { c }) => { const [, b] = e; c.set(b!.get()); }",
          { type: "array", items: cell("cell") },
        ],
        [
          "an array destructuring of the parameter",
          "type Ev = Writable<number>[];",
          "Ev",
          "([a], { c }) => { c.set(a!.get()); }",
          { type: "array", items: cell("cell") },
        ],
        [
          "a key that can name any element",
          "type Ev = { list: { v: Writable<number> }[]; other: Writable<number> };",
          "Ev",
          "(e, { c }) => { c.set(e.list[c.get()]!.v.get()); }",
          {
            type: "object",
            properties: {
              list: {
                type: "array",
                items: {
                  type: "object",
                  properties: { v: cell("cell") },
                  required: ["v"],
                },
              },
              other: cell("opaque"),
            },
            required: ["list", "other"],
          },
        ],
        [
          "a helper with no summary, handed the cell",
          `declare function keep(value: unknown): boolean;
type Ev = { x: Writable<number>; other: Writable<number> };`,
          "Ev",
          "(e, { c }) => { if (keep(e.x)) c.set(1); }",
          {
            type: "object",
            properties: { x: cell("cell"), other: cell("opaque") },
            required: ["x", "other"],
          },
        ],
        [
          "a key that can name any element, in a helper",
          `function pick(list: readonly { v: Writable<number> }[], i: number): number {
  return list[i]!.v.get();
}
type Ev = { list: { v: Writable<number> }[]; other: Writable<number> };`,
          "Ev",
          "(e, { c }) => { c.set(pick(e.list, c.get())); }",
          {
            type: "object",
            properties: {
              list: {
                type: "array",
                items: {
                  type: "object",
                  properties: { v: cell("cell") },
                  required: ["v"],
                },
              },
              other: cell("opaque"),
            },
            required: ["list", "other"],
          },
        ],
        [
          "a traversal of the cell's value alone",
          "type Ev = { x: Writable<number>; other: Writable<number> };",
          "Ev",
          "(e, { c }) => { c.set(JSON.stringify(e.x.get()).length); }",
          {
            type: "object",
            properties: { x: cell("readonly"), other: cell("opaque") },
            required: ["x", "other"],
          },
        ],
      ] as const
    ) {
      it(`gives each cell what ${use} lets the callback do`, async () => {
        const { event: schema, reported } = await eventSchema(
          declaration,
          event,
          callback,
        );

        expect(schema).toEqual(expected);
        expect(reported).toEqual([]);
      });
    }

    describe("deep in a recursion", () => {
      // The untracked use reaches cells twelve levels into a recursion; they
      // keep the capability written for them, and the untouched sibling does
      // not.

      const chain = (length: number) =>
        `type Chain<N extends unknown[]> = N extends [unknown, ...infer R]
  ? { next: Chain<R> }
  : { v: Writable<number> };
type Deep = Chain<[${Array.from({ length }, () => "1").join(", ")}]>;`;
      const nexts = (length: number) => ".next".repeat(length);
      for (
        const [use, declaration, callback] of [
          [
            "a key that can name any element, twelve levels above the cell",
            `${chain(12)}
type Ev = { list: Deep[]; other: Writable<number> };`,
            `(e, { c }) => { c.set(e.list[c.get()]!${nexts(12)}.v.get()); }`,
          ],
          [
            "a helper with no summary, handed a value twelve levels above the cell",
            `declare function keep(value: unknown): number;
${chain(12)}
type Ev = { x: Deep; other: Writable<number> };`,
            "(e, { c }) => { c.set(keep(e.x)); }",
          ],
          [
            "a helper with no summary, handed a value four levels above the cell",
            `declare function keep(value: unknown): number;
${chain(4)}
type Ev = { x: Deep; other: Writable<number> };`,
            "(e, { c }) => { c.set(keep(e.x)); }",
          ],
          [
            "a rest element twelve levels down",
            `${chain(13)}
type Ev = { x: Deep; other: Writable<number> };`,
            `(e, { c }) => { const { ...rest } = e.x${
              nexts(12)
            }; c.set(rest.next.v.get()); }`,
          ],
        ] as const
      ) {
        it(`keeps the cell ${use} reaches as written`, async () => {
          const { event: schema, reported } = await eventSchema(
            declaration,
            "Ev",
            callback,
          );

          expect((schema.properties as Record<string, unknown>).other).toEqual(
            cell("opaque"),
          );
          expect(
            capabilitiesOf(schema).map((capability) =>
              JSON.stringify(capability)
            ).sort(),
          ).toEqual(['["cell"]', '["opaque"]']);
          expect(reported).toEqual([]);
        });
      }
    });

    it("keeps a cell beside one handed on under the empty key opaque", async () => {
      const { event: schema } = await eventSchema(
        `declare function keep(value: unknown): boolean;
type Ev = { "": Writable<number>; other: Writable<number> };`,
        "Ev",
        '(e, { c }) => { if (keep(e[""])) c.set(1); }',
      );

      expect((schema.properties as Record<string, unknown>).other).toEqual(
        cell("opaque"),
      );
    });
  });

  describe("a use the summary cannot record exactly", () => {
    it("keeps a cell the body calls a mutator on by a name it computes as written", async () => {
      const { event: schema } = await eventSchema(
        "",
        '{ c: Writable<number>; method: "set" | "send" }',
        "(e) => { e.c[e.method](1); }",
      );

      expect(
        (schema.properties as Record<string, Record<string, unknown>>).c!
          .asCell,
      ).toEqual(["cell"]);
    });

    it("marks a member typed `any` the body compares by identity alone `comparable`", async () => {
      const { event: schema } = await eventSchema(
        `import { equals } from "commonfabric";
type Ev = { v: any };`,
        "Ev",
        "(e, { c }) => { c.set(equals(e.v, e.v) ? 1 : 0); }",
      );

      expect((schema.properties as Record<string, unknown>).v).toEqual({
        asCell: ["comparable"],
      });
    });

    it("marks an event typed `any` the body compares by identity alone `comparable`", async () => {
      const { event: schema } = await eventSchema(
        `import { equals } from "commonfabric";`,
        "any",
        "(e, { c }) => { c.set(equals(e, e) ? 1 : 0); }",
      );

      expect(schema).toEqual({ asCell: ["comparable"] });
    });

    it("keeps the entries of a map the body compares one entry of and writes another as written", async () => {
      const { event: schema, reported } = await eventSchema(
        `import { equals } from "commonfabric";
type Ev = { map: Record<string, { c: Writable<number> }> };`,
        "Ev",
        "(e) => { if (equals(e.map.a, e.map.a)) e.map.b!.c.set(1); }",
      );

      expect(reported).toEqual([]);
      const map = (schema.properties as Record<string, Record<string, unknown>>)
        .map!;
      const entry = map.additionalProperties as Record<string, unknown>;
      expect(entry.asCell).toBeUndefined();
      expect(
        (entry.properties as Record<string, Record<string, unknown>>).c!.asCell,
      ).toEqual(["cell"]);
    });

    it("gives two references to one declaration their own capabilities where a key holds what would separate a path", async () => {
      const { event: schema, reported } = await eventSchema(
        `type Box = { "a\\x00b": Writable<number>; a: { b: Writable<number> } };
type Ev = { first: Box; second: Box };`,
        "Ev",
        '(e, { c }) => { c.set(e.first["a\\x00b"].get() + e.second.a.b.get()); }',
      );

      expect(reported).toEqual([]);
      const props = schema.properties as Record<string, unknown>;
      expect(capabilitiesOf(props.first)).toEqual([["readonly"], ["opaque"]]);
      expect(capabilitiesOf(props.second)).toEqual([["opaque"], ["readonly"]]);
    });

    it("keeps a recursion's default data as written when it renames the recursion", async () => {
      const { event: schema } = await eventSchema(
        `import { Default } from "commonfabric";
const marker = { "$ref": "#/$defs/Ev_narrowed" } as const;
type Ev = {
  c: Writable<number>;
  next?: Ev;
  marker: Default<{ "$ref": string }, typeof marker>;
};`,
        "Ev",
        "(e, { c }) => { c.set(e.c.get()); }",
      );
      const defaults: unknown[] = [];
      const collect = (node: unknown): void => {
        if (typeof node !== "object" || node === null) return;
        const record = node as Record<string, unknown>;
        const marker =
          (record.properties as Record<string, unknown> | undefined)
            ?.marker as Record<string, unknown> | undefined;
        if (marker !== undefined) defaults.push(marker.default);
        Object.values(record).forEach(collect);
      };
      collect(schema);

      expect(defaults.length).toBeGreaterThan(0);
      for (const value of defaults) {
        expect(value).toEqual({ $ref: "#/$defs/Ev_narrowed" });
      }
    });
  });
});
