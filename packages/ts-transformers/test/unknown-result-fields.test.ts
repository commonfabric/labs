import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import ts from "typescript";

import { ELEMENT_POSITIONS } from "../src/core/mod.ts";
import type {
  DeclaredPositions,
  DiagnosticInput,
  PositionKey,
} from "../src/core/mod.ts";
import {
  collectUnknownResultFieldPaths,
  reportUnknownResultFields,
} from "../src/transformers/unknown-result-fields.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { validateFiles, validateSource } from "./utils.ts";

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
 * importing `computed`, `ifElse`, `lift`, `pattern`, `str`, `UI`, `unless`,
 * `when`, and `wish`.
 */
async function reportedPaths(body: string): Promise<string[][]> {
  const { diagnostics } = await validateSource(
    `import { computed, ifElse, lift, pattern, str, UI, unless, when, wish } from "commonfabric";\n${body}`,
    { types: COMMONFABRIC_TYPES },
  );
  return pathsIn(diagnostics);
}

/** The paths each `pattern-result:unknown-type` among `diagnostics` names. */
function pathsIn(
  diagnostics: readonly { type: string; message: string }[],
): string[][] {
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
      const elements = new Map<PositionKey, DeclaredPositions>([
        [ELEMENT_POSITIONS, true],
      ]);

      expect(collectUnknownResultFieldPaths(schema, true)).toEqual([]);
      expect(collectUnknownResultFieldPaths(
        schema,
        new Map<PositionKey, DeclaredPositions>([
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

    it("reports nothing for a field of an input whose type is a generic type with its arguments written", async () => {
      expect(
        await reportedPaths(`interface Box<T> { value: T }
export default pattern<Box<unknown>>((input) => ({ value: input.value }));`),
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
class Maker {
  make() {
    return { held: load() };
  }
}
export default pattern<{ n: number }>(({ n }) => {
  const note: Note = { mention: n };
  const bag: Record<string, unknown> = { a: n };
  return {
    note,
    cast: { v: n } as { v: unknown },
    loaded: load(),
    bag,
    picked: new Maker().make().held,
  };
});`),
      ).toEqual([]);
    });

    it("reports a field whose type was inferred, however a written type reaches it", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
function note(): { ref: unknown } { return { ref: 1 }; }
const sample = { ref: op() };
const holder = { note: note() };
type Sample = typeof sample;
function make() { return { ref: op() }; }
function again(): ReturnType<typeof make> { return make(); }
function aliased(): Sample { return { ref: op() }; }
function held(): typeof holder { return holder; }
class Box { ref = op(); }
class Ring { next!: Link; own = op(); }
class Link { ring!: Ring; own = op(); }
class Holder { inner: typeof sample = sample; }
interface Wrapper { inner: typeof sample }
function wrapper(): Wrapper { return { inner: sample }; }
function identity<T>(x: T): T { return x; }
const key = "k" as string;
const keyed = { [key]: op() };
export default pattern(() => ({
  result: computed(() => {
    const annotated: typeof sample = { ref: op() };
    const nested: { inner: Sample } = { inner: { ref: op() } };
    const joined: Sample & { n: number } = { ref: op(), n: 1 };
    const boxed: Box = new Box();
    const cycle: { link: Link; ring: Ring } = {
      link: new Link(),
      ring: new Ring(),
    };
    const made = wrapper();
    const wrapping = { wrapped: wrapper() };
    const indexed: typeof keyed = keyed;
    const copiedKeys = keyed;
    return {
      annotated, nested, joined, boxed, cycle, indexed, copiedKeys,
      fromMade: made.inner.ref,
      fromMember: wrapping.wrapped.inner.ref,
    };
  }),
  again: again(),
  aliased: aliased(),
  held: held(),
  cast: { ref: op() } as Sample,
  sorted: [{ ref: op() }].sort(),
  member: new Holder().inner.ref,
  generic: identity(wrapper()).inner.ref,
}));`),
      ).toEqual([[
        "result.annotated.ref",
        "result.nested.inner.ref",
        "result.joined.ref",
        "result.boxed.ref",
        "result.cycle.link.ring.own",
        "result.cycle.link.own",
        "result.cycle.ring.next.own",
        "result.cycle.ring.own",
        "result.indexed.*",
        "result.copiedKeys.*",
        "result.fromMade",
        "result.fromMember",
        "again.ref",
        "aliased.ref",
        "cast.ref",
        "sorted[].ref",
        "member",
        "generic",
      ]]);
    });

    it("reports an input field whose type the input's type takes from a value, taken whole or destructured", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
const defaults = { ref: op() };
const Whole = pattern<typeof defaults>((input) => ({ v: input.ref }));
const Destructured = pattern<typeof defaults>(({ ref }) => ({ v: ref }));
const Nested = pattern<{ inner: typeof defaults }>(({ inner }) => ({
  v: inner.ref,
}));
export default pattern<{ ref: unknown; inner: { ref: unknown } }>(
  ({ ref, inner }) => ({ v: ref, w: inner.ref, whole: { Whole, Destructured, Nested } }),
);`),
      ).toEqual([["v"], ["v"], ["v"]]);
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
  bracketed: computed(() => [1]["map"](noteOf)),
  lifted: getNote(1),
}));`),
      ).toEqual([]);
    });

    it("reports what a callback whose return type names a type parameter returns, as its body gives it", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
function inspect(x: unknown): void { void x; }
function identity<T>(x: T): T { return x; }
function inspected<T>(x: T): T {
  inspect(x);
  return x;
}
function reset<T>(x: T): T {
  x = x;
  return x;
}
function relayed<T>(x: T): T {
  return identity<T>(x);
}
function wrap<T>(v: T): { v: T } {
  return { v };
}
interface Box<T> { value: T }
function box<T>(value: T): Box<T> {
  return { value };
}
export default pattern<{ refs: unknown[] }>(({ refs }) => ({
  declared: refs.map(identity),
  undeclared: [op()].map(identity),
  escaped: [op()].map(inspected),
  reassigned: refs.map(reset),
  wrapped: computed(() => {
    const w = wrap(op());
    return w;
  }),
  boxed: computed(() => {
    const b = box(op());
    return b;
  }),
  cloned: [op()].map(structuredClone),
  relayed: [op()].map(relayed),
}));`),
      ).toEqual([[
        "undeclared[]",
        "escaped[]",
        "reassigned[]",
        "wrapped.v",
        "boxed.value",
        "cloned[]",
        "relayed[]",
      ]]);
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
const lifts = { getNote: lift((n: number): Note => ({ ref: n })) };
const { getNote: picked } = lifts;
const { toNote: pickedCallback } = { toNote: (): Note => ({ ref: 1 }) };
export default pattern(() => ({
  written: computed(() => {
    let toNote = (n: number): Note => ({ ref: n });
    toNote = () => ({ ref: op() });
    return [1].map(toNote);
  }),
  member: lifts.getNote(1),
  destructured: picked(1),
  destructuredCallback: computed(pickedCallback),
}));`),
      ).toEqual([[
        "written[].ref",
        "member.ref",
        "destructured.ref",
        "destructuredCallback.ref",
      ]]);
    });

    it("reports what a callback reads from a parameter the trace does not bind", async () => {
      expect(
        await reportedPaths(
          `function note(): { ref: unknown } { return { ref: 1 }; }
export default pattern(() => ({
  unbound: computed(() => [note().ref].map((x, i, all) => all[0])),
  destructured: computed(() =>
    [note().ref].map((x, i, [first]) => first)
  ),
}));`,
        ),
      ).toEqual([["unbound[]", "destructured[]"]]);
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
        await reportedPaths(`function op(): unknown { return 1; }
export default pattern(() => ({
  notes: computed(() => {
    var first: (n: unknown) => unknown = second;
    var second: (n: unknown) => unknown = first;
    return [op()].map(first);
  }),
}));`),
      ).toEqual([["notes[]"]]);
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

    it("reports the structure of a literal a local holds, however it may change, and of an inline literal whose accessor uses `this`", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
function note(): { ref: unknown } { return { ref: 1 }; }
export default pattern<{ notes: { ref: unknown }[] }>(({ notes }) => ({
  result: computed(() => {
    const box = { inner: { ref: note().ref } };
    const { inner } = box;
    inner.ref = op();
    const xs = [note().ref];
    xs["push"](op());
    const p = { ref: note().ref };
    const holder = [p];
    holder[0].ref = op();
    const q = { ref: note().ref };
    Reflect.set(q, "ref", op());
    const aliased = { ref: note().ref };
    const get = () => {
      const alias = aliased;
      return alias;
    };
    get().ref = op();
    const accumulated = { ref: note().ref };
    [1].reduce((acc) => {
      acc.ref = op();
      return acc;
    }, accumulated);
    const receiver = { ref: note().ref };
    [1].forEach(function (this: { ref: unknown }) {
      this.ref = op();
    }, receiver);
    const touched = {
      ref: note().ref,
      get touch(): number {
        this.ref = op();
        return 0;
      },
    };
    void touched.touch;
    const mapped = [note().ref].map((r) => r);
    mapped.push(op());
    const merged = Object.assign({}, note(), { extra: op() });
    const echoed = notes.map((n) => ({ ref: n.ref }));
    echoed.push({ ref: op() });
    return {
      box, xs, p, q, aliased, accumulated, receiver, touched, mapped, merged,
      echoed,
      inline: {
        ref: note().ref,
        get touch(): number {
          this.ref = op();
          return 0;
        },
      },
    };
  }),
}));`),
      ).toEqual([[
        "result.box.inner.ref",
        "result.xs[]",
        "result.p.ref",
        "result.q.ref",
        "result.aliased.ref",
        "result.accumulated.ref",
        "result.receiver.ref",
        "result.touched.ref",
        "result.mapped[]",
        "result.merged.extra",
        "result.echoed[].ref",
        "result.inline.ref",
      ]]);
    });

    it("reports the structure of a literal a local holds, and nothing a written type, another pattern, or a reactive value declares through one", async () => {
      expect(
        await reportedPaths(`interface Out { mentions: unknown[] }
const Sub = pattern<{ seed: string }, Out>(() => ({ mentions: [] }));
function op(): unknown { return 1; }
interface Note { ref: unknown }
function note(): Note { return { ref: 1 }; }
function loose(): { ref: unknown } { return { ref: 1 }; }
export default pattern<{ seed: string }>(({ seed }) => {
  const literal = { ref: note().ref };
  const copied = { ...note() };
  const typed = note();
  const viaTypeLiteral = loose();
  const annotated: Note = { ref: note().ref };
  const instance = Sub({ seed });
  const derived = computed(() => ({ ref: note().ref }));
  const shown = when(seed, { ref: note().ref });
  const list = computed(() => [{ ref: note().ref }]);
  const listed = list.map((item) => ({ item }));
  const wrapped = { note: note() };
  const wrappedList = [{ note: note() }];
  const mixed = { bad: op(), note: note() };
  return {
    literal, copied, typed, viaTypeLiteral, annotated, instance, derived,
    shown, listed, wrapped, wrappedList, mixed,
    fromGetter: {
      get ref() {
        return note().ref;
      },
    },
  };
});`),
      ).toEqual([["literal.ref", "mixed.bad"]]);
    });

    it("reports nothing for another pattern's instance or a computed's result passed to a function, which can change neither", async () => {
      expect(
        await reportedPaths(`interface Out { mentions: unknown[] }
const Sub = pattern<{ seed: string }, Out>(() => ({ mentions: [] }));
function note(): { ref: unknown } { return { ref: 1 }; }
function inspect(value: unknown): number { return value ? 1 : 0; }
export default pattern<{ seed: string }>(({ seed }) => {
  const subject = Sub({ seed });
  const derived = computed(() => ({ ref: note().ref }));
  return {
    subject,
    derived,
    inspected: computed(() => inspect(subject) + inspect(derived)),
  };
});`),
      ).toEqual([]);
    });

    it("reports nothing for a value passed to another pattern, `ifElse()`, `when()`, or a lift whose parameter's type is written", async () => {
      expect(
        await reportedPaths(`interface Out { mentions: unknown[] }
const Sub = pattern<{ item: { ref: unknown } }, Out>(() => ({ mentions: [] }));
function note(): { ref: unknown } { return { ref: 1 }; }
const keep = lift((x: { ref: unknown }) => x);
export default pattern<{ flag: boolean }>(({ flag }) => ({
  sub: Sub({ item: { ref: note().ref } }),
  picked: ifElse(flag, { ref: note().ref }, { ref: note().ref }),
  shown: when(flag, { ref: note().ref }),
  kept: keep({ ref: note().ref }),
  inline: lift((x: { ref: unknown }) => x)({ ref: note().ref }),
}));`),
      ).toEqual([]);
    });

    it("reports a value written in the module that defines a lift it imports", async () => {
      const { diagnostics } = await validateFiles({
        "/helper.ts": `import { lift } from "commonfabric";
function op(): unknown { return 1; }
function note(): { ref: unknown } { return { ref: 1 }; }
export const make = lift((n: number) => {
  let x = note().ref;
  x = op();
  return { x, n };
});`,
        "/test.tsx": `import { pattern } from "commonfabric";
import { make } from "./helper.ts";
export default pattern(() => ({ result: make(1) }));`,
      }, { types: COMMONFABRIC_TYPES });

      expect(pathsIn(diagnostics)).toEqual([["result.x"]]);
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

    it("reports a callback parameter holding a literal's structure, and nothing for one holding a value whose type is written, however it changes", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note { ref: unknown }
function note(): Note { return { ref: 1 }; }
export default pattern<{ notes: Note[] }>(({ notes }) => ({
  typed: computed(() => notes.map((n: Note) => { n.ref = op(); return n; })),
  untyped: computed(() => notes.map((n) => { n.ref = op(); return n; })),
  reassigned: computed(() => notes.map((n) => { n = { ref: op() }; return n; })),
  literal: computed(() =>
    [{ ref: note().ref }].map((n) => { n.ref = op(); return n; })
  ),
  kept: computed(() =>
    [{ ref: note().ref }].filter((n) => { n.ref = op(); return true; })
  ),
  found: computed(() =>
    [{ ref: note().ref }].find((n) => { n.ref = op(); return true; })
  ),
  sorted: computed(() =>
    [{ ref: note().ref }].toSorted((a) => { a.ref = op(); return 0; })
  ),
  filtered: computed(() => {
    const kept = [note(), note()].filter((n) => !!n);
    return kept;
  }),
}));`),
      ).toEqual([[
        "literal[].ref",
        "kept[].ref",
        "found.ref",
        "sorted[].ref",
      ]]);
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
  result: computed(() => ({
    first: [note().ref][0],
    named: { "[]": note().ref, a: note().ref, b: op() }["a"],
    other: { "[]": note().ref, a: note().ref, b: op() }["b"],
    dynamic: { a: note().ref, b: op() }[k],
  })),
}));`),
      ).toEqual([["result.other", "result.dynamic"]]);
    });

    it("reports a member read by name that a value may hold under a key the trace cannot name, unless a name written after that key replaces it", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
function note(): { ref: unknown } { return { ref: 1 }; }
interface Note { ref: unknown }
function typedNote(): Note { return { ref: 1 }; }
export default pattern<{ k: string }>(({ k }) => ({
  result: computed(() => {
    const bag = { [k]: { ref: op() }, note: typedNote() };
    const copy = { ...bag };
    return {
      named: { [k]: op() }.foo,
      spread: { ...Object.fromEntries([["a", op()]]) }.a,
      shadowed: { a: note().ref, [k]: op() }.a,
      replaced: { [k]: op(), a: note().ref }.a,
      spreadCopy: { ...{ [k]: { ref: op() }, note: typedNote() } }.note,
      localCopy: copy.note,
    };
  }),
}));`),
      ).toEqual([["result.named", "result.spread", "result.shadowed"]]);
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

    it("reports a class field whose type is inferred, and nothing for one whose type is written, at the construction or in an `extends` clause", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
class Inferred { ref = op(); count = 1; }
class Written {
  ref: unknown = 1;
  constructor(public held: unknown) {}
}
class Box<T> { constructor(public value: T) {} }
class RefBox extends Box<unknown> {}
class PassedBox<U> extends Box<U> {}
class CountedBox<U> extends Box<unknown> {
  constructor(value: unknown, public count: U) {
    super(value);
  }
}
const Aliased = RefBox;
const Anonymous = class extends Box<unknown> {};
class DefaultBox<T = unknown> {
  constructor(public value: T) {}
}
class Defaulted extends DefaultBox {}
class Chosen<T = unknown> {
  constructor(public value: T = undefined as T) {}
}
function load(): { ref: unknown } { return { ref: 1 }; }
class Loaded { held = load(); }
export default pattern(() => ({
  inferred: new Inferred(),
  written: new Written(2),
  boxed: new Box(op()),
  typed: new Box<unknown>(op()),
  extended: new RefBox(op()),
  passed: new PassedBox(op()),
  counted: new CountedBox(op(), 1),
  aliased: new Aliased(op()),
  anonymous: new Anonymous(op()),
  defaulted: new Defaulted(op()),
  chosen: new Chosen(),
  supplied: new Chosen(op()),
  loaded: new Loaded(),
}));`),
      ).toEqual([[
        "inferred.ref",
        "boxed.value",
        "passed.value",
        "supplied.value",
      ]]);
    });

    it("reports nothing for a value of a recursive type written out", async () => {
      expect(
        await reportedPaths(`import { Confidential } from "commonfabric";
type Tree = { ref: unknown } | Tree[];
function tree(): Tree { return [{ ref: 1 }]; }
type Nest<T> = Confidential<{ v: T; ref: unknown; inner?: Nest<T[]> }, ["secret"]>;
function nest(): Nest<string> { return { v: "", ref: 1 }; }
export default pattern(() => ({
  tree: tree(),
  forest: computed(() => {
    const forest = [tree(), tree()];
    return forest;
  }),
  nested: nest(),
}));`),
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
