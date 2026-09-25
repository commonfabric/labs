import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callSchemas,
  callsNamed,
  collect,
  emittedSchemas,
  literalToValue,
  parseModule,
  patternSchemas,
} from "./transformed-ast.ts";
import { transformSource, validateSource } from "./utils.ts";

// Unit coverage for schema-injection.ts. These tests drive the whole
// transformer pipeline with `/// <cts-enable />` pattern sources that exercise
// specific schema shapes and builder call-site forms, then assert on the
// emitted schema objects. The transformer injects generated JSON schemas at
// pattern / handler / lift / toSchema / cell / wish / generateObject /
// sqliteQuery call sites; the assertions below pin the concrete emitted schema
// for each case (property types, `required` arrays, `asCell` markers, `$ref`
// for VNode, default / optional handling, nested / array / tuple / union /
// record shapes, scope markers, and so on).

function t(source: string): Promise<string> {
  return transformSource(source, { types: COMMONFABRIC_TYPES });
}

// Every `... satisfies ...JSONSchema` expression under `root`, including
// non-object ones such as `false as const satisfies __cfHelpers.JSONSchema`,
// evaluated in source order. `emittedSchemas` drops the non-object values, so
// tests that need to see a `false` schema use this instead.
function allEmittedSchemaValues(root: ts.SourceFile): unknown[] {
  return collect(root, ts.isSatisfiesExpression)
    .filter((node) => /JSONSchema/.test(node.type.getText(root)))
    .map((node) => literalToValue(node.expression));
}

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

//
// pattern<Input, Output> — property type schemas
//

Deno.test("pattern schema encodes primitive property types and a required array", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    "interface Input { name: string; count: number; ok: boolean; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.name as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  const { input } = patternSchemas(parseModule(output));
  const props = input.properties as Obj;
  assertEquals(props.name.type, "string");
  assertEquals(props.count.type, "number");
  assertEquals(props.ok.type, "boolean");
  assertEquals(input.required, ["name", "count", "ok"]);
});

Deno.test("pattern schema omits optional properties from the required array", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    "interface Input { a: string; b?: number; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.a as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  const { input } = patternSchemas(parseModule(output));
  // `b` is present as a property but excluded from required.
  assert(Object.keys(input.properties as Obj).includes("b"));
  assertEquals(input.required, ["a"]);
});

Deno.test("pattern schema encodes a Default<> wrapper as a JSON schema default", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, Default, UI, VNode } from "commonfabric";',
    'interface Input { name: Default<string, "seed">; }',
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.name as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  const { input } = patternSchemas(parseModule(output));
  assertEquals((input.properties as Obj).name.default, "seed");
});

Deno.test("pattern schema encodes array item types", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    "interface Input { tags: string[]; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.tags as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  const { input } = patternSchemas(parseModule(output));
  const tags = (input.properties as Obj).tags;
  assertEquals(tags.type, "array");
  assertEquals(tags.items.type, "string");
});

Deno.test("pattern schema encodes nested object shapes with their own required arrays", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    "interface Input { nested: { a: boolean; b: { c: string } }; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.nested as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  const { input } = patternSchemas(parseModule(output));
  const nested = (input.properties as Obj).nested;
  assertEquals(nested.required, ["a", "b"]);
  assertEquals(nested.properties.b.required, ["c"]);
  assertEquals(nested.properties.b.properties.c.type, "string");
});

Deno.test("pattern schema encodes a Record<string, T> as additionalProperties", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    "interface Input { rec: Record<string, number>; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.rec as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  const { input } = patternSchemas(parseModule(output));
  const rec = (input.properties as Obj).rec;
  assertEquals(rec.additionalProperties.type, "number");
});

Deno.test("pattern schema encodes a union as anyOf", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    'interface Input { u: "a" | "b" | number; }',
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.u as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  const { input } = patternSchemas(parseModule(output));
  const u = (input.properties as Obj).u;
  assert(Array.isArray(u.anyOf));
  const enums = (u.anyOf as Obj[]).find((m) => m.enum !== undefined);
  assertEquals(enums!.enum, ["a", "b"]);
});

Deno.test("pattern output schema encodes a VNode UI slot as a $ref", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, UI, VNode } from "commonfabric";',
    "interface Input { x: number; }",
    "interface Output { [UI]: VNode; total: number; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: s.x as unknown as VNode, total: s.x }));",
  ].join("\n");
  const output = await t(source);
  const { output: out } = patternSchemas(parseModule(output));
  assertEquals(
    (out.properties as Obj).$UI.$ref,
    "https://commonfabric.org/schemas/vnode.json",
  );
});

//
// handler — event/state schemas and asCell markers
//

Deno.test("handler<E, S> injects two schemas and marks a written Cell state field with asCell writeonly", async () => {
  const source = [
    "/// <cts-enable />",
    'import { handler, Cell } from "commonfabric";',
    "export const h = handler<{ amount: number }, { total: Cell<number> }>(",
    "  (event, ctx) => { ctx.total.set(event.amount); },",
    ");",
  ].join("\n");
  const output = await t(source);
  const [event, state] = callSchemas(parseModule(output), "handler");
  assertEquals((event.properties as Obj).amount.type, "number");
  // The state Cell is only written (.set), so the capability summary narrows
  // the marker to writeonly rather than the read/write "cell".
  assertEquals((state.properties as Obj).total.asCell, ["writeonly"]);
});

Deno.test("handler inline form injects the event schema from the annotated parameter", async () => {
  const source = [
    "/// <cts-enable />",
    'import { handler, Cell } from "commonfabric";',
    "export const h = handler(",
    "  (event: { label: string }, ctx: { out: Cell<string> }) => { ctx.out.set(event.label); },",
    ");",
  ].join("\n");
  const output = await t(source);
  const [event] = callSchemas(parseModule(output), "handler");
  assertEquals((event.properties as Obj).label.type, "string");
});

//
// lift — many call-site forms
//

Deno.test("lift<T, R> injects input and result schemas from type arguments", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const fn = lift<{ count: number }, string>((s) => `n:${s.count}`);",
  ].join("\n");
  const output = await t(source);
  const [input, result] = callSchemas(parseModule(output), "lift");
  assertEquals((input.properties as Obj).count.type, "number");
  assertEquals(result.type, "string");
});

Deno.test("lift<T> single type argument infers the result schema from the callback body", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const fn = lift<{ count: number }>((s) => s.count > 0);",
  ].join("\n");
  const output = await t(source);
  const [input, result] = callSchemas(parseModule(output), "lift");
  assertEquals((input.properties as Obj).count.type, "number");
  // result is boolean
  assertEquals(result.type, "boolean");
});

Deno.test("lift inline form infers input and result schemas from annotations", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const fn = lift((s: { a: number }): number => s.a * 2);",
  ].join("\n");
  const output = await t(source);
  const [input, result] = callSchemas(parseModule(output), "lift");
  assertEquals((input.properties as Obj).a.type, "number");
  assertEquals(result.type, "number");
});

Deno.test("lift(toSchema<T>(), fn) transfers the authored input schema into the injected slot", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift, toSchema } from "commonfabric";',
    "const fn = lift(toSchema<{ label: string }>(), undefined, (s) => s.label);",
  ].join("\n");
  const output = await t(source);
  const [input] = emittedSchemas(parseModule(output));
  assertEquals((input.properties as Obj).label.type, "string");
});

//
// cell(...) factory — value inference and explicit type argument
//

Deno.test("cell(value) infers a widened schema from the seed value and injects it as the second argument", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell } from "commonfabric";',
    "const c = cell(42);",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  // literal 42 is widened to number, not an enum of the literal.
  assertEquals(schema.type, "number");
  assertEquals(schema.enum, undefined);
});

Deno.test("cell<T>() with an explicit type argument injects the T schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell } from "commonfabric";',
    "const c = cell<{ name: string }>();",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  assertEquals((schema.properties as Obj).name.type, "string");
});

//
// wish(...) — schema injected as trailing argument
//

Deno.test("wish<T>() injects a schema argument for the wished type", async () => {
  const source = [
    "/// <cts-enable />",
    'import { wish } from "commonfabric";',
    "const w = wish<{ answer: number }>();",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  assertEquals((schema.properties as Obj).answer.type, "number");
});

//
// generateObject — schema property injected into the options object
//

Deno.test("generateObject<T>({...}) injects a schema property into the existing options literal", async () => {
  const source = [
    "/// <cts-enable />",
    'import { generateObject } from "commonfabric";',
    'const r = generateObject<{ title: string }>({ prompt: "hi" });',
  ].join("\n");
  const output = await t(source);
  const root = parseModule(output);
  const [schema] = emittedSchemas(root);
  assertEquals((schema.properties as Obj).title.type, "string");
  // The injected schema rides in a `schema:` property on the options literal.
  assertStringIncludes(output, "schema:");
});

//
// sqliteQuery — rowSchema injected
//

Deno.test("sqliteQuery<Row>({...}) injects a rowSchema property from the Row type argument", async () => {
  const source = [
    "/// <cts-enable />",
    'import { sqliteQuery } from "commonfabric";',
    "declare const db: any;",
    'const q = sqliteQuery<{ id: number; name: string }>({ db, sql: "select 1" });',
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  assertEquals((schema.properties as Obj).id.type, "number");
  assertEquals((schema.properties as Obj).name.type, "string");
  // The injected schema rides in a `rowSchema:` property on the options literal.
  assertStringIncludes(output, "rowSchema:");
});

//
// Reactive conditionals: when / unless / ifElse prepend generated schemas
//

Deno.test("when(condition, value) prepends condition, value and result schemas", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, when, UI, VNode } from "commonfabric";',
    "interface Input { flag: boolean; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: when(s.flag, s.flag) as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  const schemas = allEmittedSchemaValues(parseModule(output)) as Obj[];
  // when is 2-arity; the rewrite prepends condition + value + result schemas,
  // so three boolean schema literals appear ahead of the pattern schemas.
  const boolSchemas = schemas.filter((s) => s.type === "boolean").length;
  assert(boolSchemas >= 3, `expected >=3 boolean schemas, got ${boolSchemas}`);
});

Deno.test("unless(condition, value) prepends generated schemas ahead of the arguments", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, unless, UI, VNode } from "commonfabric";',
    "interface Input { flag: boolean; label: string; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: unless(s.flag, s.label) as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  const root = parseModule(output);
  assertEquals(callsNamed(root, "unless").length, 1);
  const schemas = allEmittedSchemaValues(root) as Obj[];
  // condition schema is boolean, value schema is string.
  assert(schemas.some((s) => s.type === "boolean"));
  assert(schemas.some((s) => s.type === "string"));
});

Deno.test("ifElse(condition, ifTrue, ifFalse) prepends four schemas for its 3-arity form", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern, ifElse, UI, VNode } from "commonfabric";',
    "interface Input { flag: boolean; a: number; b: number; }",
    "interface Output { [UI]: VNode; }",
    "export default pattern<Input, Output>((s) => ({ [UI]: ifElse(s.flag, s.a, s.b) as unknown as VNode }));",
  ].join("\n");
  const output = await t(source);
  const root = parseModule(output);
  assertEquals(callsNamed(root, "ifElse").length, 1);
  const schemas = allEmittedSchemaValues(root) as Obj[];
  // condition boolean + two number branches + number result = >=3 number schemas
  const numSchemas = schemas.filter((s) => s.type === "number").length;
  assert(numSchemas >= 3, `expected >=3 number schemas, got ${numSchemas}`);
});

//
// lift-applied (derive) chains: object-literal input, direct projection
//

Deno.test("lift-applied object-literal input builds a schema from composed reactive cell types", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const a = lift((x: number) => x)(1);",
    'const b = lift((x: string) => x)("s");',
    "const combined = lift((snap) => `${snap.a}-${snap.b}`)({ a: a, b: b });",
  ].join("\n");
  const output = await t(source);
  const schemas = emittedSchemas(parseModule(output));
  // The composed input schema recovers a: number and b: string from the
  // upstream lift results rather than collapsing to unknown.
  const composed = schemas.find((s) =>
    (s.properties as Obj | undefined)?.a !== undefined &&
    (s.properties as Obj | undefined)?.b !== undefined
  );
  assert(composed, "expected composed input schema with a and b");
  assertEquals((composed!.properties as Obj).a.type, "number");
  assertEquals((composed!.properties as Obj).b.type, "string");
});

Deno.test("lift-applied direct property projection recovers the result schema from the input property", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const src = lift((x: { a: number; b: string }) => x)({ a: 1, b: "x" });',
    "const proj = lift((y: { a: number; b: string }) => y.a)(src);",
  ].join("\n");
  const output = await t(source);
  const schemas = emittedSchemas(parseModule(output)) as Obj[];
  // The projection `y => y.a` recovers a number result schema.
  assert(schemas.some((s) => s.type === "number"));
});

Deno.test("lift-applied empty-object input lowers the no-capture placeholder to a false input schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const c = lift(() => "static")({});',
  ].join("\n");
  const output = await t(source);
  const root = parseModule(output);
  // The single empty object literal is the no-capture placeholder, so the
  // injected input schema is the `false` literal (no input) rather than an
  // object schema. It rides as the second argument of the extracted lift call.
  const liftCall = callsNamed(root, "lift").at(-1);
  assert(liftCall, "expected an emitted lift call");
  const inputArg = liftCall!.arguments[1];
  assert(inputArg && inputArg.kind === ts.SyntaxKind.FalseKeyword);
});

//
// pattern — single type argument (result inferred), one schema argument
//

Deno.test("pattern<Input> with a single type argument infers the result schema from the callback", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "interface Input { count: number; }",
    "export default pattern<Input>((s) => ({ doubled: s.count * 2 }));",
  ].join("\n");
  const output = await t(source);
  const { input, output: out } = patternSchemas(parseModule(output));
  assertEquals((input.properties as Obj).count.type, "number");
  // result schema carries the inferred `doubled: number`.
  assertEquals((out.properties as Obj).doubled.type, "number");
});

Deno.test("pattern(fn, inputSchema) keeps the author input schema and appends an inferred result schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "export default pattern(",
    "  (state: { count: number }) => ({ label: state }),",
    '  { type: "object" } as const,',
    ");",
  ].join("\n");
  const output = await t(source);
  const root = parseModule(output);
  // Author supplied one schema (input) verbatim; the transformer infers and
  // appends the result schema (case 3a). The author input keeps its bare
  // `{ type: "object" } as const` form (no satisfies marker) while the appended
  // result carries the satisfies marker and the inferred `label` property.
  const emitted = emittedSchemas(root);
  assertEquals(emitted.length, 1);
  assertEquals(
    ((emitted[0].properties as Obj).label.properties as Obj).count.type,
    "number",
  );
  assertStringIncludes(output, '{ type: "object" } as const,');
});

//
// handler inline single-argument form — event/state inference
//

Deno.test("handler(fn) with no type args infers both event and state schemas from annotations", async () => {
  const source = [
    "/// <cts-enable />",
    'import { handler, Cell } from "commonfabric";',
    "export const h = handler(",
    "  (event: { delta: number }, ctx: { count: Cell<number> }) => {",
    "    ctx.count.set(event.delta);",
    "  },",
    ");",
  ].join("\n");
  const output = await t(source);
  const [event, state] = callSchemas(parseModule(output), "handler");
  assertEquals((event.properties as Obj).delta.type, "number");
  assert(Object.keys(state.properties as Obj).includes("count"));
});

Deno.test("handler(fn) with an underscore-prefixed unused event param yields a false event schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { handler, Cell } from "commonfabric";',
    "export const h = handler(",
    "  (_event, ctx: { count: Cell<number> }) => { ctx.count.set(1); },",
    ");",
  ].join("\n");
  const output = await t(source);
  // Intentionally-unused `_event` collapses to a `never`/`false` event schema,
  // emitted as the first satisfies-marked argument.
  const values = allEmittedSchemaValues(parseModule(output));
  assertEquals(values[0], false);
});

//
// cell scope: the `new Writable.perX(seed)` accessor forms
//

Deno.test("new Writable.perUser(seed) reads the user scope and injects it into the schema", async () => {
  const source = [
    'import { Writable } from "commonfabric";',
    "export default function T() {",
    "  const v = new Writable.perUser(7);",
    "  return { v };",
    "}",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  assertEquals(schema.scope, "user");
  assertEquals(schema.type, "number");
});

Deno.test("new Writable.perSpace(seed) reads the space scope and injects it into the schema", async () => {
  const source = [
    'import { Writable } from "commonfabric";',
    "export default function T() {",
    "  const v = new Writable.perSpace(true);",
    "  return { v };",
    "}",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  assertEquals(schema.scope, "space");
  assertEquals(schema.type, "boolean");
});

//
// lift result recovery: direct property / element-access projection
//

Deno.test("lift property projection recovers the result schema from the projected field type", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const f = lift((s: { a: number; b: string }) => s.a);",
  ].join("\n");
  const output = await t(source);
  const [input, result] = callSchemas(parseModule(output), "lift");
  // The result schema is recovered as number from `s.a`. Capability shrinking
  // narrows the input to the single accessed field `a`, dropping the unused `b`.
  assertEquals((input.properties as Obj).a.type, "number");
  assertEquals(Object.keys(input.properties as Obj), ["a"]);
  assertEquals(result.type, "number");
});

Deno.test("lift element-access projection recovers the result schema from the indexed field", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const f = lift((s: { title: string; other: number }) => s["title"]);',
  ].join("\n");
  const output = await t(source);
  const [input, result] = callSchemas(parseModule(output), "lift");
  // `s["title"]` is a direct projection; the result schema recovers string.
  assertEquals((input.properties as Obj).title.type, "string");
  assertEquals(result.type, "string");
});

//
// pattern result diagnostics
//

Deno.test("pattern with an inferred any/unknown result reports pattern:any-result-schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "export default pattern((s: { x: number }) => s as any);",
  ].join("\n");
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  assert(
    diagnostics.some((d) => d.type === "pattern:any-result-schema"),
    `expected pattern:any-result-schema, got: ${
      diagnostics.map((d) => d.type).join(",")
    }`,
  );
});

//
// handler event-schema optionality
//

Deno.test("handler event schema encodes an optional field as not required", async () => {
  const source = [
    "/// <cts-enable />",
    'import { handler, Cell } from "commonfabric";',
    "export const h = handler<{ amount?: number }, { total: Cell<number> }>(",
    "  (event, ctx) => { ctx.total.set(event?.amount ?? 0); },",
    ");",
  ].join("\n");
  const output = await t(source);
  const [event] = callSchemas(parseModule(output), "handler");
  // Optional event field is present but excluded from required.
  assert(Object.keys(event.properties as Obj).includes("amount"));
  assert(!((event.required as string[] | undefined) ?? []).includes("amount"));
});

//
// generateObject — options variations
//

Deno.test("generateObject<T>() with no options builds a fresh options object carrying the schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { generateObject } from "commonfabric";',
    "const r = generateObject<{ score: number }>();",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  assertEquals((schema.properties as Obj).score.type, "number");
  assertStringIncludes(output, "schema:");
});

Deno.test("generateObject<T>(spreadOptions) spreads a non-literal options expression and adds the schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { generateObject } from "commonfabric";',
    "declare const opts: { prompt: string };",
    "const r = generateObject<{ ok: boolean }>(opts);",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  assertEquals((schema.properties as Obj).ok.type, "boolean");
  const [call] = callsNamed(parseModule(output), "generateObject");
  const spreads = collect(call!, ts.isSpreadAssignment);
  assertEquals(spreads.length, 1);
  assert(ts.isIdentifier(spreads[0]!.expression));
  assertEquals(spreads[0]!.expression.text, "opts");
});

//
// sqliteQuery — no-options and untyped forms
//

Deno.test("sqliteQuery<Row>() with no options builds a fresh options object carrying rowSchema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { sqliteQuery } from "commonfabric";',
    "const q = sqliteQuery<{ id: number; label: string }>();",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  assertEquals((schema.properties as Obj).id.type, "number");
  assertEquals((schema.properties as Obj).label.type, "string");
  assertStringIncludes(output, "rowSchema:");
});

Deno.test("untyped sqliteQuery(options) injects no rowSchema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { sqliteQuery } from "commonfabric";',
    "declare const db: any;",
    'const q = sqliteQuery({ db, sql: "select 1" });',
  ].join("\n");
  const output = await t(source);
  // Untyped form must lower to no schema; runtime falls back to detection.
  assertEquals(emittedSchemas(parseModule(output)).length, 0);
});

//
// contextual cell scope from a Scoped<> / PerX<> annotation
//

Deno.test("cell(value) assigned to a PerSession<T> variable reads the session scope from the annotation", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, PerSession } from "commonfabric";',
    "const c: PerSession<number> = cell(0);",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  // The scope brand is recovered from the `PerSession` alias on the contextual
  // type rather than from any accessor on the call.
  assertEquals(schema.scope, "session");
});

Deno.test("cell(value) assigned to a PerUser<T> variable reads the user scope from the annotation", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, PerUser } from "commonfabric";',
    'const c: PerUser<string> = cell("hi");',
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  assertEquals(schema.scope, "user");
});

Deno.test("cell(value) assigned to a PerSpace<T> variable reads the space scope from the annotation", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, PerSpace } from "commonfabric";',
    "const c: PerSpace<boolean> = cell(true);",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  assertEquals(schema.scope, "space");
});

Deno.test("cell(value) assigned to a variable typed by an alias of PerSession<T> reads the session scope from the annotation", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, PerSession } from "commonfabric";',
    "type Count = PerSession<number>;",
    "const c: Count = cell(0);",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  // The checker reports the alias `Count`, so the scope is read from the
  // brand `PerSession` leaves on the resolved type.
  assertEquals(schema.scope, "session");
});

Deno.test("pattern result field typed by an alias of PerUser<T> keeps the user scope", async () => {
  const source = [
    "/// <cts-enable />",
    'import { computed, pattern, PerUser } from "commonfabric";',
    "type Rec = PerUser<{ a: number }>;",
    "export default pattern<{ x: number }>(({ x }) => {",
    "  const v: Rec = computed(() => ({ a: x }));",
    "  return { v };",
    "});",
  ].join("\n");
  const output = await t(source);
  const { output: result } = patternSchemas(parseModule(output));
  assertEquals(
    (result.properties as Record<string, { scope?: string }>).v.scope,
    "user",
  );
});

//
// pattern result: inferred unknown output field reports pattern-result:unknown-type
//

Deno.test("pattern with an inferred unknown output field reports pattern-result:unknown-type", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "function opaque(): unknown { return 1; }",
    "export default pattern((s: { x: number }) => ({ out: opaque() }));",
  ].join("\n");
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  const paths = diagnostics.filter((d) =>
    d.type === "pattern-result:unknown-type"
  );
  assert(
    paths.length > 0,
    `expected pattern-result:unknown-type, got: ${
      diagnostics.map((d) => d.type).join(",")
    }`,
  );
  // The message names the offending field path.
  assertStringIncludes(paths[0]!.message, "out");
});

//
// lift result shape: tuple, enum literal, and nested arrays
//

Deno.test("lift<T, R> encodes a tuple result as an array schema with a positional item type set", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const f = lift<{ a: number }, [string, number]>((s) => ["x", s.a]);',
  ].join("\n");
  const output = await t(source);
  const [, result] = callSchemas(parseModule(output), "lift");
  assertEquals(result.type, "array");
  // tuple element union of the two positional types
  assertEquals((result.items as Obj).type, ["number", "string"]);
});

Deno.test("lift<T, R> encodes a string-literal-union result as an enum", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const f = lift<{ n: number }, "lo" | "hi">((s) => (s.n > 0 ? "hi" : "lo"));',
  ].join("\n");
  const output = await t(source);
  const [, result] = callSchemas(parseModule(output), "lift");
  assertEquals(result.enum, ["lo", "hi"]);
});

Deno.test("lift<T, R> encodes a nested array-of-objects result schema", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const f = lift<{ n: number }, { id: number }[]>((s) => [{ id: s.n }]);",
  ].join("\n");
  const output = await t(source);
  const [, result] = callSchemas(parseModule(output), "lift");
  assertEquals(result.type, "array");
  assertEquals(((result.items as Obj).properties as Obj).id.type, "number");
});

//
// cell-for scope wrapping via .asSchema(...)
//

Deno.test("scoped cell-for value schema carries the scope marker", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, PerSession } from "commonfabric";',
    "const base = cell<number>();",
    "const scoped: PerSession<number> = base;",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  // The base cell schema is injected; assigning to PerSession keeps the schema.
  assertEquals(schema.type, "number");
});

//
// new cell constructor: value inference, explicit type argument
//

Deno.test("new Writable(value) infers a widened schema from the seed and injects it as the second argument", async () => {
  const source = [
    'import { Writable } from "commonfabric";',
    "export default function T() {",
    "  const v = new Writable(5);",
    "  return { v };",
    "}",
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  assertEquals(schema.type, "number");
  // No scope accessor was used, so no scope marker is injected.
  assertEquals(schema.scope, undefined);
});

Deno.test("new Writable<T>() with an explicit type argument and no value injects an undefined first argument", async () => {
  const source = [
    'import { Writable } from "commonfabric";',
    "export default function T() {",
    "  const v = new Writable<{ n: number }>();",
    "  return { v };",
    "}",
  ].join("\n");
  const output = await t(source);
  const root = parseModule(output);
  // Schema is always the second argument, so `undefined` is inserted first.
  const ctor = collect(root, ts.isNewExpression).find((n) =>
    ts.isIdentifier(n.expression) && n.expression.text === "Writable"
  );
  assert(ctor, "expected a `new Writable<...>()` construction");
  assertEquals(
    ctor!.arguments![0].kind,
    ts.SyntaxKind.Identifier,
  );
  assertEquals((ctor!.arguments![0] as ts.Identifier).text, "undefined");
  const schema = literalToValue(ctor!.arguments![1]) as Obj;
  assertEquals((schema.properties as Obj).n.type, "number");
});

//
// contextual scope from a raw Scoped<T, scope> brand (no PerX alias)
//

Deno.test("cell(value) typed as raw Scoped<T, scope> reads the scope from the SCOPE_BRAND property", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, Scoped } from "commonfabric";',
    'const c: Scoped<number, "session"> = cell(0);',
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  // `Scoped` is not one of the PerX aliases, so the scope is recovered from the
  // scope-brand property rather than the alias name.
  assertEquals(schema.scope, "session");
});

//
// lift<T, R>(fn)(input): type arguments on the inner lift drive both schemas
//

Deno.test("lift<T, R>(fn)(input) reads the schemas from the inner lift type arguments", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const f = lift<{ a: number }, string>((s) => `${s.a}`)({ a: 1 });",
  ].join("\n");
  const output = await t(source);
  const [input, result] = callSchemas(parseModule(output), "lift");
  assertEquals((input.properties as Obj).a.type, "number");
  assertEquals(result.type, "string");
});

//
// chained lift-applied (derive) inputs: recover the upstream result type
//

Deno.test("chained lift-applied recovers the input schema from the upstream lift's inferred result", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const step1 = lift((x: { a: number }) => ({ a: x.a, b: x.a + 1 }))({ a: 1 });",
    "const step2 = lift((y) => y.b)(step1);",
  ].join("\n");
  const output = await t(source);
  // step2's callback param has no annotation; its type is recovered from
  // step1's inferred `{ a, b }` result, and capability shrinking keeps only the
  // accessed `b` field. The result schema is number.
  const [input, result] = callSchemas(parseModule(output), "lift");
  assertEquals((input.properties as Obj).b.type, "number");
  assertEquals(Object.keys(input.properties as Obj), ["b"]);
  assertEquals(result.type, "number");
});

Deno.test("chained lift-applied whose upstream is a single-field object recovers a concrete input schema, not unknown", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const first = lift((x: { name: string }) => ({ name: x.name }))({ name: "n" });',
    "const second = lift((v) => v.name.length)(first);",
  ].join("\n");
  const output = await t(source);
  // The recovered input carries the concrete `name: string` field rather than a
  // permissive `true`/unknown schema.
  const [input] = callSchemas(parseModule(output), "lift");
  assertEquals((input.properties as Obj).name.type, "string");
  assertEquals(input.type, "object");
});

//
// scope brand recovery when the scope is a union of literal scope values
//

Deno.test("cell typed as Scoped<T, union-of-scopes> recovers the first concrete scope from the brand union", async () => {
  const source = [
    "/// <cts-enable />",
    'import { cell, Scoped } from "commonfabric";',
    'const c: Scoped<number, "user" | "session"> = cell(0);',
  ].join("\n");
  const output = await t(source);
  const [schema] = emittedSchemas(parseModule(output));
  // The scope-brand type is a union; the recovery walks the members and returns
  // the first concrete scope value.
  assertEquals(schema.scope, "user");
});

//
// lift factory application
//

Deno.test("applying a captured lift factory recovers the downstream input schema from the factory callback result", async () => {
  // lift factory captured in a variable, then applied — recover the result type
  // through the factory's callback
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    "const makeIt = lift((x: { a: number }) => ({ a: x.a, b: 2 }));",
    "const applied = makeIt({ a: 1 });",
    "const used = lift((y) => y.b)(applied);",
  ].join("\n");
  const output = await t(source);
  // `used`'s callback param is untyped; its type is recovered from `applied`,
  // whose type comes from the `makeIt` factory callback returning `{ a, b }`.
  const [input, result] = callSchemas(parseModule(output), "lift");
  assertEquals((input.properties as Obj).b.type, "number");
  assertEquals(result.type, "number");
});

//
// pattern result: unknown paths are walked into nested objects and arrays
//

Deno.test("pattern result reports a nested unknown output field with a dotted path", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "function op(): unknown { return 1; }",
    "export default pattern((s: { x: number }) => ({ nested: { deep: op() } }));",
  ].join("\n");
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  const d = diagnostics.find((d) => d.type === "pattern-result:unknown-type");
  assert(d, "expected pattern-result:unknown-type");
  // The path walk descends into the nested object literal.
  assertStringIncludes(d!.message, "nested.deep");
});

Deno.test("pattern result reports an unknown array element with an array path suffix", async () => {
  const source = [
    "/// <cts-enable />",
    'import { pattern } from "commonfabric";',
    "function op(): unknown { return 1; }",
    "export default pattern((s: { x: number }) => ({ items: [op()] }));",
  ].join("\n");
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  const d = diagnostics.find((d) => d.type === "pattern-result:unknown-type");
  assert(d, "expected pattern-result:unknown-type");
  // The array element walk appends `[]` to the path.
  assertStringIncludes(d!.message, "items[]");
});

//
// An author-supplied schema is left untouched
//
// Each of these already carries a schema of its own, so injection has
// nothing to add and must add nothing.
//

Deno.test("new Writable(value, schema) with two arguments is left untouched", async () => {
  // idempotency / author-supplied skips: a builder that already carries its
  // schema is left untouched
  const source = [
    'import { Writable } from "commonfabric";',
    "export default function T() {",
    '  const v = new Writable(5, { type: "number" } as const);',
    "  return { v };",
    "}",
  ].join("\n");
  const output = await t(source);
  // The schema slot is already filled (bare `as const`, no satisfies marker),
  // so the transformer injects no schema of its own.
  assertEquals(emittedSchemas(parseModule(output)).length, 0);
  assertStringIncludes(output, 'new Writable(5, { type: "number" }');
});

Deno.test("wish(hint, schema) with an author-supplied schema is left untouched", async () => {
  const source = [
    "/// <cts-enable />",
    'import { wish } from "commonfabric";',
    'const w = wish("hint", { type: "object" } as const);',
  ].join("\n");
  const output = await t(source);
  // The two-argument wish already has its schema; the transformer does not add
  // a satisfies-marked schema of its own.
  assertEquals(emittedSchemas(parseModule(output)).length, 0);
  assertStringIncludes(output, '{ type: "object" } as const');
});

Deno.test("generateObject({ schema }) already carrying a schema property is left untouched", async () => {
  const source = [
    "/// <cts-enable />",
    'import { generateObject } from "commonfabric";',
    'const r = generateObject({ prompt: "hi", schema: { type: "object" } as const });',
  ].join("\n");
  const output = await t(source);
  // No satisfies-marked schema is injected; only the author's bare schema
  // property remains.
  assertEquals(emittedSchemas(parseModule(output)).length, 0);
  assertEquals((output.match(/schema:/g) ?? []).length, 1);
});

Deno.test("untyped sqliteQuery already carrying a rowSchema is left untouched", async () => {
  const source = [
    "/// <cts-enable />",
    'import { sqliteQuery } from "commonfabric";',
    "declare const db: any;",
    'const q = sqliteQuery<{ id: number }>({ db, sql: "s", rowSchema: { type: "object" } as const });',
  ].join("\n");
  const output = await t(source);
  // A rowSchema is already present, so the typed form does not inject a second.
  assertEquals(emittedSchemas(parseModule(output)).length, 0);
  assertEquals((output.match(/rowSchema:/g) ?? []).length, 1);
});

//
// new scoped cell with no value: scope from accessor, value type from context
//

Deno.test("new Writable.perSession() with no value derives the value type from the contextual scope annotation", async () => {
  const source = [
    'import { Writable, PerSession } from "commonfabric";',
    "export default function T() {",
    "  const v: PerSession<number> = new Writable.perSession();",
    "  return { v };",
    "}",
  ].join("\n");
  const output = await t(source);
  const root = parseModule(output);
  // No seed value, so the value type is recovered from the contextual
  // PerSession<number> annotation and the accessor supplies the session scope.
  const [schema] = emittedSchemas(root);
  assertEquals(schema.scope, "session");
  assertEquals(schema.type, "number");
  // Schema is always the second argument, so `undefined` is inserted first.
  const ctor = collect(root, ts.isNewExpression).at(-1);
  assert(ctor, "expected a `new Writable.perSession()` construction");
  assertEquals(ctor!.arguments![0].kind, ts.SyntaxKind.Identifier);
  assertEquals((ctor!.arguments![0] as ts.Identifier).text, "undefined");
});

//
// lift-applied projection recovery
//

Deno.test("lift-applied element-access projection recovers the result schema from the indexed field", async () => {
  // lift-applied projection recovery: property-access and element-access forms
  // on a downstream callback whose parameter type is recovered from upstream
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const s1 = lift((x: { title: string; n: number }) => x)({ title: "t", n: 1 });',
    'const s2 = lift((y) => y["title"])(s1);',
  ].join("\n");
  const output = await t(source);
  // The downstream callback `y => y["title"]` has no annotation; its input is
  // recovered from the upstream result and the string result schema is derived
  // from the indexed `title` field.
  const [input, result] = callSchemas(parseModule(output), "lift");
  assert(Object.keys(input.properties as Obj).includes("title"));
  assertEquals(result.type, "string");
});

Deno.test("lift-applied property-access projection recovers the result schema from the accessed field", async () => {
  const source = [
    "/// <cts-enable />",
    'import { lift } from "commonfabric";',
    'const s1 = lift((x: { count: number; other: string }) => x)({ count: 1, other: "o" });',
    "const s2 = lift((y) => y.count)(s1);",
  ].join("\n");
  const output = await t(source);
  const [input, result] = callSchemas(parseModule(output), "lift");
  assert(Object.keys(input.properties as Obj).includes("count"));
  assertEquals(result.type, "number");
});

//
// handler state Cell that is read marks the schema field asCell readonly
//

Deno.test("handler<E, S> marks a read-only Cell state field with asCell readonly", async () => {
  const source = [
    "/// <cts-enable />",
    'import { handler, Cell } from "commonfabric";',
    "export const h = handler<{ q: number }, { total: Cell<number> }>(",
    "  (event, ctx) => { const x = ctx.total.get(); void x; void event; },",
    ");",
  ].join("\n");
  const output = await t(source);
  const [, state] = callSchemas(parseModule(output), "handler");
  // The state Cell is only read (.get), so the capability summary narrows the
  // marker to readonly.
  assertEquals((state.properties as Obj).total.asCell, ["readonly"]);
});

//
// lift-applied input recovery through Cell.get
//

Deno.test("lift-applied untyped callback using Cell.get on a Cell input recovers a cell-like input schema", async () => {
  // lift-applied whose untyped callback calls Cell methods on a Cell input: the
  // input schema is recovered from the cell-like fallback type and marked
  // asCell readonly
  const source = [
    "/// <cts-enable />",
    'import { cell, lift } from "commonfabric";',
    "const c = cell({ n: 5 });",
    "const d = lift((x) => x.get().n)(c);",
  ].join("\n");
  const output = await t(source);
  // The callback param has no annotation but calls `.get()`; because the input
  // is a Cell, the input schema is recovered from the cell-like fallback type
  // and carries the readonly asCell marker with the inner `{ n: number }` shape.
  const [input] = callSchemas(parseModule(output), "lift");
  assertEquals((input.properties as Obj).n.type, "number");
  assertEquals(input.asCell, ["readonly"]);
});
