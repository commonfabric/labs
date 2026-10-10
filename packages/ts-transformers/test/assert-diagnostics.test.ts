import { assertEquals } from "@std/assert";
import ts from "typescript";

import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  assertCaptureLabels,
  assertCaptures,
  callSchemas,
  callsNamed,
  collect,
  literalToValue,
  parseModule,
} from "./transformed-ast.ts";

const PREAMBLE =
  `import { assert, cell, computed, pattern } from "commonfabric";`;

function patternSource(body: string): string {
  return `${PREAMBLE}
export default pattern(() => {
  const a = cell<number>(1);
  const b = cell<number>(2);
  const c = cell<number>(2);
${body}
});`;
}

async function transform(
  source: string,
  assertDiagnostics?: boolean,
): Promise<string> {
  return await transformSource(source, {
    types: COMMONFABRIC_TYPES,
    ...(assertDiagnostics === undefined ? {} : { assertDiagnostics }),
  });
}

/** The transformer's output, parsed back into an AST to assert against. */
async function transformed(
  source: string,
  assertDiagnostics?: boolean,
): Promise<ts.SourceFile> {
  return parseModule(await transform(source, assertDiagnostics));
}

/** The string literal assigned to the record's `source` property. */
function recordSource(root: ts.SourceFile): string | undefined {
  const assignment = collect(root, ts.isPropertyAssignment).find((property) =>
    ts.isIdentifier(property.name) && property.name.text === "source" &&
    ts.isStringLiteral(property.initializer)
  );
  return assignment && ts.isStringLiteral(assignment.initializer)
    ? assignment.initializer.text
    : undefined;
}

/**
 * The input schema of every emitted `lift(callback, input, result)` call, in
 * source order.
 */
function liftInputSchemas(root: ts.SourceFile): unknown[] {
  return callsNamed(root, "lift").map((call) => {
    const argument = call.arguments[1];
    return argument && ts.isSatisfiesExpression(argument)
      ? literalToValue(argument.expression)
      : undefined;
  });
}

Deno.test("assert records the operands of a comparison", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => a.get() + b.get() <= c.get());
  return { check };`));

  // Each operand of the top-level operator is recorded under its authored
  // text, and the recording wraps the operand rather than replacing it.
  assertEquals(assertCaptures(root), [
    { src: "a.get() + b.get()", value: "a.get() + b.get()" },
    { src: "c.get()", value: "c.get()" },
  ]);
  assertEquals(recordSource(root), "a.get() + b.get() <= c.get()");
});

Deno.test("assert records through a parenthesized callback", async () => {
  const root = await transformed(patternSource(`
  const check = assert((() => a.get() + b.get() <= c.get()));
  return { check };`));

  assertEquals(assertCaptures(root), [
    { src: "a.get() + b.get()", value: "a.get() + b.get()" },
    { src: "c.get()", value: "c.get()" },
  ]);
  assertEquals(recordSource(root), "a.get() + b.get() <= c.get()");
});

Deno.test("assert records the arguments of a call", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => Object.is(a.get(), b.get()));
  return { check };`));

  assertEquals(assertCaptures(root), [
    { src: "a.get()", value: "a.get()" },
    { src: "b.get()", value: "b.get()" },
  ]);
});

Deno.test("assert does not record literal operands", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => a.get() === 3);
  return { check };`));

  // A literal renders to its own source text, so recording it says nothing.
  assertEquals(assertCaptureLabels(root), ["a.get()"]);
});

Deno.test("assert records the operand of a negation", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => !(a.get() === b.get()));
  return { check };`));

  // The label drops the parentheses the operator needed; the operand itself
  // keeps them, so the negation still applies to the comparison.
  assertEquals(assertCaptures(root), [
    { src: "a.get() === b.get()", value: "(a.get() === b.get())" },
  ]);
});

Deno.test("assert records each side of a short-circuit operator", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => a.get() > 0 && b.get() < 10);
  return { check };`));

  // Short-circuit operands are recorded and descended into: the operand says
  // which conjunct failed, the one nested inside says what made it fail.
  // Listed outermost-first, which is the reverse of the order they run in.
  assertEquals(assertCaptureLabels(root), [
    "a.get() > 0",
    "a.get()",
    "b.get() < 10",
    "b.get()",
  ]);

  // The operator itself is untouched, so `&&` still short-circuits and an
  // operand that never runs is never recorded.
  const [body] = collect(root, ts.isVariableDeclaration).filter((decl) =>
    ts.isIdentifier(decl.name) && decl.name.text.startsWith("__cfAssertOk")
  );
  assertEquals(
    body?.initializer !== undefined &&
      ts.isBinaryExpression(body.initializer) &&
      body.initializer.operatorToken.kind ===
        ts.SyntaxKind.AmpersandAmpersandToken,
    true,
  );
});

Deno.test("assert records the branches of a conditional", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => a.get() > 0 ? b.get() > 1 : c.get() > 1);
  return { check };`));

  assertEquals(assertCaptureLabels(root), [
    "a.get() > 0",
    "a.get()",
    "b.get() > 1",
    "b.get()",
    "c.get() > 1",
    "c.get()",
  ]);
});

Deno.test("assert lowers to a lift carrying a concrete record schema", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => a.get() <= c.get());
  return { check };`));

  // The record has to reach the harness intact. An inferred `unknown` here
  // would give the field `{ type: "unknown" }`, which reads back as a
  // reference carrying none of the record's fields.
  const [, result] = callSchemas(root, "lift");
  assertEquals(result?.type, "object");
  const properties = result?.properties as Record<string, { type?: string }>;
  assertEquals(properties.ok?.type, "boolean");
  assertEquals(properties.source?.type, "string");
  assertEquals(properties.parts?.type, "array");
  assertEquals(result?.required, ["ok", "source", "parts"]);
});

Deno.test("assert keeps the statements ahead of its return", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => {
    const total = a.get() + b.get();
    return total <= c.get();
  });
  return { check };`));

  const kept = collect(root, ts.isVariableDeclaration).some((decl) =>
    ts.isIdentifier(decl.name) && decl.name.text === "total"
  );
  assertEquals(kept, true);
  assertEquals(assertCaptureLabels(root), ["total", "c.get()"]);
});

Deno.test("assertDiagnostics: false keeps the record but drops recording", async () => {
  const root = await transformed(
    patternSource(`
  const check = assert(() => a.get() <= c.get());
  return { check };`),
    false,
  );

  // The shape is unconditional: `assert` declares it returns an AssertRecord,
  // so the value has to match the declared type either way.
  assertEquals(recordSource(root), "a.get() <= c.get()");
  assertEquals(assertCaptures(root), []);
});

Deno.test("computed is untouched by the assert pass", async () => {
  const source = patternSource(`
  const check = computed(() => a.get() + b.get() <= c.get());
  return { check };`);

  // The pass rewrites `assert` calls and nothing else, which is what keeps
  // emitted output — and so the implementation fingerprint — stable for code
  // that does not use assert.
  const withPass = await transform(source);
  const withoutPass = await transform(source, false);

  assertEquals(withPass, withoutPass);
  assertEquals(assertCaptures(parseModule(withPass)), []);
  // The lift body is still the bare authored comparison, not a record.
  const [lift] = callsNamed(parseModule(withPass), "lift");
  const callback = lift?.arguments[0];
  assertEquals(
    callback !== undefined && ts.isArrowFunction(callback) &&
      ts.isBinaryExpression(callback.body),
    true,
  );
});

Deno.test("assert does not capture a body's own binding of its local names", async () => {
  // Without unique names the emitted `const __cfAssertParts` would collide
  // with this binding, and the record's `parts` would read the author's value
  // rather than the recorded operands.
  const root = await transformed(patternSource(`
  const check = assert(() => {
    const __cfAssertParts = 5;
    return a.get() === __cfAssertParts;
  });
  return { check };`));

  const partsDeclarations = collect(root, ts.isVariableDeclaration).filter(
    (decl) =>
      ts.isIdentifier(decl.name) &&
      decl.name.text.startsWith("__cfAssertParts"),
  ).map((decl) => (decl.name as ts.Identifier).text);

  // The author's binding and the emitted local coexist under distinct names.
  assertEquals(partsDeclarations.length, 2);
  assertEquals(new Set(partsDeclarations).size, 2);

  // The author's value is recorded as an operand, not mistaken for the array.
  assertEquals(assertCaptures(root), [
    { src: "a.get()", value: "a.get()" },
    { src: "__cfAssertParts", value: "__cfAssertParts" },
  ]);

  // The record's `parts` renders the emitted local, not the author's binding.
  // It reads `assertRenderParts(ok, __cfAssertParts_N)`, so the recorded array
  // is the render call's second argument.
  const parts = collect(root, ts.isPropertyAssignment).find((property) =>
    ts.isIdentifier(property.name) && property.name.text === "parts"
  );
  const partsArg = parts && ts.isCallExpression(parts.initializer)
    ? parts.initializer.arguments[1]
    : undefined;
  const partsTarget = partsArg && ts.isIdentifier(partsArg)
    ? partsArg.text
    : undefined;
  assertEquals(partsTarget !== "__cfAssertParts", true);
  assertEquals(partsTarget?.startsWith("__cfAssertParts"), true);
});

Deno.test("assert defers operand rendering to a failing-path helper", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => a.get() <= c.get());
  return { check };`));

  // The record's `parts` is not the recorded array itself but a call that
  // renders it only when the assertion failed. `assertRenderParts(ok, parts)`
  // returns an empty list when `ok` is true, so a passing assertion pays
  // nothing to render operands it will never report.
  const parts = collect(root, ts.isPropertyAssignment).find((property) =>
    ts.isIdentifier(property.name) && property.name.text === "parts"
  );
  const call = parts?.initializer;
  assertEquals(call !== undefined && ts.isCallExpression(call), true);

  const callExpr = call as ts.CallExpression;
  assertEquals(
    ts.isPropertyAccessExpression(callExpr.expression) &&
      callExpr.expression.name.text === "assertRenderParts",
    true,
  );

  // The verdict decides whether to render, and the recorded operands are what
  // it renders: `assertRenderParts(__cfAssertOk, __cfAssertParts)`.
  const [okArg, partsArg] = callExpr.arguments;
  assertEquals(
    okArg !== undefined && ts.isIdentifier(okArg) &&
      okArg.text.startsWith("__cfAssertOk"),
    true,
  );
  assertEquals(
    partsArg !== undefined && ts.isIdentifier(partsArg) &&
      partsArg.text.startsWith("__cfAssertParts"),
    true,
  );
});

Deno.test("a local assert is not mistaken for the commonfabric one", async () => {
  const root = await transformed(`import { cell, pattern } from "commonfabric";
function assert(fn: () => boolean): boolean {
  return fn();
}
export default pattern(() => {
  const a = cell<number>(1);
  const flag = assert(() => a.get() > 0);
  return { flag };
});`);

  assertEquals(assertCaptures(root), []);
});

Deno.test("assert leaves a spread argument in argument position", async () => {
  const root = await transformed(
    `import { assert, cell, pattern } from "commonfabric";
function allPositive(...values: number[]): boolean {
  return values.every((value) => value > 0);
}
export default pattern(() => {
  const nums = cell<number[]>([1, -2, 3]);
  const check = assert(() => allPositive(...nums.get()));
  return { check };
});`,
  );

  // `assertCapture` takes the operand as one fixed parameter, so recording a
  // spread would pass `values[0]` where the whole of it belongs and silently
  // change the call's arity — turning a false assertion true.
  assertEquals(assertCaptures(root), []);
  const [call] = callsNamed(root, "allPositive");
  assertEquals(call?.arguments.length, 1);
  assertEquals(
    call?.arguments[0] !== undefined && ts.isSpreadElement(call.arguments[0]),
    true,
  );
});

Deno.test("assert records a call's receiver when its arguments say nothing", async () => {
  const root = await transformed(
    `import { assert, cell, pattern } from "commonfabric";
export default pattern(() => {
  const nums = cell<number[]>([1, -2, 3]);
  const check = assert(() => nums.get().every((value) => value > 0));
  return { check };
});`,
  );

  // The callback renders as `(...) => {...}` and says nothing, so it is left
  // alone and the receiver — the value that explains the failure — is what
  // gets recorded.
  assertEquals(assertCaptures(root), [
    { src: "nums.get()", value: "nums.get()" },
  ]);
});

Deno.test("assert leaves a namespace receiver alone", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => Object.is(a.get(), b.get()));
  return { check };`));

  // `Object.is(...)` records its arguments, so the receiver is not reached
  // for. A bare identifier receiver is a namespace whose value says nothing.
  assertEquals(assertCaptureLabels(root), ["a.get()", "b.get()"]);
});

Deno.test("assert instruments a body whose nested method has its own return", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => {
    const helper = { total() { return a.get() + b.get(); } };
    return helper.total() <= c.get();
  });
  return { check };`));

  // The `return` inside the object-literal method belongs to that method, not
  // to the assertion body, so it must not be mistaken for an early return.
  assertEquals(assertCaptureLabels(root), ["helper.total()", "c.get()"]);
});

Deno.test("assert records a body that returns early", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => {
    if (a.get() < 0) { return false; }
    return a.get() === b.get();
  });
  return { check };`));

  // Every return hands back a record, not just a trailing one. Leaving an
  // early return alone would have the body produce a bare boolean while
  // `assert` declares an AssertRecord, and the schema and value would
  // disagree.
  // Only the records' own `source` literals; the emitted schema also has a
  // `source` property, whose initializer is a type object rather than a text.
  const records = collect(root, ts.isPropertyAssignment).filter((property) =>
    ts.isIdentifier(property.name) && property.name.text === "source" &&
    ts.isStringLiteral(property.initializer)
  ).map((property) => (property.initializer as ts.StringLiteral).text);
  assertEquals(records, ["false", "a.get() === b.get()"]);
  assertEquals(assertCaptureLabels(root), ["a.get()", "b.get()"]);
});

Deno.test("assert reads the receiver of a recorded method call", async () => {
  const root = await transformed(
    `import { assert, computed, pattern } from "commonfabric";

interface Event {
  type: string;
  details: string;
  unused: number;
}

interface State {
  events: Event[];
}

export default pattern((state: State) => {
  const asserted = assert(() => {
    const last = state.events.at(-1);
    return last?.type === "word" && last.details.includes("AT");
  });
  const computedCheck = computed(() => {
    const last = state.events.at(-1);
    return last?.type === "word" && last.details.includes("AT");
  });
  return { asserted, computedCheck };
});`,
  );

  const eventFields = {
    type: "object",
    properties: {
      type: { type: "string" },
      details: { type: "string" },
    },
    required: ["type", "details"],
  };
  const readSchema = {
    type: "object",
    properties: {
      state: {
        type: "object",
        properties: {
          events: { type: "array", items: eventFields },
        },
        required: ["events"],
      },
    },
    required: ["state"],
  };

  // The recording sits between `last.details` and the `.includes` that reads
  // it. An analysis that stopped at the recording would drop `details` from
  // the schema, and the body would be served an event without it.
  assertEquals(liftInputSchemas(root), [readSchema, readSchema]);
});

Deno.test("assert compares a member it hands to equals through its recording", async () => {
  const root = await transformed(
    `import { assert, type Cell, computed, equals, pattern } from "commonfabric";

interface Piece {
  name: string;
}

interface Refusal {
  reason: string;
  inbox: Cell<Piece>;
}

interface State {
  refusal?: Refusal;
  other: Cell<Piece>;
}

export default pattern((state: State) => {
  const asserted = assert(() => {
    const refusal = state.refusal;
    return refusal !== undefined && refusal.reason === "r" &&
      equals(refusal.inbox, state.other);
  });
  const computedCheck = computed(() => {
    const refusal = state.refusal;
    return refusal !== undefined && refusal.reason === "r" &&
      equals(refusal.inbox, state.other);
  });
  return { asserted, computedCheck };
});`,
  );

  // `equals` is handed the recording of `refusal.inbox`, not the member
  // itself. The member is not read, since it is only compared, so an analysis
  // that stopped at the recording would record no use of it at all, and the
  // body would be served a refusal without its inbox.
  const [asserted, computedCheck] = liftInputSchemas(root) as {
    properties: {
      state: {
        properties: {
          refusal: { anyOf: { properties?: Record<string, unknown> }[] };
        };
      };
    };
  }[];
  assertEquals(asserted, computedCheck);
  assertEquals(
    asserted?.properties.state.properties.refusal.anyOf[0]?.properties?.inbox,
    { type: "unknown", asCell: ["comparable"] },
  );
});

Deno.test("assert leaves an operator it does not record alone", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => (a.get(), b.get() === 2));
  return { check };`));

  // A comma yields its right operand; neither side is an operand of a
  // comparison, so there is nothing to record. The body is still a record.
  assertEquals(assertCaptures(root), []);
  assertEquals(recordSource(root), "(a.get(), b.get() === 2)");
});

Deno.test("assert leaves a namespace receiver alone when nothing else records", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => Object.is(1, 1));
  return { check };`));

  // Both arguments are literals, so the receiver is reached for — but
  // `Object` is a namespace, and its value would say nothing.
  assertEquals(assertCaptures(root), []);
  assertEquals(recordSource(root), "Object.is(1, 1)");
});

Deno.test("assert leaves an optional-call receiver alone", async () => {
  const root = await transformed(
    `import { assert, cell, pattern } from "commonfabric";
export default pattern(() => {
  const maybe = cell<number[] | undefined>(undefined);
  const check = assert(() => maybe.get()?.includes(1) ?? false);
  return { check };
});`,
  );

  // Recording the receiver of `?.` would need the chain rebuilt around the
  // recording call; the operand itself is recorded instead.
  assertEquals(assertCaptureLabels(root), ["maybe.get()?.includes(1)"]);
});

//
// What the stage leaves alone
//
// The stage sees the AST before type-checking has rejected anything, so it has
// to survive a callback it cannot read and leave the call alone rather than
// emit a broken body. Some of these sources are deliberately ill-typed.
//

Deno.test("assert leaves a callback it was not given inline alone", async () => {
  const root = await transformed(patternSource(`
  const predicate = () => a.get() <= c.get();
  const check = assert(predicate);
  return { check };`));

  // The body is somewhere else, so there is nothing here to record.
  assertEquals(assertCaptures(root), []);
  assertEquals(recordSource(root), undefined);
});

Deno.test("assert leaves a callback that takes parameters alone", async () => {
  // `assert` takes a callback of no arguments, so this does not type-check —
  // but the stage runs before that is reported and must not act on it.
  const root = await transformed(patternSource(`
  const check = assert((x: number) => x > 0);
  return { check };`));

  assertEquals(assertCaptures(root), []);
});

Deno.test("assert leaves a body with a bare return alone", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => {
    if (a.get() < 0) { return; }
    return a.get() === b.get();
  });
  return { check };`));

  // A bare `return` cannot produce a record, and rewriting only the other one
  // would leave the body handing back a boolean on that path.
  assertEquals(assertCaptures(root), []);
  assertEquals(recordSource(root), undefined);
});

Deno.test("assert leaves a body with no return alone", async () => {
  const root = await transformed(patternSource(`
  const check = assert(() => {
    a.get();
  });
  return { check };`));

  assertEquals(assertCaptures(root), []);
  assertEquals(recordSource(root), undefined);
});
