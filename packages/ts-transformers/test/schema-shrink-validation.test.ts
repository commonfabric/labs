import {
  assert,
  assertEquals,
  assertGreater,
  assertStringIncludes,
} from "@std/assert";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { emittedSchemas, parseModule } from "./transformed-ast.ts";

/** Evaluated emitted schema object literals from transformed output, in order. */
function schemasOf(output: string): Record<string, unknown>[] {
  return emittedSchemas(parseModule(output));
}

/**
 * Every property key that appears anywhere in a JSON schema, walking into
 * `properties`, `items`, `additionalProperties`, `anyOf`/`allOf`/`oneOf`, and
 * `$defs`. Lets a test assert that a field survived (or was dropped from)
 * schema shrinking without matching printed text.
 */
function schemaPropertyNames(schema: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const element of node) visit(element);
      return;
    }
    if (!isObjectOrArray(node)) return;
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (isObjectOrArray(properties)) {
      for (const key of Object.keys(properties)) names.add(key);
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(schema);
  return names;
}

/**
 * True when a schema preserves `undefined` as a union member — either as an
 * `anyOf` entry `{ type: "undefined" }` or as `"undefined"` inside a
 * `type: [...]` array.
 */
function hasUndefinedMember(schema: unknown): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found) return;
    if (Array.isArray(node)) {
      for (const element of node) visit(element);
      return;
    }
    if (!isObjectOrArray(node)) return;
    const record = node as Record<string, unknown>;
    const type = record.type;
    if (type === "undefined") found = true;
    if (Array.isArray(type) && type.includes("undefined")) found = true;
    for (const value of Object.values(record)) visit(value);
  };
  visit(schema);
  return found;
}

function getErrors(diagnostics: readonly TransformationDiagnostic[]) {
  return diagnostics.filter((d) => d.severity === "error");
}

function outputWindow(output: string, startNeedle: string, endNeedle: string) {
  const start = output.indexOf(startNeedle);
  const end = start === -1 ? -1 : output.indexOf(endNeedle, start);
  if (start === -1 || end === -1) return "";
  return output.slice(start, end + endNeedle.length);
}

Deno.test("Schema Shrink Validation", async (t) => {
  await t.step(
    "errors when parameter is 'unknown' but code accesses properties",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export default pattern((state: unknown) => {",
        "  const x = state.foo;",
        "  const y = state.bar;",
        "  return { x, y };",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected at least one schema:unknown-type-access error",
      );
      assertEquals(shrinkErrors[0]!.type, "schema:unknown-type-access");
    },
  );

  await t.step(
    "errors when declared type is missing an accessed property",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export default pattern((state: { a: string }) => {",
        "  const x = state.a;",
        "  const y = state.b;",
        "  return { x, y };",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:path-not-in-type",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected at least one schema:path-not-in-type error",
      );
      assertEquals(shrinkErrors[0]!.type, "schema:path-not-in-type");
    },
  );

  await t.step(
    "errors on interprocedural unknown-type access in lift callback",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "const helper = (x: unknown) => (x as any).foo;",
        "",
        "const fn = lift((state: unknown) => helper(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected schema:unknown-type-access from interprocedural lift",
      );
    },
  );

  await t.step(
    "errors on interprocedural path-not-in-type via as-any cast in lift callback",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "const helper = (x: { a: string }) => (x as any).b;",
        "",
        "const fn = lift((state: { a: string }) => helper(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:path-not-in-type",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected schema:path-not-in-type from interprocedural as-any cast",
      );
    },
  );

  await t.step(
    "errors when unknown parameter is passed to opaque function in lift",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift((state: unknown) => console.log(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected schema:unknown-type-access for unknown param passed to opaque function",
      );
    },
  );

  await t.step(
    "no error when any parameter is passed to opaque function in lift",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift((state: any) => console.log(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no schema:unknown-type-access for 'any' but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when unknown parameter is passed to equals in lift",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { equals, lift } from "commonfabric";',
        "",
        "const fn = lift((state: unknown) => equals(state, state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no schema:unknown-type-access for equals(identity) but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when concrete type is passed to opaque function in lift",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift((state: { a: string }) => console.log(state));",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no errors for concrete type but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "errors when unknown parameter is passed to opaque function in pattern",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export default pattern((state: unknown) => {",
        "  console.log(state);",
        "  return {};",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected schema:unknown-type-access for unknown param in pattern passed to opaque function",
      );
    },
  );

  await t.step(
    "errors when interface property is typed unknown in handler",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "interface BatchEvent {",
        "  amounts?: unknown;",
        "  note?: unknown;",
        "}",
        "",
        "export const h = handler(",
        "  (event: BatchEvent) => {",
        "    const x = event.amounts;",
        "    return {};",
        "  },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected schema:unknown-type-access for unknown-typed property in interface",
      );
    },
  );

  await t.step(
    "errors when interface property is typed unknown in pattern",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "interface State {",
        "  data?: unknown;",
        "}",
        "",
        "export default pattern((state: State) => {",
        "  const x = state.data;",
        "  return { x };",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        "Expected schema:unknown-type-access for unknown-typed property in pattern",
      );
    },
  );

  await t.step(
    "no error when interface property is typed any (not unknown)",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "interface BatchEvent {",
        "  amounts?: any;",
        "}",
        "",
        "export const h = handler(",
        "  (event: BatchEvent) => {",
        "    const x = event.amounts;",
        "    return {};",
        "  },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no schema:unknown-type-access for 'any'-typed property but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when interface property is typed with concrete type",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "interface BatchEvent {",
        "  amounts?: number[];",
        "  note?: string;",
        "}",
        "",
        "export const h = handler(",
        "  (event: BatchEvent) => {",
        "    const x = event.amounts;",
        "    return {};",
        "  },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:unknown-type-access",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no schema:unknown-type-access for concrete-typed properties but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when handler parameter type is a type alias",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "type Req = { item: string };",
        "",
        "export const h = handler<Req, {}>(",
        "  (args) => { console.log(args.item); },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for type alias but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no diagnostic when declared type matches all accessed paths",
    async () => {
      const source = [
        'import { pattern } from "commonfabric";',
        "",
        "export default pattern((state: { a: string; b: number }) => {",
        "  const x = state.a;",
        "  const y = state.b;",
        "  return { x, y };",
        "});",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when handler parameter is T | undefined",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "export const h = handler<{ amount?: number } | undefined, {}>(",
        "  (args) => { console.log(args.amount); },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for T | undefined but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when handler parameter is a multi-member union",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "export const h = handler<{ value?: number } | number | undefined, {}>(",
        "  (args) => { console.log(args.value); },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for multi-member union but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when handler parameter is TypeAlias | undefined",
    async () => {
      const source = [
        'import { handler } from "commonfabric";',
        "",
        "interface Req { item: string }",
        "",
        "export const h = handler<Req | undefined, {}>(",
        "  (args) => { console.log(args.item); },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for TypeAlias | undefined but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when lift accesses numeric index on array",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift((items: number[]) => items[0]);",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for array index access but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when lift accesses .length on array type alias",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "type Items = Array<{ name: string }>;",
        "const hasItems = lift<Items, boolean>(",
        "  (items) => items && items.length > 0,",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for .length on array type alias but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "errors when lift accesses .length on numeric index signature object",
    async () => {
      const source = [
        'import { lift } from "commonfabric";',
        "",
        "type Indexed = { [index: number]: string };",
        "const hasItems = lift<Indexed, boolean>(",
        "  (items) => items.length > 0,",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) => e.type === "schema:path-not-in-type",
      );
      assertGreater(
        shrinkErrors.length,
        0,
        `Expected schema:path-not-in-type for numeric index signature .length access but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
    },
  );

  await t.step(
    "no error when handler without type args has SomeType | undefined param",
    async () => {
      // Reproduces pattern-ingredient-scaler: handler() without type args
      // where the callback param is SomeType | undefined and accesses a property.
      const source = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "interface ServingsEvent { servings?: number; delta?: number }",
        "",
        "const setServings = handler(",
        "  (event: ServingsEvent | undefined, context: { desiredServings: Cell<number> }) => {",
        "    context.desiredServings.set(event?.servings ?? 1);",
        "  },",
        ");",
      ].join("\n");
      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(diagnostics);
      const shrinkErrors = errors.filter(
        (e) =>
          e.type === "schema:unknown-type-access" ||
          e.type === "schema:path-not-in-type",
      );
      assertEquals(
        shrinkErrors.length,
        0,
        `Expected no shrink errors for handler with SomeType | undefined but got: ${
          shrinkErrors.map((e) => e.message).join("; ")
        }`,
      );
    },
  );

  //
  // Type-arg form against inline form
  //
  // The two spellings of a signature — a type argument, or an annotated
  // callback parameter — should produce the same schemas. Optional-property
  // encoding is a known remaining divergence, noted where it bites.
  //

  await t.step(
    "handler<E, T> generates same schemas as handler((e: E, t: T) => ...)",
    async () => {
      const sourceTypeArgs = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "export const h = handler<{ amount: number }, { total: Cell<number> }>(",
        "  (event, ctx) => { ctx.total.set(event.amount); },",
        ");",
      ].join("\n");
      const sourceInline = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "export const h = handler(",
        "  (event: { amount: number }, ctx: { total: Cell<number> }) => {",
        "    ctx.total.set(event.amount);",
        "  },",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `handler<E,T> form had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `handler inline form had shrink errors: ${
          fmtErrors(rInline.diagnostics)
        }`,
      );
      const schemasTA = schemasOf(rTA.output);
      const schemasInline = schemasOf(rInline.output);
      assertEquals(
        schemasTA,
        schemasInline,
        "handler schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "handler<E | undefined, T> preserves | undefined in both forms",
    async () => {
      // Both forms preserve `| undefined` in the event schema.
      // Remaining divergence: optional property encoding differs
      // (type-arg: {type:"number"}, inline: {anyOf:[{type:"number"},{type:"undefined"}]}).
      const sourceTypeArgs = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "export const h = handler<{ amount?: number } | undefined, { total: Cell<number> }>(",
        "  (event, ctx) => { ctx.total.set(event?.amount ?? 0); },",
        ");",
      ].join("\n");
      const sourceInline = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "export const h = handler(",
        "  (event: { amount?: number } | undefined, ctx: { total: Cell<number> }) => {",
        "    ctx.total.set(event?.amount ?? 0);",
        "  },",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `handler<E|undefined,T> had shrink errors: ${
          fmtErrors(rTA.diagnostics)
        }`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `handler inline union form had shrink errors: ${
          fmtErrors(rInline.diagnostics)
        }`,
      );
      const schemasTA = schemasOf(rTA.output);
      const schemasInline = schemasOf(rInline.output);
      // Both event schemas should preserve `undefined` as a union member.
      assert(
        hasUndefinedMember(schemasTA[0]!),
        "type-arg event schema should preserve undefined",
      );
      assert(
        hasUndefinedMember(schemasInline[0]!),
        "inline event schema should preserve undefined",
      );
      // State schemas (second schema) should match exactly
      assertEquals(
        schemasTA[1],
        schemasInline[1],
        "handler state schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "handler<TypeAlias | undefined, TypeAlias> preserves | undefined in both forms",
    async () => {
      const sourceTypeArgs = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "interface ScaleEvent { servings?: number; delta?: number }",
        "interface ScaleState { desiredServings: Cell<number> }",
        "",
        "export const h = handler<ScaleEvent | undefined, ScaleState>(",
        "  (event, ctx) => { ctx.desiredServings.set(event?.servings ?? 1); },",
        ");",
      ].join("\n");
      const sourceInline = [
        'import { type Cell, handler } from "commonfabric";',
        "",
        "interface ScaleEvent { servings?: number; delta?: number }",
        "interface ScaleState { desiredServings: Cell<number> }",
        "",
        "export const h = handler(",
        "  (event: ScaleEvent | undefined, ctx: ScaleState) => {",
        "    ctx.desiredServings.set(event?.servings ?? 1);",
        "  },",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `handler<TypeAlias> had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `handler inline alias form had shrink errors: ${
          fmtErrors(rInline.diagnostics)
        }`,
      );
      const schemasTA = schemasOf(rTA.output);
      const schemasInline = schemasOf(rInline.output);
      // Both event schemas should preserve `undefined` as a union member.
      assert(
        hasUndefinedMember(schemasTA[0]!),
        "type-arg event schema should preserve undefined",
      );
      assert(
        hasUndefinedMember(schemasInline[0]!),
        "inline event schema should preserve undefined",
      );
      // State schemas (second schema) should match exactly
      assertEquals(
        schemasTA[1],
        schemasInline[1],
        "handler state schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "lift<T, R> generates same schemas as lift((x: T): R => ...)",
    async () => {
      const sourceTypeArgs = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift<{ count: number }, string>(",
        "  (state) => `count: ${state.count}`,",
        ");",
      ].join("\n");
      const sourceInline = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift(",
        "  (state: { count: number }): string => `count: ${state.count}`,",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `lift<T,R> had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `lift inline had shrink errors: ${fmtErrors(rInline.diagnostics)}`,
      );
      const schemasTA = schemasOf(rTA.output);
      const schemasInline = schemasOf(rInline.output);
      assertEquals(
        schemasTA,
        schemasInline,
        "lift schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "lift<T | undefined, R> preserves | undefined in both forms",
    async () => {
      // Both forms now preserve `| undefined` in the input schema.
      const sourceTypeArgs = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift<{ count: number } | undefined, number>(",
        "  (state) => state?.count ?? 0,",
        ");",
      ].join("\n");
      const sourceInline = [
        'import { lift } from "commonfabric";',
        "",
        "const fn = lift(",
        "  (state: { count: number } | undefined): number => state?.count ?? 0,",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `lift<T|undefined,R> had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `lift inline union had shrink errors: ${
          fmtErrors(rInline.diagnostics)
        }`,
      );
      const schemasTA = schemasOf(rTA.output);
      const schemasInline = schemasOf(rInline.output);
      // Both input schemas should preserve `undefined` as a union member.
      assert(
        hasUndefinedMember(schemasTA[0]!),
        "type-arg input schema should preserve undefined",
      );
      assert(
        hasUndefinedMember(schemasInline[0]!),
        "inline input schema should preserve undefined",
      );
      // Result schemas (second schema) should match exactly
      assertEquals(
        schemasTA[1],
        schemasInline[1],
        "lift result schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "lift<TypeAlias, R> generates same schemas as lift with inline alias",
    async () => {
      const sourceTypeArgs = [
        'import { lift } from "commonfabric";',
        "",
        "interface Item { name: string; price: number }",
        "",
        "const fn = lift<Item, string>(",
        "  (item) => `${item.name}: $${item.price}`,",
        ");",
      ].join("\n");
      const sourceInline = [
        'import { lift } from "commonfabric";',
        "",
        "interface Item { name: string; price: number }",
        "",
        "const fn = lift(",
        "  (item: Item): string => `${item.name}: $${item.price}`,",
        ");",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `lift<TypeAlias> had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `lift inline alias had shrink errors: ${
          fmtErrors(rInline.diagnostics)
        }`,
      );
      const schemasTA = schemasOf(rTA.output);
      const schemasInline = schemasOf(rInline.output);
      assertEquals(
        schemasTA,
        schemasInline,
        "lift type-alias schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "pattern<T> and inline destructured form produce identical schemas",
    async () => {
      const sourceTypeArgs = [
        'import { pattern } from "commonfabric";',
        "",
        "export default pattern<{ name: string; count: number }>(({ name, count }) => {",
        "  return { name, count };",
        "});",
      ].join("\n");
      const sourceInline = [
        'import { pattern } from "commonfabric";',
        "",
        "export default pattern(({ name, count }: { name: string; count: number }) => {",
        "  return { name, count };",
        "});",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `pattern<T> had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `pattern inline had shrink errors: ${fmtErrors(rInline.diagnostics)}`,
      );
      const schemasTA = schemasOf(rTA.output);
      const schemasInline = schemasOf(rInline.output);
      assertGreater(
        schemasTA.length,
        0,
        "type-arg form should produce schemas",
      );
      assertGreater(
        schemasInline.length,
        0,
        "inline form should produce schemas",
      );
      assertEquals(
        schemasTA,
        schemasInline,
        "pattern schemas should be identical between type-arg and inline forms",
      );
    },
  );

  await t.step(
    "pattern<TypeAlias> and inline destructured alias form produce identical schemas",
    async () => {
      const sourceTypeArgs = [
        'import { pattern } from "commonfabric";',
        "",
        "interface Args { name: string; count: number }",
        "",
        "export default pattern<Args>(({ name, count }) => {",
        "  return { name, count };",
        "});",
      ].join("\n");
      const sourceInline = [
        'import { pattern } from "commonfabric";',
        "",
        "interface Args { name: string; count: number }",
        "",
        "export default pattern(({ name, count }: Args) => {",
        "  return { name, count };",
        "});",
      ].join("\n");
      const rTA = await validateSource(sourceTypeArgs, {
        types: COMMONFABRIC_TYPES,
      });
      const rInline = await validateSource(sourceInline, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(
        getShrinkErrors(rTA.diagnostics).length,
        0,
        `pattern<TypeAlias> had shrink errors: ${fmtErrors(rTA.diagnostics)}`,
      );
      assertEquals(
        getShrinkErrors(rInline.diagnostics).length,
        0,
        `pattern inline alias had shrink errors: ${
          fmtErrors(rInline.diagnostics)
        }`,
      );
      const schemasTA = schemasOf(rTA.output);
      const schemasInline = schemasOf(rInline.output);
      assertGreater(
        schemasTA.length,
        0,
        "type-arg form should produce schemas",
      );
      assertGreater(
        schemasInline.length,
        0,
        "inline form should produce schemas",
      );
      assertEquals(
        schemasTA,
        schemasInline,
        "pattern schemas should be identical between type-arg and inline forms",
      );
    },
  );

  //
  // What shrinking keeps
  //
  // The shrinker follows a value through the callback and drops what nothing
  // reads. These pin the reads it must follow — through loops, fallbacks,
  // aliases, chained array methods, and cell wrappers — so that a field in use
  // survives.
  //

  await t.step(
    "lift object-literal input preserves property schemas",
    async () => {
      const source = [
        'import { cell, lift } from "commonfabric";',
        "",
        'const stage = cell<string>("initial");',
        "const attemptCount = cell<number>(0);",
        "const acceptedCount = cell<number>(0);",
        "const rejectedCount = cell<number>(0);",
        "",
        "const normalizedStage = lift((value: string) => value)(stage);",
        "const attempts = lift((count: number) => count)(attemptCount);",
        "const accepted = lift((count: number) => count)(acceptedCount);",
        "const rejected = lift((count: number) => count)(rejectedCount);",
        "",
        "const _summary = lift((snapshot) =>",
        "  `stage:${snapshot.stage} attempts:${snapshot.attempts}` +",
        "  ` accepted:${snapshot.accepted} rejected:${snapshot.rejected}`",
        ")(",
        "  {",
        "    stage: normalizedStage,",
        "    attempts: attempts,",
        "    accepted: accepted,",
        "    rejected: rejected,",
        "  },",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const snapshotSchema = schemasOf(result.output).find((schema) =>
        (schema.properties as Record<string, unknown> | undefined)?.stage !==
          undefined
      );
      const props = snapshotSchema?.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      // Each object-literal input property carries its own value schema, not
      // the widened `true` schema.
      assertEquals(props?.stage, { type: "string" });
      assertEquals(props?.attempts, { type: "number" });
      assertEquals(props?.accepted, { type: "number" });
      assertEquals(props?.rejected, { type: "number" });
    },
  );

  await t.step(
    "lift validates direct array parameters against item fields used in for...of loops",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type AssetRecord = {",
        "  id: string;",
        "  stage: string;",
        "  owner: string;",
        "  unused: { nested: string };",
        "};",
        "type StageBucket = { id: string; stage: string; owner: string };",
        "const toBuckets = lift((entries: AssetRecord[]): StageBucket[] => {",
        "  const buckets: StageBucket[] = [];",
        "  for (const entry of entries) {",
        "    buckets.push({",
        "      id: entry.id,",
        "      stage: entry.stage,",
        "      owner: entry.owner,",
        "    });",
        "  }",
        "  return buckets;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("id"));
      assert(names.has("stage"));
      assert(names.has("owner"));
      assert(!names.has("unused"));
      assert(!names.has("nested"));
    },
  );

  await t.step(
    "lift validates array unions against item fields used after ?? fallback",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type LeadScoreSummary = {",
        "  id: string;",
        "  score: number;",
        "  unused: string;",
        "};",
        "const liftScoreByLead = lift((list: LeadScoreSummary[] | undefined) => {",
        "  const record: Record<string, number> = {};",
        "  for (const entry of list ?? []) {",
        "    record[entry.id] = entry.score;",
        "  }",
        "  return record;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("id"));
      assert(names.has("score"));
      assert(!names.has("unused"));
    },
  );

  await t.step(
    "lift preserves inherited interface fields used after ?? fallback",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "interface LeadState {",
        "  id: string;",
        "  name: string;",
        "}",
        "interface LeadScoreSummary extends LeadState {",
        "  score: number;",
        "  unused: string;",
        "}",
        "const liftScoreByLead = lift((list: LeadScoreSummary[] | undefined) => {",
        "  const record: Record<string, number> = {};",
        "  for (const entry of list ?? []) {",
        "    record[entry.id] = entry.score;",
        "  }",
        "  return record;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("id"));
      assert(names.has("score"));
      assert(!names.has("name"));
      assert(!names.has("unused"));
    },
  );

  await t.step(
    "lift preserves plain array callback item fields in shrunk schemas",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type Route = { id: string; label: string; capacity: number; unused: string };",
        "const liftLoadMetrics = lift((input: { routeList: Route[] }) =>",
        "  input.routeList.map((route) => ({",
        "    route: route.id,",
        "    label: route.label,",
        "    capacity: route.capacity,",
        "  }))",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("id"));
      assert(names.has("label"));
      assert(names.has("capacity"));
      assert(!names.has("unused"));
    },
  );

  await t.step(
    "lift preserves tracked values stored in local Map lookups",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type Component = { id: string; name: string; props: string[]; unused: string };",
        "const liftNames = lift((input: { components: Component[]; ids: string[] }) => {",
        "  const componentMap = new Map<string, Component>();",
        "  input.components.forEach((component) => componentMap.set(component.id, component));",
        "  return input.ids.map((id) => componentMap.get(id)?.name ?? id);",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("components"));
      assert(names.has("id"));
      assert(names.has("name"));
      assert(!names.has("unused"));
    },
  );

  await t.step(
    "lift preserves tracked values stored in local arrays used by sort callbacks",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type Candidate = { id: string; age: number; site: string; unused: string };",
        "type Result = { candidate: Candidate; eligible: boolean };",
        "const liftIds = lift((input: { candidates: Candidate[] }) => {",
        "  const results: Result[] = [];",
        "  for (const candidate of input.candidates) {",
        "    results.push({ candidate, eligible: candidate.age >= 18 });",
        "  }",
        "  results.sort((left, right) => left.candidate.id.localeCompare(right.candidate.id));",
        "  return results.length;",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("id"));
      assert(names.has("age"));
      assert(!names.has("unused"));
    },
  );

  await t.step(
    "lift preserves element bindings through filter-to-map chains",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type ScreeningResult = {",
        "  candidate: { id: string; site: string; unused: string };",
        "  eligible: boolean;",
        "};",
        "const liftEligibleIds = lift((input: { report: ScreeningResult[] }) =>",
        "  input.report",
        "    .filter((entry) => entry.eligible)",
        "    .map((entry) => entry.candidate.id)",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("eligible"));
      assert(names.has("candidate"));
      assert(names.has("id"));
      assert(!names.has("unused"));
    },
  );

  await t.step(
    "lift preserves properties read from find() result aliases",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type IncidentStep = {",
        "  id: string;",
        "  title: string;",
        "  owner: string;",
        '  status: "pending" | "in_progress";',
        "  expectedMinutes: number;",
        "  elapsedMinutes: number;",
        "};",
        "const liftActiveStepTitle = lift((input: { list: IncidentStep[]; active: string | null }) => {",
        "  const target = input.list.find((step) => step.id === input.active);",
        '  return target ? target.title : "idle";',
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("list"));
      assert(names.has("id"));
      assert(names.has("title"));
      assert(names.has("active"));
      assert(!names.has("owner"));
    },
  );

  await t.step(
    "lift preserves direct properties read from find() results",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type ParkingPerson = {",
        "  name: string;",
        "  priorityRank: number;",
        "  defaultSpot: string;",
        "};",
        "const liftPriority = lift((input: { people: ParkingPerson[] }) =>",
        '  input.people.find((person) => person.name === "Alice")?.priorityRank === 1',
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("people"));
      assert(names.has("name"));
      assert(names.has("priorityRank"));
      assert(!names.has("defaultSpot"));
    },
  );

  await t.step(
    "lift keeps full receiver shape through unknown array methods",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type ParkingPerson = {",
        "  name: string;",
        "  priorityRank: number;",
        "  defaultSpot: string;",
        "  active: boolean;",
        "};",
        "const liftPriority = lift((input: { people: ParkingPerson[]; other: string }) =>",
        '  input.people.filter((person) => person.active).slice(0).find((person) => person.name === "Alice")?.priorityRank === 1',
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("people"));
      assert(names.has("active"));
      assert(names.has("name"));
      assert(names.has("priorityRank"));
      assert(names.has("defaultSpot"));
      assert(!names.has("other"));
    },
  );

  await t.step(
    "lift preserves full receiver shape when identity use overlaps an unknown chain",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { equals, lift } from "commonfabric";',
        "type ParkingPerson = {",
        "  active: boolean;",
        "  name: string;",
        "  priorityRank: number;",
        "  defaultSpot: string;",
        "};",
        "const samePeople = lift((input: { people: ParkingPerson[] }) =>",
        "  equals(",
        "    input.people,",
        "    input.people.filter((person) => person.active).slice(0),",
        "  )",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("people"));
      assert(names.has("active"));
      assert(names.has("name"));
      assert(names.has("priorityRank"));
      assert(names.has("defaultSpot"));
    },
  );

  await t.step(
    "lift shrinks item fields through right-hand ?? fallback aliases",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "type Note = { title: string; body: string };",
        "const cached = undefined as Note[] | undefined;",
        "const liftTitles = lift((input: { notes: Note[] }) => {",
        "  const items = cached ?? input.notes;",
        "  for (const item of items) {",
        "    return item.title;",
        "  }",
        '  return "";',
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("notes"));
      assert(names.has("title"));
      assert(!names.has("body"));
    },
  );

  await t.step(
    "lift preserves array item properties named key",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        'type ColumnKey = "backlog" | "inProgress" | "review" | "done";',
        "interface KanbanTask { id: string; title: string; column: ColumnKey; points: number; }",
        "interface ColumnSummary {",
        "  key: ColumnKey;",
        "  title: string;",
        "  limit: number;",
        "  count: number;",
        "  overloaded: boolean;",
        "  items: KanbanTask[];",
        "}",
        "const liftOverloadedColumns = lift((summaries: ColumnSummary[]) =>",
        "  summaries",
        "    .filter((summary) => summary.overloaded)",
        "    .map((summary) => summary.key)",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("overloaded"));
      assert(names.has("key"));
      assert(!names.has("title"));
      assert(!names.has("limit"));
    },
  );

  await t.step(
    "lift preserves chained || fallback fields in object inputs",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift } from "commonfabric";',
        "const liftFirstOption = lift(",
        "  (state: { name: string; firstItem: string | undefined }) =>",
        '    state.name || state.firstItem || "default",',
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("name"));
      assert(names.has("firstItem"));
    },
  );

  await t.step(
    "lift narrows cell wrappers when callback only uses .get() on inferred input",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift, type Writable } from "commonfabric";',
        "declare const value: Writable<number>;",
        "const doubled = lift((v) => v.get() * 2)(value);",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = schemasOf(result.output)[0]!;
      assertEquals(inputSchema.asCell, ["readonly"]);
      assertEquals(inputSchema.asOpaque, undefined);
    },
  );

  await t.step(
    "lift narrows cell wrappers when expression-bodied callback is a direct .get() call",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift, type Writable } from "commonfabric";',
        "declare const value: Writable<number>;",
        "const copy = lift((v) => v.get())(value);",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = schemasOf(result.output)[0]!;
      assertEquals(inputSchema.asCell, ["readonly"]);
      assertEquals(inputSchema.asOpaque, undefined);
    },
  );

  await t.step(
    "handler preserves explicit primitive-object union event schemas through typeof narrowing",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { type Cell, handler } from "commonfabric";',
        "type AppendValueEvent = { value?: number } | number | undefined;",
        "const appendValueToList = handler(",
        "  (event: AppendValueEvent, context: { values: Cell<number[]> }) => {",
        '    const rawValue = typeof event === "number" ? event : event?.value;',
        "    if (rawValue === undefined) return;",
        "    context.values.push(rawValue);",
        "  },",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = schemasOf(result.output)[0]!;
      // The event schema keeps its union structure rather than widening to the
      // `true` schema.
      assert(
        Array.isArray(inputSchema.anyOf),
        "event schema should retain its anyOf union",
      );
      assert(
        hasUndefinedMember(inputSchema),
        "event schema should preserve undefined",
      );
      assert(
        schemaPropertyNames(inputSchema).has("value"),
        "event schema should keep the object member's `value` field",
      );
    },
  );

  await t.step(
    "lift shrinks aliased fixed-symbol destructuring without pulling unrelated fields",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift, NAME as CF_NAME } from "commonfabric";',
        "type Piece = {",
        "  [CF_NAME]?: string;",
        "  metadata: { author: string; tags: string[] };",
        "};",
        "const piece = {} as Piece;",
        'const label = lift(({ piece: { [CF_NAME]: name } }) => name ?? "")({ piece });',
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const names = schemaPropertyNames(schemasOf(result.output)[0]);
      assert(names.has("$NAME"));
      assert(!names.has("metadata"));
      assert(!names.has("author"));
    },
  );

  await t.step(
    "pattern preserves defaults for fixed-symbol destructuring aliases",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { NAME as CF_NAME, pattern, UI } from "commonfabric";',
        "type Piece = {",
        "  [CF_NAME]?: string;",
        "  metadata: { author: string; tags: string[] };",
        "};",
        'const p = pattern<Piece>(({ [CF_NAME]: name = "Untitled" }) => ({',
        "  [UI]: <div>{name}</div>,",
        "}));",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = schemasOf(result.output)[0]!;
      const props = inputSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      assert(props?.$NAME !== undefined, "input schema should keep $NAME");
      assertEquals(props?.$NAME.default, "Untitled");
    },
  );

  await t.step(
    "lift preserves nullable cell wrappers for equals-only root inputs",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { lift, equals, type Writable } from "commonfabric";',
        "declare const state: Writable<number> | undefined;",
        "const same = lift((state) => equals(state, state))(state);",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = schemasOf(result.output)[0]!;
      assert(
        hasUndefinedMember(inputSchema),
        "input schema should preserve undefined",
      );
      assertEquals(inputSchema.asCell, ["comparable"]);
    },
  );

  //
  // When usage is a wildcard
  //
  // Usage the analysis cannot narrow, where the honest answer is to keep the
  // whole shape.
  //

  await t.step(
    "lift wildcard usage keeps conservative full-shape input schema",
    async () => {
      const source = [
        'import { lift, type Writable } from "commonfabric";',
        "declare const input: Writable<{ foo: string; bar: string }>;",
        "const d = lift((v: Writable<{ foo: string; bar: string }>) => {",
        '  const foo = v.key("foo").get();',
        "  Object.keys(v.get());",
        "  return foo;",
        "})(input);",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const inputSchema = schemasOf(result.output)[0]!;
      assertEquals(inputSchema.asCell, ["readonly"]);
      const names = schemaPropertyNames(inputSchema);
      assert(names.has("foo"));
      assert(names.has("bar"));
    },
  );

  await t.step(
    "handler wildcard usage keeps conservative full-shape state schema",
    async () => {
      const source = [
        'import { handler, type Writable } from "commonfabric";',
        "const h = handler((event: { id: string }, state: Writable<{ foo: string; bar: string }>) => {",
        '  const foo = state.key("foo").get();',
        "  Object.keys(state.get());",
        "  console.log(foo + event.id);",
        "});",
      ].join("\n");

      const result = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );
      const stateSchema = schemasOf(result.output)[1]!;
      assertEquals(stateSchema.asCell, ["readonly"]);
      const names = schemaPropertyNames(stateSchema);
      assert(names.has("foo"));
      assert(names.has("bar"));
    },
  );

  //
  // Validating array item reads
  //
  // Reading an item property the element type does not have is an error,
  // whether or not the array is readonly, and whether the read stands alone
  // or sits beside a read of the array root.
  //

  await t.step(
    "errors when an array item access names a property the element type lacks",
    async () => {
      // The shrink-coverage check recurses through the array into its element
      // type to validate item-level property reads.
      const source = [
        'import { lift } from "commonfabric";',
        "const d = lift((items: { id: string }[]) =>",
        "  items.map((item) => item.missing));",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const shrinkErrors = getErrors(diagnostics).filter(
        (e) => e.type === "schema:path-not-in-type",
      );
      assertGreater(shrinkErrors.length, 0);
    },
  );

  await t.step(
    "errors when a readonly array item access names a missing property",
    async () => {
      // Same recursion, but the element type is reached through a readonly
      // array node.
      const source = [
        'import { lift } from "commonfabric";',
        "const d = lift((items: readonly { id: string }[]) =>",
        "  items.map((item) => item.missing));",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const shrinkErrors = getErrors(diagnostics).filter(
        (e) => e.type === "schema:path-not-in-type",
      );
      assertGreater(shrinkErrors.length, 0);
    },
  );

  await t.step(
    "validates array item reads alongside an array-root length read",
    async () => {
      // Reading both an array-root property (`length`) and item-level fields
      // exercises the array-root path branch of the coverage check.
      const source = [
        'import { lift } from "commonfabric";',
        "const d = lift((items: { id: string }[]) => {",
        "  const count = items.length;",
        "  const ids = items.map((item) => item.missing);",
        "  return { count, ids };",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const shrinkErrors = getErrors(diagnostics).filter(
        (e) => e.type === "schema:path-not-in-type",
      );
      assertGreater(shrinkErrors.length, 0);
    },
  );

  //
  // Cell arguments across a call boundary
  //
  // What a cell argument's shape becomes once it is handed to a callee whose
  // own signature declares how it will be used.
  //

  await t.step(
    "keeps auth writable when handlers pass it to provider clients that refresh tokens",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { handler, type Writable } from "commonfabric";',
        'import { CalendarWriteClient, GmailSendClient, type Auth } from "provider-clients";',
        "const send = handler(",
        "  (_event: unknown, { auth }: { auth: Writable<Auth> }) => {",
        "    GmailSendClient(auth);",
        "  },",
        ");",
        "const writeCalendar = handler(",
        "  (_event: unknown, { auth }: { auth: Writable<Auth> }) => {",
        "    CalendarWriteClient(auth);",
        "  },",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: {
          ...COMMONFABRIC_TYPES,
          "provider-clients.d.ts": [
            'declare module "provider-clients" {',
            '  import type { Writable } from "commonfabric";',
            "  export type Auth = { token: string };",
            "  export interface AuthCell {",
            "    get(): Auth | undefined;",
            "    update(values: { token?: string }): void;",
            "  }",
            "  export interface GmailSendClientFactory {",
            "    (auth: Writable<Auth>): void;",
            "    (auth: AuthCell): void;",
            "  }",
            "  export const GmailSendClient: GmailSendClientFactory;",
            "  export function CalendarWriteClient(auth: Writable<Auth>): void;",
            "}",
          ].join("\n"),
        },
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );

      const send = outputWindow(
        result.output,
        "const send = handler",
        "GmailSendClient(auth)",
      );
      const calendar = outputWindow(
        result.output,
        "const writeCalendar = handler",
        "CalendarWriteClient(auth)",
      );

      assertStringIncludes(send, 'asCell: ["cell"]');
      assertEquals(send.includes('asCell: ["readonly"]'), false);
      assertStringIncludes(calendar, 'asCell: ["cell"]');
      assertEquals(calendar.includes('asCell: ["readonly"]'), false);
    },
  );

  await t.step(
    "handler keeps imported write-only cell arguments write-only",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { handler, type Writable } from "commonfabric";',
        'import { persistAuth, type Auth } from "auth-writer";',
        "const persist = handler(",
        "  (_event: unknown, { auth }: { auth: Writable<Auth> }) => {",
        "    persistAuth(auth);",
        "  },",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: {
          ...COMMONFABRIC_TYPES,
          "auth-writer.d.ts": [
            'declare module "auth-writer" {',
            '  import type { WriteonlyCell } from "commonfabric";',
            "  export type Auth = { token: string };",
            "  export function persistAuth(auth: WriteonlyCell<Auth>): void;",
            "}",
          ].join("\n"),
        },
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );

      const persist = outputWindow(
        result.output,
        "const persist = handler",
        "persistAuth(auth)",
      );

      assertStringIncludes(persist, 'asCell: ["writeonly"]');
      assertEquals(persist.includes('asCell: ["cell"]'), false);
      assertEquals(persist.includes('asCell: ["readonly"]'), false);
    },
  );

  await t.step(
    "shrinks auth to readonly when an imported callee declares a ReadonlyCell parameter",
    async () => {
      // A handler hands its whole auth cell to an out-of-file client whose
      // parameter is declared ReadonlyCell<Auth>. That declaration is the
      // capability contract at the import boundary: the callee needs only read
      // authority, so the handler demonstrates no write need and is not placed
      // in the field's write-authority set. A client that persists a refresh
      // must instead declare Writable or WriteonlyCell, which makes the write
      // explicit to the transformer (see the provider-clients step above).
      // In well-typed code a Writable<Auth> value is not assignable to a
      // ReadonlyCell<Auth> parameter (distinct brands, TS2345), so this shape is
      // reached through a ReadonlyCell-typed input or an explicit cast; the
      // snippet drives the parameter-type mapping the analysis applies.
      const source = [
        "/// <cts-enable />",
        'import { handler, type Writable } from "commonfabric";',
        'import { readAuth, type Auth } from "readonly-auth-client";',
        "const inspect = handler(",
        "  (_event: unknown, auth: Writable<Auth>) => {",
        "    readAuth(auth);",
        "  },",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: {
          ...COMMONFABRIC_TYPES,
          "readonly-auth-client.d.ts": [
            'declare module "readonly-auth-client" {',
            '  import type { ReadonlyCell } from "commonfabric";',
            "  export type Auth = { token: string };",
            "  export function readAuth(auth: ReadonlyCell<Auth>): void;",
            "}",
          ].join("\n"),
        },
      });
      const errors = getErrors(result.diagnostics);

      assertEquals(
        errors.length,
        0,
        `expected no validation errors but got: ${
          errors.map((e) => `${e.type}: ${e.message}`).join("; ")
        }`,
      );

      const inspect = outputWindow(
        result.output,
        "const inspect = handler",
        "readAuth(auth)",
      );

      assertStringIncludes(inspect, 'asCell: ["readonly"]');
      assertEquals(inspect.includes('asCell: ["cell"]'), false);
    },
  );

  await t.step(
    "errors when a cell argument flows to an ambiguous cell-union parameter",
    async () => {
      // `sendMixed` declares `AuthCell | Writable<Auth>` — a union that mixes a
      // cell wrapper with an unresolvable member, so overload resolution cannot
      // pick the capability and the auth cell silently degrades. That is the
      // overload-split case and must be flagged. `persistBare` declares bare
      // `Cell<Auth>`: intentionally NOT flagged (not a union; passing a cell to
      // a neutral Cell parameter is not, on its own, an ambiguity worth a hard
      // error).
      const source = [
        "/// <cts-enable />",
        'import { handler, type Writable } from "commonfabric";',
        'import { sendMixed, persistBare, type Auth } from "ambiguous-clients";',
        "const a = handler(",
        "  (_event: unknown, { auth }: { auth: Writable<Auth> }) => {",
        "    sendMixed(auth);",
        "  },",
        ");",
        "const b = handler(",
        "  (_event: unknown, { auth }: { auth: Writable<Auth> }) => {",
        "    persistBare(auth);",
        "  },",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: {
          ...COMMONFABRIC_TYPES,
          "ambiguous-clients.d.ts": [
            'declare module "ambiguous-clients" {',
            '  import type { Cell, Writable } from "commonfabric";',
            "  export type Auth = { token: string };",
            "  export interface AuthCell {",
            "    get(): Auth | undefined;",
            "    update(values: { token?: string }): void;",
            "  }",
            "  export function sendMixed(auth: AuthCell | Writable<Auth>): void;",
            "  export function persistBare(auth: Cell<Auth>): void;",
            "}",
          ].join("\n"),
        },
      });
      const unreadable = result.diagnostics.filter(
        (d) => d.type === "capability:unreadable-cell-argument",
      );

      assertEquals(
        unreadable.length,
        1,
        `expected one diagnostic, got: ${
          result.diagnostics.map((d) => d.type).join(", ")
        }`,
      );
    },
  );

  await t.step(
    "does not flag a cell argument to a classifiable or escape-hatch parameter",
    async () => {
      const source = [
        "/// <cts-enable />",
        'import { handler, type Writable } from "commonfabric";',
        'import { writeIt, logIt, type Auth } from "ok-clients";',
        "const a = handler(",
        "  (_event: unknown, { auth }: { auth: Writable<Auth> }) => {",
        "    writeIt(auth);",
        "  },",
        ");",
        "const b = handler(",
        "  (_event: unknown, { auth }: { auth: Writable<Auth> }) => {",
        "    logIt(auth);",
        "  },",
        ");",
      ].join("\n");

      const result = await validateSource(source, {
        types: {
          ...COMMONFABRIC_TYPES,
          "ok-clients.d.ts": [
            'declare module "ok-clients" {',
            '  import type { Writable } from "commonfabric";',
            "  export type Auth = { token: string };",
            "  export function writeIt(auth: Writable<Auth>): void;",
            "  export function logIt(value: unknown): void;",
            "}",
          ].join("\n"),
        },
      });
      const unreadable = result.diagnostics.filter(
        (d) => d.type === "capability:unreadable-cell-argument",
      );

      assertEquals(unreadable.length, 0);
    },
  );
});

function getShrinkErrors(
  diagnostics: readonly TransformationDiagnostic[],
): TransformationDiagnostic[] {
  return diagnostics.filter(
    (d) =>
      d.severity === "error" &&
      (d.type === "schema:unknown-type-access" ||
        d.type === "schema:path-not-in-type"),
  );
}

function fmtErrors(diagnostics: readonly TransformationDiagnostic[]): string {
  return getShrinkErrors(diagnostics).map((e) => e.message).join("; ");
}

Deno.test("fetchJson requires an explicit type argument", async (t) => {
  await t.step("errors when called without a type argument", async () => {
    const source = [
      'import { fetchJson } from "commonfabric";',
      "",
      'export const x = fetchJson({ url: "https://example.com" });',
    ].join("\n");
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics).filter(
      (e) => e.type === "fetch-json:missing-type-argument",
    );
    assertGreater(
      errors.length,
      0,
      "Expected fetch-json:missing-type-argument for untyped fetchJson",
    );
    assertStringIncludes(errors[0]!.message, "fetchJsonUnchecked");
  });

  await t.step("no error when a type argument is given", async () => {
    const source = [
      'import { fetchJson } from "commonfabric";',
      "",
      "interface Repo { name: string }",
      'export const x = fetchJson<Repo>({ url: "https://example.com" });',
    ].join("\n");
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics).filter(
      (e) => e.type === "fetch-json:missing-type-argument",
    );
    assertEquals(
      errors.length,
      0,
      `Expected no missing-type-argument error but got: ${
        errors.map((e) => e.message).join("; ")
      }`,
    );
  });

  await t.step("no error for untyped fetchJsonUnchecked", async () => {
    const source = [
      'import { fetchJsonUnchecked } from "commonfabric";',
      "",
      'export const x = fetchJsonUnchecked({ url: "https://example.com" });',
    ].join("\n");
    const { diagnostics } = await validateSource(source, {
      types: COMMONFABRIC_TYPES,
    });
    const errors = getErrors(diagnostics).filter(
      (e) => e.type === "fetch-json:missing-type-argument",
    );
    assertEquals(
      errors.length,
      0,
      `Expected no error for fetchJsonUnchecked but got: ${
        errors.map((e) => e.message).join("; ")
      }`,
    );
  });
});
