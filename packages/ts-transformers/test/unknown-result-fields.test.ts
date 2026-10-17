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
    bracketed: input.xs["map"]((x) => ({ r: x.ref })),
    echo: input,
  }),
);`,
        ),
      ).toEqual([]);
    });

    it("reports nothing for a field of an input whose type is a generic type with its arguments written", async () => {
      expect(
        await reportedPaths(`import type { Default } from "commonfabric";
interface Box<T> { value: T }
interface Shelf<T> { notes: T[]; bag: Record<string, T>; one: T }
const Whole = pattern<Box<unknown>>((input) => ({ value: input.value }));
export default pattern<{ box: Box<unknown>; shelf: Default<Shelf<unknown>> }>(
  ({ box, shelf }) => ({ value: box.value, shelf, whole: Whole }),
);`),
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

    it("reports nothing for a type an author wrote, however a local holds it or a call passes it on, and reports one inferred from an undeclared value", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function bag(): Record<string, unknown> { return { a: 1 }; }
function identity<T>(x: T): T { return x; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function helper(early = false) {
  const unused = () => ({ note: wrap(op()) });
  void unused;
  if (early) {
    return { note: makeNote() };
  }
  return { note: makeNote() };
}
function viaLocal() {
  const made = makeNote();
  return made;
}
interface Shelf { note: Note<unknown> }
function shelf(): Shelf { return { note: makeNote() }; }
function labeled<T>(x: T, label = ""): T {
  void label;
  return x;
}
function passOn<T>(x: T) {
  return x;
}
function boxOn<T>(x: T) {
  return { inner: x };
}
function boxVia<T>(x: T) {
  const local = { inner: x };
  return local;
}
function swap<T>(x: T, y: T) {
  x = y;
  return x;
}
function apply<T>(fn: () => T): T {
  return fn();
}
function maker(): Note<unknown> {
  return { ref: op() };
}
const makers = { maker };
class Maker { make() { return { held: makeNote() }; } }
class Box<T> { constructor(public ref: T) {} }
class Defaulted<T = unknown> { ref!: T; }
class Holder { inner = makeNote(); }
class Chain {
  next = Chain.make();
  static make() { return new Chain(); }
}
const holder = { note: makeNote() };
export default pattern(() => {
  const derived = computed(() => makeNote());
  const heldDerived = { d: derived };
  return {
    result: computed(() => {
      const wrapped = { note: makeNote() };
      const listed = [makeNote()];
      const bagged = { bag: bag() };
      const boxed = { box: new Box<unknown>(1) };
      const defaulted = { box: new Defaulted() };
      const helped = { w: helper() };
      const made = { w: new Maker().make() };
      const identified = { n: identity(makeNote()) };
      const annotated: Holder = new Holder();
      const typed: typeof holder = holder;
      let reassigned = { note: makeNote() };
      reassigned = { note: makeNote() };
      const flag = [1].length > 0;
      const chosen = flag ? { note: makeNote() } : { note: makeNote() };
      const fallback = { note: [makeNote()][0] ?? makeNote() };
      const grouped = ({ note: makeNote() });
      const checked = { note: makeNote() } satisfies { note: Note<unknown> };
      const counted = { note: makeNote(), total: [1].length + 1 };
      let { note: kept = makeNote() } = { note: makeNote() };
      kept = makeNote();
      const accessor = {
        get note(): Note<unknown> {
          return makeNote();
        },
      };
      const passed = { n: labeled(makeNote(), "x") };
      const constant = { note: makeNote() } as const;
      const shelved = { n: shelf().note };
      const local = { w: viaLocal() };
      const recast = { note: wrap(op()) as Note<unknown> };
      const lifted = { r: makeNote().ref };
      const inferred = { note: wrap(op()) };
      const pair = { a: boxVia(makeNote()), b: boxVia(wrap(op())) };
      return {
        wrapped, listed, bagged, boxed, defaulted, helped, made, identified,
        annotated, typed, reassigned, chosen, fallback, grouped, checked,
        counted, kept, accessor, passed, constant, shelved, local, recast,
        lifted, inferred, pair,
      };
    }),
    heldDerived,
    holder: new Holder(),
    chain: new Chain(),
    inlineHelper: helper(),
    inlineIdentity: identity(makeNote()),
    inlineInferred: wrap(op()),
    boxInferred: new Box(op()),
    passedOn: passOn(makeNote()),
    boxedOn: boxOn(makeNote()),
    passedInferred: passOn(wrap(op())),
    swapped: swap(makeNote(), wrap(op())),
    applied: apply(maker),
    appliedMember: apply(makers.maker),
    appliedInferred: apply(() => wrap(op())),
  };
});`),
      ).toEqual([[
        "result.lifted.r",
        "result.inferred.note.ref",
        "result.pair.b.inner.ref",
        "inlineInferred.ref",
        "boxInferred.ref",
        "passedInferred.ref",
        "swapped.ref",
        "appliedInferred.ref",
      ]]);
    });

    it("reports an input field whose type the input's type takes from a value, taken whole or destructured", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
const defaults = { ref: op() };
class Box<T> { constructor(public ref: T) {} }
const sample = new Box(op());
const Whole = pattern<typeof defaults>((input) => ({ v: input.ref }));
const Boxed = pattern<{ inner: typeof sample }>((input) => ({
  v: input.inner.ref,
}));
const Instance = pattern<typeof sample>((input) => ({ v: input.ref }));
const Destructured = pattern<typeof defaults>(({ ref }) => ({ v: ref }));
const Nested = pattern<{ inner: typeof defaults }>(({ inner }) => ({
  v: inner.ref,
}));
export default pattern<{ ref: unknown; inner: { ref: unknown } }>(
  ({ ref, inner }) => ({
    v: ref,
    w: inner.ref,
    whole: { Whole, Destructured, Nested, Boxed, Instance },
  }),
);`),
      ).toEqual([["v"], ["v"], ["v"], ["v"], ["v"]]);
    });

    it("reports nothing for another pattern's result or a typed `wish()`", async () => {
      expect(
        await reportedPaths(`interface Out { mentions: unknown[] }
function op(): unknown { return 1; }
const sample = { ref: op() };
interface Held { holder: typeof sample }
const Sub = pattern<{ seed: string }, Out>(() => ({ mentions: [] }));
const Holding = pattern<{ seed: string }, Held>(() => ({ holder: sample }));
export default pattern<{ seed: string }>(({ seed }) => ({
  subject: Sub({ seed }),
  holding: Holding({ seed }),
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

    it("reports a callback reassigned after its declaration, or a callback or a lift read from an object, only where its return type is not written", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note { ref: unknown }
function note(): Note { return { ref: 1 }; }
const lifts = {
  getNote: lift((n: number): Note => ({ ref: n })),
  getLoose: lift((n: number) => ({ ref: op(), n })),
};
const { getNote: picked } = lifts;
const { toNote: pickedCallback } = { toNote: (): Note => ({ ref: 1 }) };
const { toLoose: pickedLoose } = { toLoose: () => ({ ref: op() }) };
export default pattern(() => ({
  written: computed(() => {
    let toNote = (n: number): Note => ({ ref: n });
    toNote = () => ({ ref: op() });
    return [1].map(toNote);
  }),
  loose: computed(() => {
    let toLoose = (n: number) => ({ ref: n as unknown });
    toLoose = () => ({ ref: op() });
    return [1].map(toLoose);
  }),
  traced: computed(() => {
    let fromNote = (n: number) => ({ ref: note().ref, n });
    fromNote = () => ({ ref: op(), n: 0 });
    return [1].map(fromNote);
  }),
  member: lifts.getNote(1),
  looseMember: lifts.getLoose(1),
  destructured: picked(1),
  destructuredCallback: computed(pickedCallback),
  looseCallback: computed(pickedLoose),
}));`),
      ).toEqual([[
        "loose[].ref",
        "traced[].ref",
        "looseMember.ref",
        "looseCallback.ref",
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
const sample = { ref: op() };
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
      fromSelf: {
        held: note(),
        get touch(): number {
          this.held = note();
          return 0;
        },
      }.held,
      shapedSelf: {
        get shaped(): typeof sample {
          return sample;
        },
        get touch(): number {
          void this.shaped;
          return 0;
        },
      }.shaped,
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
        "result.shapedSelf.ref",
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
const key = "item";
function pickItem() {
  const held = { item: { ref: op() } };
  return held[key];
}
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function pickNamed() {
  const held = { a: makeNote(), b: wrap(op()) };
  return held["a"];
}
export default pattern<{ k: "a" | "b" }>(({ k }) => ({
  result: computed(() => ({
    first: [note().ref][0],
    named: { "[]": note().ref, a: note().ref, b: op() }["a"],
    other: { "[]": note().ref, a: note().ref, b: op() }["b"],
    dynamic: { a: note().ref, b: op() }[k],
  })),
  aliased: computed(() => {
    const held = { item: { ref: op() } };
    const picked = held[key];
    return picked;
  }),
  either: computed(() => {
    const held = { a: { ref: op() }, b: note() };
    const picked = held[k];
    return picked;
  }),
  literal: computed(() => {
    const held = { a: note(), b: { ref: op() } };
    const picked = held["a"];
    return picked;
  }),
  helped: pickItem(),
  named: pickNamed(),
}));`),
      ).toEqual([[
        "result.other",
        "result.dynamic",
        "aliased.ref",
        "either.ref",
        "helped.ref",
      ]]);
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
class Named<T = unknown> {
  ref!: T;
  constructor(public name: string) {}
}
class Labeled<T = unknown> {
  ref!: T;
  constructor(public label = "x") {}
}
class Pair<T = unknown, U = T> {
  first!: T;
  second!: U;
}
class Shaped<T = unknown, U = { ref: T }> {
  inner!: U;
}
class Linked<T, U = T> {
  second!: U;
  constructor(public first: T) {}
}
class Base<V> {
  constructor(public held: V) {}
}
class Derived<T = unknown> extends Base<T> {}
class Spread<T = unknown> {
  constructor(public name: string, public ref: T) {}
}
const spreadArgs: [string, unknown] = ["x", op()];
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
  named: new Named("x"),
  labeled: new Labeled("y"),
  pair: new Pair(),
  shaped: new Shaped(),
  linked: new Linked(op()),
  derived: new Derived(op()),
  spread: new Spread(...spreadArgs),
}));`),
      ).toEqual([[
        "inferred.ref",
        "boxed.value",
        "passed.value",
        "supplied.value",
        "linked.second",
        "linked.first",
        "derived.held",
        "spread.ref",
      ]]);
    });

    it("binds a call's type parameter from its best-priority candidates, then its default, then its constraint", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function orNull<T>(a: T, b: T | null): T { return b ?? a; }
function partly<T>(a: T, b: Partial<T>): T { return b ? a : a; }
function blocked<T>(a: T, b: NoInfer<T>): T { return b ? a : a; }
function constrained<T extends Note<unknown>>(): T { return makeNote() as T; }
function only<T>(f: (x: T) => void): T { void f; return null as T; }
function branch<T>(x: T extends string ? never : T): T { return x as T; }
const contravariant = only((x: Note<unknown>) => void x);
export default pattern(() => ({
  orNull: orNull(makeNote(), wrap(op())),
  partly: partly(makeNote(), { ref: op() }),
  blocked: blocked(makeNote(), makeNote()),
  constrained: constrained(),
  contravariant: { inner: contravariant },
  branch: branch(makeNote()),
  orNullInferred: orNull(wrap(op()), makeNote()),
  blockedInferred: blocked(wrap(op()), makeNote()),
  branchInferred: branch(wrap(op())),
}));`),
      ).toEqual([[
        "orNull.ref",
        "orNullInferred.ref",
        "blockedInferred.ref",
        "branchInferred.ref",
      ]]);
    });

    it("keeps the candidates the checker keeps, whatever order the arguments come in", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
class Box<T> { constructor(public ref: T) {} }
const sample = new Box(op());
function nullFirst<T>(b: T | null, a: T): T { return b ?? a; }
function blocked<T>(a: T, b: NoInfer<T>): T { return b ? a : a; }
function both<T>(x: T, f: (v: T) => void): T { return f ? x : x; }
function free<T extends unknown>(): T { return null as T; }
function firstAll<T>(...xs: T[]) { return xs[0]; }
function split<T, U>(x: U[] | T): { t: T; u: U } {
  return {} as { t: T; u: U };
}
function pickU<T>(x: T[] | T): T { return Array.isArray(x) ? x[0] : x; }
type Maybe<T> = T | null;
function pickM<T>(a: Maybe<T>, b: T | null): T { return (a ?? b)!; }
const maybe: Maybe<Note<unknown>> = makeNote();
const looseList = [wrap(op())];
const bothValue = both(makeNote(), (v: typeof sample) => void v);
function only<T>(f: (x: T) => void): T { void f; return null as T; }
const thisValue = only(function (this: void, x: typeof sample) { void x; });
function freeNote<T extends unknown>(): Note<T> { return { ref: null as T }; }
function partialFirst<T>(b: Partial<T>, a: T): T { return b ? a : a; }
function selfOf<T>(this: T): T { return this; }
class Carrier<T> {
  selfOf = selfOf;
  constructor(public ref: T) {}
}
const carrier = new Carrier(makeNote());
function either<T>(x: T | Box<unknown>, y: T): T { return y ?? x; }
function inner<T>(x: { v: T } | T, y: T): T { return y ?? x; }
function intersected<T>(x: T & { n: number }): T { return x; }
function narrowed<T>(x: T extends object ? T : never): T { return x as T; }
export default pattern(() => ({
  nullFirst: nullFirst(wrap(op()), makeNote()),
  blocked: blocked(makeNote(), wrap(op())),
  both: bothValue,
  free: { v: free() },
  spread: firstAll(...looseList),
  split: split([makeNote()]),
  single: pickU(wrap(op())),
  aliased: pickM(maybe, wrap(op())),
  thisCallback: { v: thisValue },
  freeNote: freeNote(),
  partialFirst: partialFirst({ ref: op() }, makeNote()),
  carried: carrier.selfOf().ref,
  closeMatch: either(sample, makeNote()),
  matched: inner({ v: makeNote(), ref: op() }, makeNote()),
  intersected: intersected({ ...makeNote(), n: 1 }),
  narrowed: narrowed(makeNote()),
}));`),
      ).toEqual([[
        "nullFirst.ref",
        "free.v",
        "spread.ref",
        "single.ref",
        "aliased.ref",
        "thisCallback.v.ref",
        "freeNote.ref",
      ]]);
    });

    it("binds a field's written type as written, so a call returning it whole declares nothing, and follows a callback or a class however it is written", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function note(): { ref: unknown } { return { ref: 1 }; }
function idField<T>(n: Note<T>): T { return n.ref; }
function getA<T>(o: { a: T }): T { return o.a; }
function getU<T>(o: { u: T }): T { return o.u; }
function first<T>(xs: readonly T[]) { return xs[0]; }
function run<T>(options: { make: () => T }): T { return options.make(); }
function build<T>(C: new () => T): T { return new C(); }
function opened<T>(n: Note<T>) { return { inner: n.ref }; }
function getRef<T>({ ref }: { ref: T }) { return { ref }; }
function boxOn<T>(x: T) { return wrap(x); }
class Defaulted<T = Note<unknown>> { value!: T; }
const NoteMaker: new () => Note<unknown> = class { ref: unknown = 1; };
const bagUnknown: { [key: string]: unknown } = {};
const holder: { list: unknown[] } = { list: [] };
const field: { u: unknown } = { u: 1 };
const viaTypeof: typeof field = field;
const eitherMaker: (() => Note<unknown>) | (() => Note<unknown>) = makeNote;
const flag = [1].length > 0;
export default pattern(() => ({
  whole: { v: idField(makeNote()) },
  indexed: { v: getA(bagUnknown) },
  element: { v: first(holder.list) },
  typeofField: { v: getU(viaTypeof) },
  cast: opened(wrap(op()) as Note<unknown>),
  constructed: build(NoteMaker),
  defaulted: build(Defaulted),
  union: run({ make: eitherMaker }),
  either: computed(() => run(flag ? { make: makeNote } : { make: makeNote })),
  destructured: getRef(note()),
  passedOn: boxOn(makeNote().ref),
}));`),
      ).toEqual([["whole.v", "indexed.v", "element.v", "typeofField.v"]]);
    });

    it("reads a tuple argument, a tuple spread, and a rest tuple slot by slot", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function firstOf<T, U>(pair: [T, U]): T { return pair[0]; }
function firstHeld<T, U>(pair: readonly [T, U]): T { return pair[0]; }
function firstPassed<T, U>(a: T, b: U): T { return b ? a : a; }
function firstRest<T, U>(...args: [T, U]): T { return args[0]; }
const args: [Note<unknown>, unknown] = [makeNote(), op()];
const held = [makeNote(), op()] as const;
const loose = [wrap(op()), makeNote()] as const;
export default pattern(() => ({
  pair: firstOf([makeNote(), op()]),
  held: firstHeld(held),
  spread: firstPassed(...args),
  rest: firstRest(makeNote(), op()),
  pairInferred: firstOf([wrap(op()), 1]),
  spreadInferred: firstPassed(...loose),
  restInferred: firstRest(wrap(op()), 1),
}));`),
      ).toEqual([[
        "pairInferred.ref",
        "spreadInferred.ref",
        "restInferred.ref",
      ]]);
    });

    it("reads a parameter's type by its members, inherited ones included, its signatures, and the type arguments of an instance the argument makes", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
interface Parent<T> { value: T }
interface Child<T> extends Parent<T> {}
function inherited<T>(x: Child<T>): T { return x.value; }
function via<T>(o: { get(): T }): T { return o.get(); }
class Maker { ref: unknown = 1; }
class Loose { ref = op(); }
function build<T>(C: new () => T): T { return new C(); }
function recordOf<K extends string, T>(r: Record<K, T>): T {
  return Object.values(r)[0] as T;
}
function mapped<T>(m: Map<string, T>) { return m.get("a")!; }
const viaLoose = via({ get: () => wrap(op()) });
export default pattern(() => ({
  inherited: inherited({ value: makeNote() }),
  via: via({ get: makeNote }),
  built: build(Maker),
  record: recordOf({ a: makeNote() }),
  mapped: mapped(new Map([["a", makeNote()]])),
  inheritedInferred: inherited({ value: wrap(op()) }),
  viaInferred: viaLoose,
  builtInferred: build(Loose),
  recordInferred: recordOf({ a: wrap(op()) }),
  mappedInferred: mapped(new Map([["a", wrap(op())]])),
}));`),
      ).toEqual([[
        "inheritedInferred.ref",
        "viaInferred.ref",
        "builtInferred.ref",
        "recordInferred.ref",
        "mappedInferred.ref",
      ]]);
    });

    it("follows an argument or a receiver through bindings, annotations, members, and calls to where its parts were written", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function load<T>(opts: { load: () => T }): T { return opts.load(); }
interface Load<T> { load: () => T }
function loadVia<T>(opts: Load<T>): T { return opts.load(); }
class Holder<T> {
  constructor(public value: T) {}
  read(): T { return this.value; }
}
class Child<T> extends Holder<T> {}
type H<T> = Holder<T>;
function holder() { return new Holder(makeNote()); }
const opts = { load: makeNote };
const annotated: { load: () => Note<unknown> } = { load: makeNote };
const viaInterface: Load<Note<unknown>> = { load: makeNote };
const looseOpts = { load: () => wrap(op()) };
const child = new Child(makeNote());
const aliased: H<Note<unknown>> = new Holder(makeNote());
const member = { holder: new Holder(makeNote()) };
const looseMember = { holder: new Holder(wrap(op())) };
export default pattern(() => ({
  opts: load(opts),
  annotated: load(annotated),
  viaInterface: loadVia(viaInterface),
  child: child.read(),
  aliased: aliased.read(),
  member: member.holder.read(),
  called: holder().read(),
  optsInferred: load(looseOpts),
  memberInferred: looseMember.holder.read(),
}));`),
      ).toEqual([["optsInferred.ref", "memberInferred.ref"]]);
    });

    it("follows an argument to where each of its parts was written, however the argument is written", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function passOn<T>(x: T) { return x; }
function opened<T>(note: Note<T>) { return { inner: note.ref }; }
function first<T>(xs: readonly T[]) { return xs[0]; }
function firstAll<T>(...xs: T[]) { return xs[0]; }
function keyed<T>(bag: { [key: string]: T }) { return bag.a; }
function byIndex<T>(xs: { [index: number]: T }): T { return xs[0]!; }
function via<T>(o: { get(): T }): T { return o.get(); }
function valueOf<T>(o: { readonly value: T }): T { return o.value; }
function build<T>(C: new () => T): T { return new C(); }
function mapped<T>(m: Map<string, T>) { return m.get("a")!; }
function pickU<T>(x: T[] | T): T { return Array.isArray(x) ? x[0] : x; }
function setAt<T, K extends keyof T>(o: T, k: K, v: T[K]): T {
  return k && v ? o : o;
}
type Pair<T> = { left: T; right: number };
function left<T>(p: Pair<T>) { return p.left; }
function makePair(): Pair<Note<unknown>> { return { left: makeNote(), right: 1 }; }
interface Repo<T> { get(): T }
class Maker { ref: unknown = 1; }
class OtherMaker { ref: unknown = 2; }
enum Mode { On }
const modes: { [key: string]: Mode } = {};
const flag = [1].length > 0;
const list = [makeNote()];
const annotated: Array<Note<unknown>> = [makeNote()];
const frozen: readonly Note<unknown>[] = [makeNote()];
const wrapped: (Note<unknown>) = makeNote();
const bag: { [key: string]: Note<unknown> } = {};
const literalTyped: { a: Note<unknown> } = { a: makeNote() };
const getter: { get(): Note<unknown> } = { get: makeNote };
const repo: Repo<Note<unknown>> = { get: makeNote };
const Ctor: new () => Maker = Maker;
const maybeNote: Note<unknown> | undefined = makeNote();
type Maybe<T> = T | null;
function unmaybe<T>(m: Maybe<T>): T { return m!; }
const maybe: Maybe<Note<unknown>> = makeNote();
interface Picked extends Pick<Note<unknown>, "ref"> {}
const picked: Picked = { ref: 1 };
const viaMethod = via({ get() { return makeNote(); } });
const viaGetter = valueOf({ get value() { return makeNote(); } });
export default pattern<{ s: string }>(({ s }) => ({
  satisfied: opened(makeNote() satisfies Note<unknown>),
  spreadList: firstAll(...list),
  arrayAnnotated: first(annotated),
  readonlyAnnotated: first(frozen),
  parenthesized: opened(wrapped),
  indexed: keyed(bag),
  anyMember: keyed(literalTyped),
  byIndex: byIndex([makeNote()]),
  byIndexAnnotated: byIndex(annotated),
  byIndexReadonly: byIndex(frozen),
  modes: keyed(modes),
  emptyBag: { v: keyed({}) },
  emptyIndex: { v: byIndex([]) },
  unionedIndex: keyed(flag ? { a: makeNote() } : { a: makeNote() }),
  unionedArray: pickU(flag ? [makeNote()] : makeNote()),
  indexedTarget: setAt(makeNote(), "ref", op()),
  builtEither: build(flag ? Maker : OtherMaker),
  nullable: opened(maybeNote!),
  aliasArgument: unmaybe(maybe),
  picked: opened(picked),
  methodSignature: via(getter),
  interfaceMethod: via(repo),
  constructorType: build(Ctor),
  method: viaMethod,
  getter: viaGetter,
  aliasResult: left(makePair()),
  typedMap: mapped(new Map<string, Note<unknown>>()),
  spreadLiteral: opened({ ...makeNote() }),
  castTypeof: opened(wrapped as typeof wrapped),
  none: passOn(undefined),
  chosen: computed(() => passOn(flag ? makeNote() : wrap(op()))),
  dynamic: computed(() => passOn({ a: makeNote(), b: wrap(op()) }[s])),
  byIndexInferred: byIndex([wrap(op())]),
}));`),
      ).toEqual([[
        "emptyBag.v",
        "chosen.ref",
        "dynamic.ref",
        "byIndexInferred.ref",
      ]]);
    });

    it("reads every kind of parameter type the checker infers through: the receiver, keys, templates, a value or its thunk, and a generic rest", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function self<T>(this: T): T { return this; }
const holder = { n: makeNote(), self };
const looseHolder = { n: wrap(op()), self };
function pickKey<T>(o: T, k: keyof T): T { return k ? o : o; }
function tagged<T extends string>(x: \`id-\${T}\`): T { return x.slice(3) as T; }
function lazy<T>(x: T | (() => T)): T {
  return typeof x === "function" ? (x as () => T)() : x;
}
function collect<T extends unknown[]>(...args: T): T { return args; }
const lazyLoose = lazy(() => wrap(op()));
function renamedIn<T>(r: { [K in keyof T as \`x_\${string & K}\`]: T[K] }): T {
  return r as unknown as T;
}
export default pattern(() => ({
  self: holder.self().n,
  key: pickKey(makeNote(), "ref"),
  tag: tagged("id-a"),
  lazyValue: lazy(makeNote()),
  lazyThunk: lazy(makeNote),
  selfInferred: looseHolder.self().n,
  lazyInferred: lazyLoose,
  collected: collect(makeNote(), op()),
  remapped: { v: renamedIn({ x_ref: makeNote() }) },
}));`),
      ).toEqual([[
        "selfInferred.ref",
        "lazyInferred.ref",
        "collected[]",
        "remapped.v",
      ]]);
    });

    it("reads an indexed access type by each key its index type's literals name", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
const sample = { a: makeNote(), b: makeNote(), bad: wrap(op()) };
type Key = "a";
function one(): (typeof sample)[Key] { return sample.a; }
function either(): (typeof sample)["a" | "b"] { return sample.a; }
function any(): (typeof sample)["a" | "bad"] { return sample.a; }
function wide(): Record<string, number>[string] { return 1; }
export default pattern(() => ({
  one: one(),
  either: either(),
  any: any(),
  wide: wide(),
}));`),
      ).toEqual([["any.ref"]]);
    });

    it("reads a call's type parameters from the arguments that supply them, however a parameter receives one", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function pick<T>(this: void, x: T) { return x; }
function field<T>({ value }: { value: T }) { return value; }
function first<T>(...values: T[]) { return values[0]; }
function copied<T>(value: T, copy = value) { return copy; }
function passed<T>(value: T) { return value; }
function each<T>(items: readonly T[], visit: (item: T) => void) {
  void visit;
  return items[0];
}
function held<T>(x: T | null) { return { value: x! }; }
function keyed<T>(bag: { [key: string]: T }) { return bag.a; }
function pair<T>(label: string, value: T) { return label ? value : value; }
function opened<T>(note: Note<T>) { return { inner: note.ref }; }
class Holder<T> { constructor(public held: T) {} }
function unheld<T>(holder: Holder<T>) { return holder.held; }
function tupled<T>(...pair: [string, T]) { return pair[1]; }
interface List<T> { value: T; next?: List<T> }
function head<T>(list: List<T>) { return list.value; }
function nullable<T>(items: (T | null)[]) { return items[0]!; }
function listed<T>(items: Array<T>) { return items[0]; }
type Pair<T> = { left: T; right: number };
function left<T>(pair: Pair<T>) { return pair.left; }
function run<T>(options: { make: () => T }) { return options.make(); }
function filled<T>(partial: Partial<T>) { return partial as T; }
const args: [Note<unknown>] = [makeNote()];
const list = [makeNote()];
const labels: [string] = ["x"];
export default pattern(() => ({
  pick: pick(makeNote()),
  field: field({ value: makeNote() }),
  first: first(makeNote()),
  copied: copied(makeNote()),
  spread: passed(...args),
  each: each([makeNote()], () => {}),
  held: held(makeNote()),
  keyed: keyed({ a: makeNote() }),
  pair: pair(...labels, makeNote()),
  opened: opened(makeNote()),
  unheld: unheld(new Holder(makeNote())),
  spreadList: passed(...list),
  tupled: tupled("x", makeNote()),
  head: head({ value: makeNote() }),
  nullable: nullable([makeNote()]),
  listed: listed([makeNote()]),
  left: left({ left: makeNote(), right: 1 }),
  run: run({ make: makeNote }),
  pickInferred: pick(wrap(op())),
  fieldInferred: field({ value: wrap(op()) }),
  firstInferred: first(wrap(op())),
  copiedInferred: copied(wrap(op())),
  eachInferred: each([wrap(op())], () => {}),
  keyedInferred: keyed({ a: wrap(op()) }),
  pairInferred: pair(...labels, wrap(op())),
  openedInferred: opened(wrap(op())),
  unheldInferred: unheld(new Holder(wrap(op()))),
  tupledInferred: tupled("x", wrap(op())),
  headInferred: head({ value: wrap(op()) }),
  runInferred: run({ make: () => wrap(op()) }),
  filledInferred: filled({ ref: op() }),
}));`),
      ).toEqual([[
        "pickInferred.ref",
        "fieldInferred.ref",
        "firstInferred.ref",
        "copiedInferred.ref",
        "eachInferred.ref",
        "keyedInferred.ref",
        "pairInferred.ref",
        "openedInferred.inner",
        "unheldInferred.ref",
        "tupledInferred.ref",
        "headInferred.ref",
        "runInferred.ref",
        "filledInferred.ref",
      ]]);
    });

    it("reads a rest tuple's slots after its variable one from the end, whatever arguments come before them", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function last<T>(...args: [...string[], T]): { ref: T } {
  return { ref: args[args.length - 1] as T };
}
function lastOf<T>(t: [...string[], T]): { ref: T } {
  return { ref: t[t.length - 1] as T };
}
function ends<T, U>(...a: [T, ...string[], U]): { ref: U } {
  return { ref: a[a.length - 1] as U };
}
function middle<T>(...a: [...T[], number]): { ref: T } {
  return { ref: a[0] as T };
}
const notes: Note<unknown>[] = [makeNote()];
const loose: unknown[] = [op()];
function lastAny<T>(...args: [...unknown[], T]): { ref: T } {
  return { ref: args[args.length - 1] as T };
}
function lastAnyOf<T>(t: [...unknown[], T]): { ref: T } {
  return { ref: t[t.length - 1] as T };
}
function pair(): [unknown, Note<unknown>] { return [op(), makeNote()]; }
function pairBody() {
  return [op(), makeNote()] as [unknown, Note<unknown>];
}
const held: [unknown, Note<unknown>] = [op(), makeNote()];
const either: [unknown, Note<unknown>] | [string, Note<unknown>] = [
  op(),
  makeNote(),
];
const labels: string[] = ["a"];
export default pattern(() => ({
  none: last(makeNote().ref),
  two: last("a", "b", makeNote().ref),
  spread: last(...labels, makeNote().ref),
  literal: lastOf(["a", makeNote().ref]),
  both: ends(op(), makeNote().ref),
  afterUnknown: lastAny(op(), makeNote().ref),
  literalAfterUnknown: lastAnyOf([op(), makeNote().ref]),
  annotated: lastAnyOf(held),
  called: lastAnyOf(pair()),
  returned: lastAnyOf(pairBody()),
  eitherTuple: lastAnyOf(either),
  noneInferred: last(op()),
  twoInferred: last("a", "b", op()),
  spreadInferred: last(...labels, op()),
  spreadsInferred: last(...labels, "b", ...labels, op()),
  middle: middle(...notes, makeNote(), ...notes, 1),
  middleInferred: middle(...loose, makeNote(), ...notes, 1),
  literalInferred: lastOf(["a", op()]),
  bothInferred: ends(makeNote().ref, op()),
}));`),
      ).toEqual([[
        "noneInferred.ref",
        "twoInferred.ref",
        "spreadInferred.ref",
        "spreadsInferred.ref",
        "middleInferred.ref",
        "literalInferred.ref",
        "bothInferred.ref",
      ]]);
    });

    it("reads a mapped type's source backwards, each member against the template", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
type Wrapped<T> = { [K in keyof T]: { value: T[K] } };
type Getters<T> = { [K in keyof T]: () => T[K] };
function unwrap<T>(v: Wrapped<T>): T {
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, (x as { value: unknown }).value]),
  ) as T;
}
function call<T>(v: Getters<T>): T {
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, (x as () => unknown)()]),
  ) as T;
}
function frozen<T>(v: Readonly<T>): T { return v as T; }
function counted<T>(v: { [K in keyof T]: number }): T {
  return Object.fromEntries(Object.entries(v)) as T;
}
const getters = { a: makeNote };
const loose = { a: () => ({ ref: op() }) };
export default pattern(() => ({
  wrapped: unwrap({ a: { value: makeNote() } }),
  called: call(getters),
  frozen: frozen(makeNote()),
  list: unwrap([{ value: makeNote() }]),
  wrappedInferred: unwrap({ a: { value: { ref: op() } } }),
  listInferred: unwrap([{ value: { ref: op() } }]),
  mixedInferred: unwrap({ a: { value: makeNote() }, b: { value: { ref: op() } } }),
  calledInferred: call(loose),
  frozenInferred: frozen({ ref: op() }),
  countedInferred: counted({ a: 1 }),
}));`),
      ).toEqual([[
        "wrappedInferred.a.ref",
        "listInferred[].ref",
        "mixedInferred.b.ref",
        "calledInferred.a.ref",
        "frozenInferred.ref",
        "countedInferred.a",
      ]]);
    });

    it("reads what an iterable yields through the type argument its iteration takes", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function first<T>(xs: Iterable<T>): { ref: T } {
  return { ref: xs[Symbol.iterator]().next().value as T };
}
class Bag<T> implements Iterable<T> {
  constructor(private v: T) {}
  *[Symbol.iterator]() { yield this.v; }
}
class Empty<T> implements Iterable<T> {
  *[Symbol.iterator](): Iterator<T> {}
}
class Notes implements Iterable<Note<unknown>> {
  *[Symbol.iterator](): Iterator<Note<unknown>> { yield makeNote(); }
}
const notes = new Map([["a", makeNote()]]);
const loose = new Map([["a", op()]]);
const bag: Bag<Note<unknown>> = new Bag(makeNote());
export default pattern(() => ({
  set: first(new Set([makeNote()])),
  values: first(notes.values()),
  bag: first(bag),
  made: first(new Bag(makeNote())),
  entries: first(notes),
  fixed: first(new Notes()),
  setInferred: first(new Set([op()])),
  valuesInferred: first(loose.values()),
  entriesInferred: first(loose),
  bagInferred: first(new Bag(op())),
  emptyInferred: first(new Empty()),
  reassigned: computed(() => {
    let held = new Set([makeNote()]);
    held = new Set([makeNote()]);
    return first(held);
  }),
  reassignedInferred: computed(() => {
    let held = new Set([op()]);
    held = new Set([op()]);
    return first(held);
  }),
}));`),
      ).toEqual([[
        "setInferred.ref",
        "valuesInferred.ref",
        "entriesInferred.ref[]",
        "bagInferred.ref",
        "emptyInferred.ref",
        "reassignedInferred.ref",
      ]]);
    });

    it("reads a tagged template's strings and then its substitutions as its arguments, and an empty rest as supplying nothing", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function id<T>(s: TemplateStringsArray, v: T): T { return v; }
function both<T>(s: TemplateStringsArray, a: T, b: T): T { return a ?? b; }
function rest<T>(s: TemplateStringsArray, ...args: T[]): { ref: T } {
  return { ref: args[0]! };
}
function get<T>(...values: T[]): { ref: T } { return { ref: values[0]! }; }
export default pattern(() => ({
  id: id\`\${makeNote()}\`,
  both: both\`\${makeNote()} \${makeNote()}\`,
  idInferred: id\`\${wrap(op())}\`,
  bothInferred: both\`\${makeNote()} \${wrap(op())}\`,
  restInferred: rest\`\${op()}\`,
  emptyInferred: rest\`x\`,
  noneInferred: get(),
}));`),
      ).toEqual([[
        "idInferred.ref",
        "bothInferred.ref",
        "restInferred.ref",
        "emptyInferred.ref",
        "noneInferred.ref",
      ]]);
    });

    it("takes a constraint that denotes `unknown` or `any`, however it is written, as no written type", async () => {
      expect(
        await reportedPaths(`interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
type Anything = unknown;
type AnythingAgain = Anything;
type Loose = any;
type Written = Note<unknown>;
function written<T extends Written>(): T { return makeNote() as T; }
function aliased<T extends Anything>(): { ref: T } { return { ref: 1 as T }; }
function chained<T extends AnythingAgain>(): { ref: T } {
  return { ref: 1 as T };
}
function wrapped<T extends (unknown)>(): { ref: T } { return { ref: 1 as T }; }
function loose<T extends Loose>(): { ref: T } { return { ref: 1 as T }; }
export default pattern(() => ({
  written: written(),
  aliasedInferred: aliased(),
  chainedInferred: chained(),
  wrappedInferred: wrapped(),
  looseInferred: loose(),
}));`),
      ).toEqual([[
        "aliasedInferred.ref",
        "chainedInferred.ref",
        "wrappedInferred.ref",
        "looseInferred.ref",
      ]]);
    });

    it("reads what a callback returns through its type's signature where the trace loses it, and a closure through the call that made it", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function invoke<T>(fn: () => T): T { return fn(); }
function load<T>(o: { load: () => T }): T { return o.load(); }
function factory() { return makeNote; }
function looseFactory() { return () => wrap(op()); }
function closing<T>(x: T) { return () => x; }
class Maker { ref: unknown = 1; }
function build<T>(C: new () => T): T { return new C(); }
function makeClass() { return Maker; }
function only<T>(f: (x: T) => void): T { void f; return null as T; }
function sink() { return (x: Note<unknown>) => void x; }
declare const untyped: Function;
const flag = true as boolean;
const kept = makeNote();
class Defaulted<T = Note<unknown>> { v!: T; }
function makeDefaulted() { return Defaulted; }
function pass<T>(o: { kept: T }): T { return o.kept; }
function nesting<T>(x: T) {
  function inner() { return x; }
  return invoke(inner);
}
const opts = { load: makeNote };
const looseOpts = { load: () => wrap(op()) };
const { load: picked } = opts;
const { load: loosePicked } = looseOpts;
const closed = closing(makeNote());
const looseClosed = closing(wrap(op()));
export default pattern(() => ({
  made: invoke(factory()),
  spread: load({ ...opts }),
  replaced: load({ ...looseOpts, load: makeNote }),
  picked: invoke(picked),
  reassigned: computed(() => {
    let held = makeNote;
    held = makeNote;
    return invoke(held);
  }),
  closing: invoke(closing(makeNote())),
  closed: closed(),
  built: build(makeClass()),
  sunk: { inner: only(sink()) },
  untyped: { v: untyped() },
  builtDefault: build(makeDefaulted()),
  shorthand: pass({ kept }),
  nested: nesting(makeNote()),
  chosen: invoke(flag ? makeNote : makeNote),
  madeInferred: invoke(looseFactory()),
  spreadInferred: load({ ...looseOpts }),
  pickedInferred: invoke(loosePicked),
  closingInferred: invoke(closing(wrap(op()))),
  closedInferred: looseClosed(),
  nestedInferred: nesting(wrap(op())),
  chosenInferred: invoke(flag ? makeNote : () => wrap(op())),
}));`),
      ).toEqual([[
        "madeInferred.ref",
        "spreadInferred.ref",
        "pickedInferred.ref",
        "closingInferred.ref",
        "closedInferred.ref",
        "nestedInferred.ref",
        "chosenInferred.ref",
      ]]);
    });

    it("reads the members an argument writes out against a type a declaration file declares", async () => {
      const { diagnostics } = await validateFiles({
        "/box.d.ts": `export interface Box<T> { value: T }
export interface Options<T> { load: () => T }`,
        "/test.tsx": `import { pattern } from "commonfabric";
import type { Box, Options } from "./box.d.ts";
function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function unbox<T>(v: Box<T>): T { return v.value; }
function load<T>(o: Options<T>): T { return o.load(); }
function mkBox() { return { value: makeNote() }; }
function mkWritten(): { value: Note<unknown> } { return { value: makeNote() }; }
const extra = { value: makeNote(), other: 1 };
const either: { value: Note<unknown> } | { value: Note<unknown>; n: number } = {
  value: makeNote(),
};
export default pattern(() => ({
  boxed: unbox({ value: makeNote() }),
  extra: unbox(extra),
  made: unbox(mkBox()),
  written: unbox(mkWritten()),
  either: unbox(either),
  loaded: load({ load: makeNote }),
  boxedInferred: unbox({ value: wrap(op()) }),
}));`,
      }, { types: COMMONFABRIC_TYPES });

      expect(pathsIn(diagnostics)).toEqual([["boxedInferred.ref"]]);
    });

    it("reads an indexed access type's key as what the call binds its type parameter to", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
function get<T, K extends keyof T>(o: T, k: K): T[K] { return o[k]; }
function good<T, K extends keyof T = "good" & keyof T>(o: T): T[K] {
  return o["good" as K];
}
function both<T, K extends keyof T = ("good" | "fine") & keyof T>(
  o: T,
): T[K] {
  return o["good" as K];
}
function either<T, K extends keyof T = ("good" | "bad") & keyof T>(
  o: T,
): T[K] {
  return o["good" as K];
}
const o = { good: makeNote(), fine: makeNote(), bad: wrap(op()) };
const wide = "good" as keyof typeof o;
function pick<K extends keyof typeof o>(k: K) {
  return get<typeof o, K>(o, k);
}
export default pattern(() => ({
  inferred: get(o, "good"),
  written: get<typeof o, "good">(o, "good"),
  defaulted: good<typeof o>(o),
  both: both<typeof o>(o),
  picked: pick("good"),
  badInferred: get(o, "bad"),
  wideInferred: get(o, wide),
  eitherInferred: either<typeof o>(o),
}));`),
      ).toEqual([[
        "badInferred.ref",
        "wideInferred.ref",
        "eitherInferred.ref",
      ]]);
    });

    it("reports a parameter's default that is undeclared where the parameter takes it, and nothing for a written type parameter default no argument supplies", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function made(x = { ref: op() }) { return x; }
function wrapped(x = { ref: op() }) { return { inner: x }; }
function typed<T = Note<unknown>>(x?: T) { return x as T; }
export default pattern(() => ({
  passed: made(undefined),
  omitted: made(),
  wrapped: wrapped(undefined),
  typed: typed(),
}));`),
      ).toEqual([["passed.ref", "omitted.ref", "wrapped.inner.ref"]]);
    });

    it("takes a class's type parameter default where no argument a construction passes can supply it, through a spread or an inherited constructor", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
class Named<T = unknown> {
  ref!: T;
  constructor(public name: string) {}
}
class Optional<T = unknown> {
  constructor(public ref: T = undefined as T) {}
}
class Supplied<T = unknown> {
  constructor(public name: string, public ref: T) {}
}
class Inherited<U> extends Supplied<U> {}
class Plain {
  constructor(public label: string) {}
}
function tagged<B extends new (...args: any[]) => object>(Base: B) {
  return class extends Base {};
}
class Mixed<T = Note<unknown>> extends tagged(Plain) {
  extra!: T;
}
const name: [string] = ["x"];
const none: [] = [];
const both: [string, unknown] = ["x", op()];
export default pattern(() => ({
  named: new Named(...name),
  optional: new Optional(...none),
  supplied: new Supplied(...both),
  inherited: new Inherited("y", op()),
  inheritedDeclared: new Inherited("z", makeNote()),
  mixed: new Mixed("w"),
}));`),
      ).toEqual([["supplied.ref", "inherited.ref"]]);
    });

    it("reads a member by each key a key's literal type names", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
const a = "a";
export default pattern<{ flag: boolean }>(({ flag }) => ({
  result: computed(() => {
    const p = { a: makeNote(), b: wrap(op()) };
    const key = flag ? a : "b" as const;
    const one = p[a];
    const either = p[key];
    return { one, either };
  }),
}));`),
      ).toEqual([["result.either.ref"]]);
    });

    it("reads a method's class or interface type parameters from the value it is called on", async () => {
      expect(
        await reportedPaths(`function op(): unknown { return 1; }
interface Note<T> { ref: T }
function makeNote(): Note<unknown> { return { ref: 1 }; }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
class Store<T> {
  constructor(public value: T) {}
  get() { return this.value; }
}
interface Repo<T> { read(): T }
function repo(): Repo<Note<unknown>> { return { read: () => makeNote() }; }
export default pattern(() => {
  const store = new Store(makeNote());
  const typed: Store<Note<unknown>> = new Store(makeNote());
  return {
    stored: store.get(),
    typed: typed.get(),
    read: repo().read(),
    storedInferred: new Store(wrap(op())).get(),
  };
});`),
      ).toEqual([["storedInferred.ref"]]);
    });

    it("reports a field of a generic instance whose type argument was inferred, however a written type reaches it", async () => {
      expect(
        await reportedPaths(`import type { Default } from "commonfabric";
function op(): unknown { return 1; }
class Box<T> { constructor(public ref: T) {} }
const sample = new Box(op());
const written = new Box<unknown>(1);
const loose: unknown = 1;
const literal = { ref: op() };
function make() { return new Box(op()); }
function again(): ReturnType<typeof make> { return make(); }
interface Holder { inner: typeof sample; n: number }
function holder(): Holder { return { inner: sample, n: 1 }; }
interface Picked extends Pick<typeof sample, "ref"> { n: number }
interface Field { x: typeof loose }
type Renamed<T> = { [K in keyof T as \`x_\${string & K}\`]: T[K] };
const tree: { kids: (typeof tree)[] } = { kids: [] };
const listed = [sample];
interface Bag { [key: string]: typeof sample }
interface Note<T> { ref: T }
function wrap<T>(v: T): Note<T> { return { ref: v }; }
const lifted = lift<number, typeof sample>(() => sample);
class Loaded { ref = op(); }
function keep() { return written; }
type OrSample<T> = T | typeof sample;
export default pattern(() => ({
  result: computed(() => {
    const held: typeof sample = sample;
    const picked: Pick<Holder, "inner"> = { inner: sample };
    const extended: Picked = { ref: 1, n: 1 };
    const kept: typeof written = written;
    const field: Field = { x: 1 };
    const renamed: Renamed<typeof literal> = { x_ref: 1 };
    const indexed: { r: (typeof sample)["ref"] } = { r: 1 };
    const recorded: Record<string, typeof sample> = { a: sample };
    const bag: Bag = { a: sample };
    const parts: [
      first: typeof sample,
      second?: typeof sample,
      ...rest: (typeof sample)[],
    ] = [sample];
    const loose: [
      typeof written,
      (typeof sample)?,
      ...(typeof written)[],
    ] = [written];
    const element: { e: (typeof listed)[number] } = { e: sample };
    const awaited: Awaited<typeof sample> = sample;
    const awaitedKept: Awaited<ReturnType<typeof keep>> = keep();
    const awaitedClass: Awaited<Loaded> = new Loaded();
    const defaulted: Default<Loaded> = new Loaded();
    const unioned: OrSample<Box<string>> = sample;
    const awaitedList: Awaited<{ list: unknown[] }> = { list: [] };
    const awaitedBag: Awaited<{ bag: Record<string, unknown> }> = { bag: {} };
    return {
      held, picked, extended, kept, field, renamed, indexed, recorded, tree,
      bag, parts, loose, element, awaited, awaitedKept, defaulted, unioned, awaitedClass, awaitedList, awaitedBag,
      cast: sample as typeof sample,
      member: holder().inner.ref,
    };
  }),
  again: again(),
  annotated: computed((): typeof sample => sample),
  explicit: wrap<typeof sample>(sample),
  lifted: lifted(1),
}));`),
      ).toEqual([[
        "result.held.ref",
        "result.picked.inner.ref",
        "result.extended.ref",
        "result.renamed.x_ref",
        "result.indexed.r",
        "result.recorded.*.ref",
        "result.bag.*.ref",
        "result.parts[].ref",
        "result.loose[].ref",
        "result.element.e.ref",
        "result.awaited.ref",
        "result.defaulted.ref",
        "result.unioned.ref",
        "result.awaitedClass.ref",
        "result.cast.ref",
        "result.member",
        "again.ref",
        "annotated.ref",
        "explicit.ref.ref",
        "lifted.ref",
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
