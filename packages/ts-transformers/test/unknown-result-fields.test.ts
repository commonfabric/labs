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
  declared: DeclaredPositions = false,
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
 * importing `computed`, `lift`, `pattern`, `str`, `unless`, `when`, and
 * `wish`.
 */
async function reportedPaths(body: string): Promise<string[][]> {
  const { diagnostics } = await validateSource(
    `import { computed, lift, pattern, str, unless, when, wish } from "commonfabric";\n${body}`,
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
          ["byName", false],
          ["loose", false],
        ]),
      )).toEqual(["byName.*", "loose"]);
    });

    it("returns no path for a part the declared positions show the value lacks", () => {
      expect(collectUnknownResultFieldPaths(
        {
          type: "object",
          properties: {
            note: { type: "object", properties: { ref: UNKNOWN } },
          },
        },
        new Map(),
      )).toEqual([]);
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
        false,
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

    it("reports nothing for a named callback or lift whose return type is written", async () => {
      expect(
        await reportedPaths(`interface Note { ref: unknown }
function toNote(): Note { return { ref: 1 }; }
function noteOf(n: number): Note { return { ref: n }; }
const getNote = lift((n: number): Note => ({ ref: n }));
export default pattern<{ xs: number[] }>(({ xs }) => ({
  note: computed(toNote),
  notes: xs.map(noteOf),
  lifted: getNote(1),
}));`),
      ).toEqual([]);
    });

    it("reports nothing for a callback or a lift named through an alias", async () => {
      expect(
        await reportedPaths(`interface Note { ref: unknown }
function toNote(): Note { return { ref: 1 }; }
const getNote = lift((n: number): Note => ({ ref: n }));
const callbackAlias = toNote;
const liftAlias = getNote;
export default pattern(() => ({
  note: computed(callbackAlias),
  lifted: liftAlias(1),
}));`),
      ).toEqual([]);
    });

    it("reports a callback reassigned after its declaration, and a callback or a lift read from an object", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note { ref: unknown }
let toNote = (): Note => ({ ref: 1 });
toNote = () => ({ ref: op() });
const lifts = { getNote: lift((n: number): Note => ({ ref: n })) };
const { getNote: picked } = lifts;
const { toNote: pickedCallback } = { toNote: (): Note => ({ ref: 1 }) };
export default pattern(() => ({
  written: computed(toNote),
  member: lifts.getNote(1),
  destructured: picked(1),
  destructuredCallback: computed(pickedCallback),
}));`),
      ).toEqual([[
        "written.ref",
        "member.ref",
        "destructured.ref",
        "destructuredCallback.ref",
      ]]);
    });

    it("returns from tracing a callback that maps itself", async () => {
      expect(
        await reportedPaths(`interface Tree { kids: Tree[] }
function walk(tree: Tree) { return { kids: tree.kids.map(walk) }; }
export default pattern<{ tree: Tree }>(({ tree }) => ({
  walked: computed(() => tree.kids.map(walk)),
}));`),
      ).toEqual([]);
    });

    it("reports a callback named only through names that name each other", async () => {
      expect(
        await reportedPaths(`var first = second;
var second = first;
export default pattern(() => ({ note: computed(first) }));`),
      ).toEqual([["note"]]);
    });

    it("reports nothing for a declared field only one arm of a conditional has", async () => {
      expect(
        await reportedPaths(`interface Note { ref: unknown }
function note(): Note { return { ref: 1 }; }
export default pattern<{ flag: boolean }>(({ flag }) => ({
  value: flag ? { note: note() } : {},
}));`),
      ).toEqual([]);
    });

    it("reports a value written into a local after its declaration", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
function note(): { ref: unknown } { return { ref: 1 }; }
export default pattern(() => ({
  result: computed(() => {
    let x = note().ref;
    x = op();
    const p = { x: note().ref };
    p.x = op();
    const xs = [note().ref];
    xs.push(op());
    return { x, p, xs };
  }),
}));`),
      ).toEqual([["result.x", "result.p.x", "result.xs[]"]]);
    });

    it("reports a value a destructuring assignment or a `for…of` loop writes into a local", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
function note(): { ref: unknown } { return { ref: 1 }; }
export default pattern(() => ({
  result: computed(() => {
    let a = note().ref;
    let b = note().ref;
    let o = { ref: note().ref };
    let c = note().ref;
    let rest = [note().ref];
    let { ref: d } = note();
    ({ a, x: b, ...o } = { a: op(), x: op(), ref: op() });
    [c, ...rest] = [op(), op()];
    for (d of [op()]) void d;
    return { a, b, o, c, rest, d };
  }),
}));`),
      ).toEqual([[
        "result.a",
        "result.b",
        "result.o.ref",
        "result.c",
        "result.rest[]",
        "result.d",
      ]]);
    });

    it("reports nothing for a declared value a `delete` takes a part from", async () => {
      expect(
        await reportedPaths(
          `function note(): { ref: unknown; extra?: number } { return { ref: 1 }; }
export default pattern(() => ({
  result: computed(() => {
    const p = { ...note() };
    delete p.extra;
    return p;
  }),
}));`,
        ),
      ).toEqual([]);
    });

    it("reports a destructuring default that is undeclared", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
export default pattern(() => ({
  result: computed(() => {
    const { x = op() } = { x: undefined };
    const [y = op()] = [undefined];
    return { x, y };
  }),
}));`),
      ).toEqual([["result.x", "result.y"]]);
    });

    it("reports a nested destructuring default that is undeclared, and nothing for a declared field at any depth or past a hole", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
function note(): { ref: unknown } { return { ref: 1 }; }
export default pattern<{ pairs: [number, unknown][] }>(({ pairs }) => ({
  seconds: pairs.map(([, second]) => second),
  result: computed(() => {
    const { inner: { ref } } = { inner: note() };
    const { outer: { v } = { v: op() } } = { outer: { v: note().ref } };
    return { ref, v };
  }),
}));`),
      ).toEqual([["result.v"]]);
    });

    it("reports an element or a member read by a key that leads to an undeclared value or that it cannot name", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
function note(): { ref: unknown } { return { ref: 1 }; }
export default pattern<{ k: "a" | "b" }>(({ k }) => ({
  result: computed(() => {
    const refs = [note().ref];
    const byKey = { a: note().ref, b: op() };
    return {
      first: refs[0],
      named: byKey["a"],
      other: byKey["b"],
      dynamic: byKey[k],
    };
  }),
}));`),
      ).toEqual([["result.other", "result.dynamic"]]);
    });

    it("reports an arm of `when()` or `unless()` that is undeclared", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
function note(): { ref: unknown } { return { ref: 1 }; }
export default pattern<{ flag: boolean }>(({ flag }) => ({
  declared: when(flag, note().ref),
  undeclared: unless(flag, op()),
  undeclaredCondition: when(op(), note().ref),
}));`),
      ).toEqual([["undeclared", "undeclaredCondition"]]);
    });

    it("reports a class field whose type is inferred, and nothing for one whose type is written", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
class Inferred { ref = op(); count = 1; }
class Written {
  ref: unknown = 1;
  constructor(public held: unknown) {}
}
class Box<T> { constructor(public value: T) {} }
export default pattern(() => ({
  inferred: new Inferred(),
  written: new Written(2),
  boxed: new Box(op()),
  typed: new Box<unknown>(op()),
}));`),
      ).toEqual([["inferred.ref", "boxed.value"]]);
    });

    it("reports nothing for a value of a recursive type written out", async () => {
      expect(
        await reportedPaths(`type Tree = { ref: unknown } | Tree[];
function tree(): Tree { return [{ ref: 1 }]; }
export default pattern(() => ({ tree: tree() }));`),
      ).toEqual([]);
    });

    it("reports a caught error", async () => {
      expect(
        await reportedPaths(`export default pattern(() => ({
  result: computed(() => {
    try {
      return { error: undefined };
    } catch (error) {
      return { error };
    }
  }),
}));`),
      ).toEqual([["result.error"]]);
    });

    it("reports an undeclared field an optional spread member may not replace", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
function note(): { ref?: unknown } { return {}; }
export default pattern(() => ({ ref: op(), ...note() }));`),
      ).toEqual([["ref"]]);
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
