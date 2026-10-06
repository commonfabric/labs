import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import ts from "typescript";

import type { DeclaredPositions, DiagnosticInput } from "../src/core/mod.ts";
import {
  collectUnknownResultFieldPaths,
  reportUnknownResultFields,
} from "../src/transformers/unknown-result-fields.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { validateSource } from "./utils.ts";

const DIAGNOSTIC_TYPE = "pattern-result:unknown-type";

const UNKNOWN = { type: "unknown" } as const;

/** The diagnostics one schema draws, reported straight rather than compiled. */
function diagnosticsFor(
  schema: unknown,
  declared?: DeclaredPositions,
  options: { storedSource?: boolean } = {},
): DiagnosticInput[] {
  const reported: DiagnosticInput[] = [];
  reportUnknownResultFields(
    { reportDiagnosticOnce: (input) => void reported.push(input), options },
    schema,
    declared,
    ts.factory.createIdentifier("anchor"),
  );
  return reported;
}

/**
 * The paths each `pattern-result:unknown-type` names for a compiled module
 * importing `computed`, `pattern`, `str`, and `wish`.
 */
async function reportedPaths(body: string): Promise<string[][]> {
  const { diagnostics } = await validateSource(
    `import { computed, pattern, str, wish } from "commonfabric";\n${body}`,
    { types: COMMONFABRIC_TYPES },
  );
  return diagnostics
    .filter((d) => d.type === DIAGNOSTIC_TYPE)
    .map((d) => [...d.message.matchAll(/`([^`]+)`/g)].map((m) => m[1]!))
    .map((quoted) => quoted.slice(0, quoted.indexOf("unknown")));
}

describe("unknown-result-fields", () => {
  describe("collectUnknownResultFieldPaths()", () => {
    it("returns no paths for a schema that is not an object", () => {
      expect(collectUnknownResultFieldPaths(true)).toEqual([]);
      expect(collectUnknownResultFieldPaths(null)).toEqual([]);
      expect(collectUnknownResultFieldPaths([UNKNOWN])).toEqual([]);
    });

    it("returns no path for a root that is `unknown` as a whole", () => {
      expect(collectUnknownResultFieldPaths(UNKNOWN)).toEqual([]);
    });

    it("returns property paths in the order the schema lists them", () => {
      expect(collectUnknownResultFieldPaths({
        type: "object",
        properties: {
          a: { type: "object", properties: { b: UNKNOWN, n: {} } },
          c: UNKNOWN,
          d: { type: "string" },
        },
      })).toEqual(["a.b", "c"]);
    });

    it("returns `[]` for array items, at every depth", () => {
      expect(collectUnknownResultFieldPaths({
        type: "object",
        properties: {
          list: { type: "array", items: UNKNOWN },
          grid: { type: "array", items: { type: "array", items: UNKNOWN } },
        },
      })).toEqual(["list[]", "grid[][]"]);
    });

    it("returns a tuple's slots by index and its rest as `[n...]`", () => {
      expect(collectUnknownResultFieldPaths({
        type: "object",
        properties: {
          pair: {
            type: "array",
            prefixItems: [{ type: "number" }, UNKNOWN],
            items: UNKNOWN,
          },
        },
      })).toEqual(["pair[2...]", "pair[1]"]);
    });

    it("returns `.*` for the values of an index signature, and `*` at the root", () => {
      expect(collectUnknownResultFieldPaths({
        type: "object",
        properties: {
          byName: { type: "object", additionalProperties: UNKNOWN },
        },
      })).toEqual(["byName.*"]);
      expect(collectUnknownResultFieldPaths({
        type: "object",
        additionalProperties: UNKNOWN,
      })).toEqual(["*"]);
    });

    it("returns each arm of a union or an intersection under its position's path, once", () => {
      expect(collectUnknownResultFieldPaths({
        type: "object",
        properties: {
          either: {
            anyOf: [
              { type: "null" },
              { type: "object", properties: { v: UNKNOWN } },
              { type: "object", properties: { v: UNKNOWN } },
            ],
          },
          one: { oneOf: [{ type: "string" }, UNKNOWN] },
          both: {
            allOf: [
              { type: "object", properties: { a: UNKNOWN } },
              { type: "object", properties: { b: { type: "string" } } },
            ],
          },
        },
      })).toEqual(["either.v", "one", "both.a"]);
    });

    it("returns no path at or below a cell or stream handle", () => {
      expect(collectUnknownResultFieldPaths({
        type: "object",
        properties: {
          cell: { type: "unknown", asCell: ["cell"] },
          stream: { type: "unknown", asCell: ["stream"] },
          shaped: {
            type: "object",
            properties: { v: UNKNOWN },
            asCell: ["cell"],
          },
        },
      })).toEqual([]);
    });

    it("returns paths inside the definitions a reference names", () => {
      expect(collectUnknownResultFieldPaths({
        type: "object",
        properties: {
          instance: { $ref: "#/$defs/__class" },
          note: { $ref: "#/$defs/Note" },
        },
        $defs: {
          __class: { type: "object", properties: { u: UNKNOWN } },
          Note: { type: "object", properties: { mention: UNKNOWN } },
        },
      })).toEqual(["instance.u", "note.mention"]);
    });

    it("returns no path through a reference to a schema outside `$defs`", () => {
      expect(collectUnknownResultFieldPaths({
        type: "object",
        properties: {
          screen: { $ref: "https://commonfabric.org/schemas/vnode.json" },
        },
      })).toEqual([]);
    });

    it("returns a path once through a definition that refers to itself", () => {
      expect(collectUnknownResultFieldPaths({
        type: "object",
        properties: { tree: { $ref: "#/$defs/Tree" } },
        $defs: {
          Tree: {
            type: "object",
            properties: {
              v: UNKNOWN,
              kids: { type: "array", items: { $ref: "#/$defs/Tree" } },
            },
          },
        },
      })).toEqual(["tree.v"]);
    });

    it("returns no path the declared positions cover", () => {
      const schema = {
        type: "object",
        properties: {
          ref: UNKNOWN,
          refs: { type: "array", items: UNKNOWN },
          pair: { type: "array", prefixItems: [UNKNOWN] },
          byName: { type: "object", additionalProperties: UNKNOWN },
          loose: UNKNOWN,
        },
      };
      const elements = new Map([["[]", true as const]]);

      expect(collectUnknownResultFieldPaths(schema, true)).toEqual([]);
      expect(collectUnknownResultFieldPaths(
        schema,
        new Map<string, DeclaredPositions>([
          ["ref", true],
          ["refs", elements],
          ["pair", elements],
          ["byName", new Map()],
        ]),
      )).toEqual(["byName.*", "loose"]);
    });
  });

  describe("reportUnknownResultFields()", () => {
    it("reports nothing for a schema with no `unknown` position", () => {
      expect(diagnosticsFor({
        type: "object",
        properties: { n: { type: "number" } },
      })).toEqual([]);
    });

    it("reports nothing for a result declared whole", () => {
      expect(diagnosticsFor(
        { type: "object", properties: { a: UNKNOWN } },
        true,
      )).toEqual([]);
    });

    it("names every undeclared position in one error", () => {
      const reported = diagnosticsFor({
        type: "object",
        properties: { a: UNKNOWN, list: { type: "array", items: UNKNOWN } },
      });

      expect(reported.map((d) => [d.type, d.severity])).toEqual([
        [DIAGNOSTIC_TYPE, "error"],
      ]);
      expect(reported[0]!.message).toContain(
        "output fields `a`, `list[]` have inferred type `unknown`",
      );
    });

    it("demotes the report to a warning over stored source", () => {
      const reported = diagnosticsFor(
        { type: "object", properties: { a: UNKNOWN } },
        undefined,
        { storedSource: true },
      );

      expect(reported.map((d) => [d.type, d.severity])).toEqual([
        [DIAGNOSTIC_TYPE, "warning"],
      ]);
    });
  });

  describe("a compiled pattern", () => {
    it("reports the fields of an untyped `wish()` returned whole", async () => {
      expect(
        await reportedPaths(
          `export default pattern(() => ({ profile: wish({ query: "#p" }) }));`,
        ),
      ).toEqual([["profile.result", "profile.candidates[]"]]);
    });

    it("reports a field read from an untyped `wish()`, directly or through `computed()`", async () => {
      expect(
        await reportedPaths(`export default pattern(() => {
  const w = wish({ query: "#p" });
  const v = computed(() => w.result);
  return { r: w.result, v };
});`),
      ).toEqual([["r", "v"]]);
    });

    it("reports a value a helper returns as `unknown`", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
export default pattern<{ n: number }>(() => ({ out: op(), items: [op()] }));`),
      ).toEqual([["out", "items[]"]]);
    });

    it("reports a value cast to `unknown` or to a tuple of it, and a local typed `unknown[]`", async () => {
      expect(
        await reportedPaths(`export default pattern<{ n: number }>(({ n }) => {
  const refs: unknown[] = [];
  return { f: n as unknown, g: [n, 1] as [unknown, number], refs };
});`),
      ).toEqual([["f", "g[]", "refs[]"]]);
    });

    it("reports a conditional one arm of which is undeclared", async () => {
      expect(
        await reportedPaths(
          `export default pattern<{ u: unknown; flag: boolean }>(({ u, flag }) => {
  const w = wish({ query: "#p" });
  return { v: flag ? u : w.result };
});`,
        ),
      ).toEqual([["v"]]);
    });

    it("reports nothing for an input field passed on, whole or mapped", async () => {
      expect(
        await reportedPaths(
          `export default pattern<{ members?: unknown[]; xs: { ref: unknown }[] }>(
  (input) => ({
    members: input.members,
    refs: input.xs.map((x) => x.ref),
    wrapped: input.xs.map((x) => ({ x })),
    echo: input,
  }),
);`,
        ),
      ).toEqual([]);
    });

    it("reports a field destructured from an untyped `wish()`", async () => {
      expect(
        await reportedPaths(`export default pattern(() => {
  const { result } = wish({ query: "#p" });
  return { result };
});`),
      ).toEqual([["result"]]);
    });

    it("reports nothing for a field destructured from a local, or an element an array method returns", async () => {
      expect(
        await reportedPaths(
          `export default pattern<{ xs: unknown[]; o: { ref: unknown } }>(({ xs, o }) => {
  const { ref } = { ref: o.ref };
  const [first] = xs;
  return {
    ref,
    first,
    found: xs.find((x) => !!x),
    last: xs.at(-1),
    label: str\`\${xs.length} items\`,
  };
});`,
        ),
      ).toEqual([]);
    });

    it("reports nothing for an input field typed through an alias of `unknown`", async () => {
      expect(
        await reportedPaths(`type Ref = unknown;
export default pattern<{ ref: Ref }>(({ ref }) => ({ ref, refs: [ref] }));`),
      ).toEqual([]);
    });

    it("reports nothing for a field of a type written out", async () => {
      expect(
        await reportedPaths(`interface Note { mention: unknown }
function load(): { ref: unknown } { return { ref: 1 }; }
export default pattern<{ n: number }>(({ n }) => {
  const note: Note = { mention: n };
  return { note, cast: { v: n } as { v: unknown }, loaded: load() };
});`),
      ).toEqual([]);
    });

    it("reports nothing for another pattern's result or a typed `wish()`", async () => {
      expect(
        await reportedPaths(`interface Out { mentions: unknown[] }
const Sub = pattern<{ seed: string }, Out>(() => ({ mentions: [] }));
export default pattern<{ seed: string }>(({ seed }) => ({
  subject: Sub({ seed }),
  profile: wish<{ name: string }>({ query: "#p" }),
}));`),
      ).toEqual([]);
    });

    it("reports nothing for a result type written out", async () => {
      expect(
        await reportedPaths(
          `export default pattern<{ n: number }, { u: unknown }>(() => ({ u: 1 as unknown }));`,
        ),
      ).toEqual([]);
    });
  });
});
