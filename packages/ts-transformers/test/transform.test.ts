import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callsMatching,
  callsNamed,
  collect,
  forCauses,
  hasKeyPathRead,
  literalToValue,
  parseModule,
} from "./transformed-ast.ts";
import { transformFiles } from "./utils.ts";

/**
 * True when some emitted `.for(...)` call is attached directly to a
 * `<receiver>.key("<key>")` reactive read — the shape the transformer must
 * avoid, since a stable cause belongs on the lowered result, not on the raw
 * property read.
 */
function hasForOnKeyRead(root: ts.Node, key: string): boolean {
  return callsNamed(root, "for").some((call) => {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const receiver = callee.expression;
    if (!ts.isCallExpression(receiver)) return false;
    const receiverCallee = receiver.expression;
    if (
      !ts.isPropertyAccessExpression(receiverCallee) ||
      receiverCallee.name.text !== "key"
    ) {
      return false;
    }
    const firstArg = receiver.arguments[0];
    return !!firstArg && ts.isStringLiteralLike(firstArg) &&
      firstArg.text === key;
  });
}

const fixture = `
import { toSchema } from "commonfabric";

interface Config {
  value: number;
}

const configSchema = toSchema<Config>({
  default: { value: 42 },
  description: "Configuration schema"
});
export { configSchema };
`;

describe("CommonFabricTransformerPipeline", () => {
  it("adds stable variable causes to fresh reactive initializers", async () => {
    const source = `
import { cell, computed, Writable } from "commonfabric";

export function make() {
  const foo = Writable.of(1);
  const bar = computed(() => foo.get() + 1);
  const baz = cell(["a"]).map((value) => value.toUpperCase());
  const already = Writable.of(2).for("manual");
  return { already, bar, baz, foo };
}
`;

    const output = await transformFiles({
      "/main.ts": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.ts"]!;

    const root = parseModule(main);
    const causes = forCauses(root);
    assert(causes.includes("foo"));
    assert(causes.includes("bar"));
    assert(causes.includes("baz"));
    assert(!causes.includes("already"));

    // The fresh `Writable.of(1, …)` initializer gains an inferred schema; the
    // `.for("foo", true)` cause hangs off that `Writable.of` call.
    const fooFor = callsNamed(root, "for").find((c) =>
      literalToValue(c.arguments[0]!) === "foo"
    );
    assert(fooFor);
    const receiver = (fooFor.expression as ts.PropertyAccessExpression)
      .expression;
    assert(ts.isCallExpression(receiver));
    assertEquals(receiver.arguments.length, 2);
    assertEquals(literalToValue(receiver.arguments[1]!), { type: "number" });
  });

  it("registers wrapped non-exported builder consts in __cfReg (CT-1743)", async () => {
    // A non-exported top-level handler written as `const x = handler(...) as T`
    // must still be __cfReg-registered. Without unwrapping the wrapper its
    // initializer fails the CallExpression check, so it is excluded from
    // __cfReg, gets no content-addressed provenance, and at resolve time falls
    // to the SES source fallback that strips its builder imports — the CT-1743
    // `navigateTo`-of-undefined crash. Every transparent wrapper spelling has
    // to register, not just the cast: the registration reads the shared set, so
    // a spelling left out of it fails silently at runtime rather than loudly
    // here. The no-wrapper sibling is the positive control.
    const source = `
import { handler } from "commonfabric";

type OpenFactory = (args: { id: string }) => unknown;

const openWithCast = handler<
  { id: string },
  { count: number }
>((_event, { count }) => {
  void count;
}) as OpenFactory;

const openWithNonNull = handler<
  { id: string },
  { count: number }
>((_event, { count }) => {
  void count;
})!;

const openWithSatisfies = handler<
  { id: string },
  { count: number }
>((_event, { count }) => {
  void count;
}) satisfies unknown;

const openNoCast = handler<
  { id: string },
  { count: number }
>((_event, { count }) => {
  void count;
});
`;

    const output = await transformFiles({
      "/main.ts": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.ts"]!;

    const root = parseModule(main);
    const regCalls = callsNamed(root, "__cfReg");
    assertEquals(regCalls.length, 1);
    const arg = regCalls[0]!.arguments[0]!;
    assert(ts.isObjectLiteralExpression(arg));
    const keys = arg.properties.map((p) =>
      p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name))
        ? p.name.text
        : undefined
    );
    assert(keys.includes("openNoCast")); // positive control
    assert(keys.includes("openWithCast")); // CT-1743 regression guard
    assert(keys.includes("openWithNonNull"));
    assert(keys.includes("openWithSatisfies"));
  });

  it("adds stable property causes to pattern-owned lowered derives", async () => {
    const source = `
import { pattern } from "commonfabric";

export default pattern<{ count: number }, { doubled: number }>((state) => ({
  doubled: state.count * 2,
}));
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    // After CT-1615 Phase 1 the pattern-owned synthesized derive lowers to
    // lift-applied; after CT-1644 Phase 2 the lift call is hoisted to a
    // module-scope const and the result reads as `doubled: __cfLift_N(input)`.
    const root = parseModule(main);
    assertEquals(callsNamed(root, "lift").length, 1);
    assert(callsMatching(root, /^__cfLift/).length >= 1);
    assertEquals(forCauses(root), [["__patternResult", "doubled"]]);
    assert(!hasForOnKeyRead(root, "count"));
  });

  it("adds stable nested causes to pattern result cells", async () => {
    const source = `
import { pattern, Writable } from "commonfabric";

export default pattern<{ count: number }>((state) => ({
  foo: state.count * 2,
  nested: {
    bar: Writable.of("bar"),
  },
  tuple: [Writable.of("tuple")],
}));
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    const root = parseModule(main);
    const causes = forCauses(root);
    assertEquals(
      causes.find((c) =>
        Array.isArray(c) && c[0] === "__patternResult" && c[1] === "foo"
      ),
      ["__patternResult", "foo"],
    );
    assertEquals(
      causes.find((c) => Array.isArray(c) && c[1] === "nested"),
      ["__patternResult", "nested", "bar"],
    );
    assertEquals(
      causes.find((c) => Array.isArray(c) && c[1] === "tuple"),
      ["__patternResult", "tuple", 0],
    );
    assert(!hasForOnKeyRead(root, "count"));
  });

  it("uses stream-scoped causes for handler result streams", async () => {
    const source = `
import { handler, pattern } from "commonfabric";

const saveHandler = handler(false, false, () => {});

export default pattern(() => {
  const save = saveHandler({});
  return {
    nested: {
      cancel: saveHandler({}),
    },
    save,
  };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    const causes = forCauses(parseModule(main));
    assertEquals(
      causes.find((c) =>
        isObjectNotArray(c) &&
        (c as Record<string, unknown>).stream === "save"
      ),
      { stream: "save" },
    );
    assertEquals(
      causes.find((c) =>
        isObjectNotArray(c) &&
        Array.isArray((c as Record<string, unknown>).stream)
      ),
      { stream: ["__patternResult", "nested", "cancel"] },
    );
    // Streams keep a stream-scoped cause, never a bare string or array path.
    assert(!causes.includes("save"));
    assert(
      !causes.some((c) =>
        Array.isArray(c) && c[0] === "__patternResult" && c[1] === "nested" &&
        c[2] === "cancel"
      ),
    );
  });

  it("re-roots reactive identifier members in pattern results", async () => {
    const source = `
import { pattern, Writable } from "commonfabric";

export default pattern(() => {
  const foo = Writable.of(1);
  return {
    foo,
    explicit: foo,
  };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    const root = parseModule(main);
    const causes = forCauses(root);
    assert(causes.includes("foo")); // variable-declaration cause
    // Both result members re-root onto the `foo` identifier with a nested cause.
    const rerooted = callsNamed(root, "for").filter((call) => {
      const callee = call.expression;
      return ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) && callee.expression.text === "foo";
    });
    const rerootedCauses = rerooted.map((c) => literalToValue(c.arguments[0]!));
    assert(
      rerootedCauses.some((c) =>
        Array.isArray(c) && c[0] === "__patternResult" && c[1] === "foo"
      ),
    );
    assert(
      rerootedCauses.some((c) =>
        Array.isArray(c) && c[0] === "__patternResult" && c[1] === "explicit"
      ),
    );
  });

  it("adds stable nested causes to constructed variable values", async () => {
    const source = `
import { computed, Writable } from "commonfabric";

declare function f(input: unknown): unknown;

export function make() {
  const foo = f({
    param: Writable.of(1),
    nested: {
      result: computed(() => 2),
    },
    tuple: [Writable.of("tuple")],
    already: Writable.of(3).for("manual"),
  });
  return foo;
}
`;

    const output = await transformFiles({
      "/main.ts": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.ts"]!;

    const causes = forCauses(parseModule(main));
    const arrayEq = (a: unknown, b: unknown[]) =>
      Array.isArray(a) && a.length === b.length &&
      a.every((x, i) => x === b[i]);
    assert(causes.some((c) => arrayEq(c, ["foo", "param"])));
    assert(causes.some((c) => arrayEq(c, ["foo", "nested", "result"])));
    assert(causes.some((c) => arrayEq(c, ["foo", "tuple", 0])));
    assert(!causes.some((c) => arrayEq(c, ["foo", "already"])));
  });

  it("does not add positional cause segments for wrapped single object arguments", async () => {
    const source = `
import { Writable } from "commonfabric";

declare function f<T>(arg: T): T;

export function make() {
  const param = Writable.of(1);
  const foo = f(({ param }) as const);
  return foo;
}
`;

    const output = await transformFiles({
      "/main.ts": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.ts"]!;

    const causes = forCauses(parseModule(main));
    const arrayEq = (a: unknown, b: unknown[]) =>
      Array.isArray(a) && a.length === b.length &&
      a.every((x, i) => x === b[i]);
    assert(causes.some((c) => arrayEq(c, ["foo", "param"])));
    assert(!causes.some((c) => arrayEq(c, ["foo", 0, "param"])));
  });

  it("does not retarget plain handler params inside local object initializers", async () => {
    const source = `
import { handler, type Stream } from "commonfabric";

type Message = {
  role: "user";
  content: Array<{ type: "text"; text: string }>;
};

const runBoth = handler<void, { send: Stream<Message>; prompt: string }>(
  (_, { send, prompt }) => {
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: prompt }],
    };
    send.send(message);
  },
);

export { runBoth };
`;

    const output = await transformFiles({
      "/main.ts": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.ts"]!;

    const root = parseModule(main);
    // The `text` message field stays bound to the bare `prompt` identifier,
    // not to a reactive read.
    const textAssign = collect(root, ts.isPropertyAssignment).find((p) =>
      (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) &&
      p.name.text === "text" && ts.isIdentifier(p.initializer) &&
      p.initializer.text === "prompt"
    );
    assert(
      textAssign,
      "expected `text: prompt` to survive as a bare identifier",
    );
    // No stable cause is attached to `prompt`.
    assert(
      !callsNamed(root, "for").some((call) => {
        const callee = call.expression;
        return ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "prompt";
      }),
    );
  });

  it("does not duplicate stable causes on asserted reactive initializers", async () => {
    const source = `
import { Default, pattern } from "commonfabric";

interface Entry {
  id: string;
}

export default pattern<{ entries: Default<Entry[], []> }>(({ entries }) => {
  const tree = (entries || []) as Entry[];
  return { tree };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    const treeCauseCount =
      forCauses(parseModule(main)).filter((c) => c === "tree").length;
    assertEquals(treeCauseCount, 1);
  });

  it("does not add causes to plain array methods in lift callbacks", async () => {
    const source = `
import { lift } from "commonfabric";

interface Summary {
  label: string;
  count: number;
}

export const summarize = lift((summaries: Summary[]) => {
  const labels = summaries.map((summary) => summary.label);
  const active = summaries.filter((summary) => summary.count > 0);
  return {
    labels: summaries.map((summary) => summary.label),
    active,
    label: labels.join(", "),
  };
});
`;

    const output = await transformFiles({
      "/main.ts": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.ts"]!;

    const causes = forCauses(parseModule(main));
    assert(!causes.includes("labels"));
    assert(!causes.includes("active"));
    assert(
      !causes.some((c) =>
        Array.isArray(c) && c.length === 1 && c[0] === "labels"
      ),
    );
  });

  it("does not add causes to plain array methods in lowered handler callbacks", async () => {
    const source = `
import { action, pattern, Stream } from "commonfabric";

const Child = pattern<{}, { deleteHandlers: Stream<void>[] }>(() => {
  return { deleteHandlers: [] as Stream<void>[] };
});

export default pattern(() => {
  const subject = Child({});
  const remove = action(() => {
    const handlers = subject.deleteHandlers.filter(() => true);
    handlers[0]?.send();
  });
  return { remove };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    const root = parseModule(main);
    // No stable cause is attached to a plain `.filter(...)` array read.
    assert(
      !callsNamed(root, "for").some((call) => {
        if (literalToValue(call.arguments[0]!) !== "handlers") return false;
        const callee = call.expression;
        if (!ts.isPropertyAccessExpression(callee)) return false;
        const receiver = callee.expression;
        return ts.isCallExpression(receiver) &&
          ts.isPropertyAccessExpression(receiver.expression) &&
          receiver.expression.name.text === "filter";
      }),
    );
  });

  it("does not add causes to receiver calls in property access chains", async () => {
    const source = `
import { Default, pattern, wish, Writable } from "commonfabric";

type MentionablePiece = { name: string };
declare function make(input: unknown): { result: unknown };

export default pattern(() => {
  const mentionable =
    wish<Default<MentionablePiece[], []>>({ query: "#mentionable" }).result;
  const picked = make({ param: Writable.of(1) }).result;
  return { mentionable, picked };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    const root = parseModule(main);
    // No `.for("mentionable", …)` is inserted mid-chain before `.result`.
    assert(
      !callsNamed(root, "for").some((call) => {
        if (literalToValue(call.arguments[0]!) !== "mentionable") return false;
        const parent = call.parent;
        return ts.isPropertyAccessExpression(parent) &&
          parent.expression === call && parent.name.text === "result";
      }),
    );
    const causes = forCauses(root);
    assert(
      causes.some((c) =>
        Array.isArray(c) && c[0] === "picked" && c[1] === "param"
      ),
    );
  });

  it("lowers local reactive roots in zero-input pattern bodies", async () => {
    const source = `
import { Default, pattern, wish, Writable } from "commonfabric";

type MentionablePiece = { name: string };

export default pattern<Record<string, never>>(() => {
  const mentionableWish = wish<Writable<MentionablePiece>[] | Default<[]>>({
    query: "#mentionable",
  });
  const mentionable = mentionableWish.result;
  return { mentionable };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    const root = parseModule(main);
    assert(forCauses(root).includes("mentionableWish"));
    assert(hasKeyPathRead(root, "result", "mentionableWish"));
  });

  it("does not add root causes to pattern factory outputs", async () => {
    const source = `
import { pattern, Writable } from "commonfabric";

const Child = pattern<{ value: number }>(() => {
  return { value: Writable.of(1) };
});

export default pattern(() => {
  const child = Child({ value: Writable.of(2) });
  return { child };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    const causes = forCauses(parseModule(main));
    assert(!causes.includes("child"));
    assert(
      causes.some((c) =>
        Array.isArray(c) && c[0] === "child" && c[1] === "value"
      ),
    );
  });

  it("does not re-root pattern factory identifiers in tool descriptors", async () => {
    const source = `
import { BuiltInLLMTool, pattern, patternTool } from "commonfabric";

export const searchWeb = pattern<{ query: string }, { results: string[] }>(
  ({ query }) => ({ results: [query] }),
);

export default pattern(() => {
  const tools: Record<string, BuiltInLLMTool> = {
    searchWeb: {
      pattern: searchWeb,
    },
    wrappedSearch: patternTool(searchWeb),
  };
  return { tools };
});
`;

    const output = await transformFiles({
      "/main.tsx": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.tsx"]!;

    const root = parseModule(main);
    const props = collect(root, ts.isPropertyAssignment);
    const patternProp = props.find((p) =>
      (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) &&
      p.name.text === "pattern"
    );
    assert(patternProp && ts.isIdentifier(patternProp.initializer));
    assertEquals(patternProp.initializer.text, "searchWeb");
    const wrappedProp = props.find((p) =>
      (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) &&
      p.name.text === "wrappedSearch"
    );
    assert(wrappedProp && ts.isCallExpression(wrappedProp.initializer));
    const wrapCall = wrappedProp.initializer;
    assert(ts.isIdentifier(wrapCall.expression));
    assertEquals(wrapCall.expression.text, "patternTool");
    assert(
      wrapCall.arguments.length === 1 &&
        ts.isIdentifier(wrapCall.arguments[0]!) &&
        wrapCall.arguments[0].text === "searchWeb",
    );
    // The pattern factory identifier is never given a stable cause.
    assert(
      !callsNamed(root, "for").some((call) => {
        const callee = call.expression;
        return ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "searchWeb";
      }),
    );
  });

  it("does not add shared property causes inside dynamic array callbacks", async () => {
    const source = `
import { lift, Writable } from "commonfabric";

export const build = lift((values: number[]) =>
  values.map((_value, index) => ({
    token: Writable.of(index),
  }))
);
`;

    const output = await transformFiles({
      "/main.ts": source,
    }, {
      types: COMMONFABRIC_TYPES,
    });
    const main = output["/main.ts"]!;

    assert(!forCauses(parseModule(main)).includes("token"));
  });

  it("lowers computed() to lift() in every file it compiles", async () => {
    const transformed = await transformFiles({
      "/main.ts": `
import { computed } from "commonfabric";

const value = computed(() => 1);
export { value };
`,
    });
    const root = parseModule(transformed["/main.ts"]!);
    assert(callsNamed(root, "lift").length >= 1);
    assertEquals(callsNamed(root, "computed").length, 0);
  });

  it("transforms a file carrying the retired opt-out marker like any other", async () => {
    // `/// <cf-disable-transform />` once suppressed the transform for the file
    // that carried it. It is an ordinary comment now, and a source still
    // carrying it is compiled the same as one that never did.
    const transformed = await transformFiles({
      "/main.ts": `/// <cf-disable-transform />
import { computed } from "commonfabric";

const value = computed(() => 1);
export { value };
`,
    });
    const output = transformed["/main.ts"]!;
    const root = parseModule(output);
    assert(callsNamed(root, "lift").length >= 1);
    assertEquals(callsNamed(root, "computed").length, 0);
    assertMatch(output, /import \{ __cfHelpers \} from "commonfabric";/);
  });

  it("wraps top-level data candidates with __cfHelpers.__cf_data", async () => {
    const source = `
import { lift, schema } from "commonfabric";

function buildYears() {
  return Array.from({ length: 3 }, (_, index) => String(index + 1));
}

const model = schema({ type: "string" } as const);
const lookup = (() => ({ open: "Open" }))();
const days = Array.from({ length: 3 }, (_, index) => String(index + 1));
const matcher = /^[a-z]+$/;
const scopeMap = { gmail: "gmail.readonly" } as const;
const scopes = Object.fromEntries(
  Object.entries(scopeMap).map(([key, value]) => [key, { value }]),
);
const years = buildYears();
const tags = new Set(["a", "b"]);
const proxied = new Proxy({ open: "Open" }, {});
const passthrough = lift((value: string) => value);

export { model, lookup, days, matcher, scopes, years, tags, proxied, passthrough };
`;

    const output = await transformFiles({
      "/main.ts": source,
    });
    const main = output["/main.ts"]!;

    const root = parseModule(main);
    // The variable names whose top-level initializer is a `__cf_data(...)` wrap.
    const wrapped = new Set(
      collect(root, ts.isVariableDeclaration).filter((d) =>
        d.initializer && ts.isCallExpression(d.initializer) &&
        ts.isPropertyAccessExpression(d.initializer.expression) &&
        d.initializer.expression.name.text === "__cf_data"
      ).map((d) => ts.isIdentifier(d.name) ? d.name.text : undefined),
    );
    for (
      const name of ["model", "lookup", "days", "matcher", "scopes", "years"]
    ) {
      assert(wrapped.has(name), `expected ${name} to be __cf_data-wrapped`);
    }
    // `tags` (a `new Set(...)`) is wrapped; the wrapped inner is the NewExpression.
    assert(wrapped.has("tags"));
    // Proxy snapshots stay unsupported until Proxy is re-enabled in SES
    // compartments, and top-level builder calls are never wrapped.
    assert(!wrapped.has("proxied"));
    assert(!wrapped.has("passthrough"));
    // No `__cf_data` wrap takes a `lift(...)` call as its argument.
    assert(
      !callsNamed(root, "__cf_data").some((c) => {
        const inner = c.arguments[0];
        return !!inner && ts.isCallExpression(inner) &&
          ts.isIdentifier(inner.expression) &&
          inner.expression.text === "lift";
      }),
    );
  });

  it("hardens direct top-level functions with a canonical helper", async () => {
    const source = `
const step = (value: number) => value + 1;
export default function next(value: number) {
  return step(value);
}
`;

    const output = await transformFiles({
      "/main.ts": source,
    });
    const main = output["/main.ts"]!;

    const root = parseModule(main);
    // The canonical hardening helper is declared as a function.
    assert(
      collect(root, ts.isFunctionDeclaration).some((f) =>
        f.name?.text === "__cfHardenFn"
      ),
    );
    // `step`'s initializer wraps its arrow in `__cfHardenFn(...)`.
    const stepDecl = collect(root, ts.isVariableDeclaration).find((d) =>
      ts.isIdentifier(d.name) && d.name.text === "step"
    );
    assert(stepDecl?.initializer && ts.isCallExpression(stepDecl.initializer));
    assert(
      ts.isIdentifier(stepDecl.initializer.expression) &&
        stepDecl.initializer.expression.text === "__cfHardenFn",
    );
    assert(ts.isArrowFunction(stepDecl.initializer.arguments[0]!));
    // The exported default function `next` is hardened by identifier.
    assert(
      callsNamed(root, "__cfHardenFn").some((c) =>
        c.arguments.length === 1 && ts.isIdentifier(c.arguments[0]!) &&
        c.arguments[0].text === "next"
      ),
    );
  });
});

describe("CFHelpers handling", () => {
  it("Throws if __cfHelpers variable is used in source", async () => {
    const statements = [
      "function __cfHelpers() {}",
      "function foo(): number { var __cfHelpers = 5; return __cfHelpers; }",
      "var __cfHelpers: number = 5;",
      "declare global { var __cfHelpers: any; }\nglobalThis.__cfHelpers = 5;",
    ];

    for (const statement of statements) {
      await assertRejects(() =>
        transformFiles({
          "/main.ts": fixture + `\n${statement}`,
        })
      );
    }
  });

  it("Allows '__cfHelpers' in comments and in other forms", async () => {
    const statements = [
      "var x = 5; // __cfHelpers",
      "// __cfHelpers",
      "/* __cfHelpers */",
      "var __cfHelpers123: number = 5;",
      "declare global {\nvar __cfHelpers1: any;\n}\nglobalThis.__cfHelpers1 = 5;",
    ];
    for (const statement of statements) {
      await transformFiles({
        "/main.ts": fixture + `\n${statement}`,
      });
    }
  });
});
