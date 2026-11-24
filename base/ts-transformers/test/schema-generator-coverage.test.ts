import { assert, assertEquals } from "@std/assert";
import ts from "typescript";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  collect,
  emittedSchemas,
  parseModule,
  patternSchemas,
} from "./transformed-ast.ts";

/**
 * Drives the SchemaGeneratorTransformer end to end through the pipeline. Each
 * test pins the emitted `toSchema<T>()` -> `{...} as const satisfies
 * __cfHelpers.JSONSchema` literal for a shape that the existing schema tests do
 * not exercise: non-finite and negative numeric literals, the write-authorized
 * identity marker, the CFC UI-contract hint on boolean and object schemas, and
 * the option-object value evaluator.
 */

/**
 * Parse the transformed output and return the single emitted schema object
 * evaluated to its JS value. Fails if the source produced no schema literal.
 */
async function schemaValue(source: string): Promise<Record<string, unknown>> {
  const out = await transformSource(source, { types: COMMONFABRIC_TYPES });
  const schemas = emittedSchemas(parseModule(out));
  assertEquals(schemas.length, 1, `expected one emitted schema in:\n${out}`);
  return schemas[0]!;
}

/** Unwrap `{...} as const satisfies ...JSONSchema` to the object literal. */
function schemaObjectLiteral(root: ts.SourceFile): ts.ObjectLiteralExpression {
  const sat = collect(root, ts.isSatisfiesExpression).find((node) =>
    /JSONSchema/.test(node.type.getText(root))
  );
  assert(sat, "no `... satisfies ...JSONSchema` expression found");
  let expr: ts.Expression = sat.expression;
  while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }
  assert(ts.isObjectLiteralExpression(expr), "schema is not an object literal");
  return expr;
}

/** The initializer expression of property `key` on an object literal. */
function propInitializer(
  object: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const text = ts.isIdentifier(name) || ts.isStringLiteralLike(name)
      ? name.text
      : undefined;
    if (text === key) return property.initializer;
  }
  return undefined;
}

Deno.test("numeric-literal types lower to NaN, Infinity, -Infinity and negatives", async () => {
  // NaN has no numeric-literal form (emitted as the global NaN), positive and
  // negative infinity emit the Infinity identifier with an optional unary minus,
  // and a negative literal emits a unary-minus wrapper around a positive value.
  // These non-finite values cannot be evaluated to JS numbers by the literal
  // evaluator, so assert on the emitted expression text of the schema AST.
  const out = await transformSource(
    `/// <cts-enable />
import { toSchema } from "commonfabric";
const enum E { NaNValue = 0 / 0 }
interface C { big: 1e999; small: -1e999; neg: -7; tag: E.NaNValue; }
const s = toSchema<C>({ maximum: E.NaNValue });
export { s };
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(out);
  const schema = schemaObjectLiteral(root);

  const enumText = (
    owner: ts.ObjectLiteralExpression,
    key: string,
  ): string[] => {
    const sub = propInitializer(owner, key) as ts.ObjectLiteralExpression;
    assert(sub && ts.isObjectLiteralExpression(sub), `missing ${key} schema`);
    const arr = propInitializer(sub, "enum") as ts.ArrayLiteralExpression;
    assert(arr && ts.isArrayLiteralExpression(arr), `missing ${key} enum`);
    return arr.elements.map((element) => element.getText(root));
  };

  const props = propInitializer(
    schema,
    "properties",
  ) as ts.ObjectLiteralExpression;
  assertEquals(enumText(props, "big"), ["Infinity"]);
  assertEquals(enumText(props, "small"), ["-Infinity"]);
  assertEquals(enumText(props, "neg"), ["-7"]);

  // Enum-member types stay inline so their short names cannot collide in
  // $defs with another enum member or named type.
  assertEquals(enumText(props, "tag"), ["NaN"]);
  assertEquals(propInitializer(schema, "$defs"), undefined);

  assertEquals(propInitializer(schema, "maximum")!.getText(root), "NaN");
});

Deno.test("WriteAuthorizedBy attaches a writer-identity marker with file and path", async () => {
  // The second type argument `typeof saver` is a simple identifier type-query,
  // so the schema gains an `ifc.writeAuthorizedBy.__ctWriterIdentityOf` marker
  // carrying the source file and the binding path.
  const schema = await schemaValue(`/// <cts-enable />
import { toSchema, WriteAuthorizedBy, handler } from "commonfabric";
const saver = handler({}, {}, () => {});
const s = toSchema<WriteAuthorizedBy<{ title: string }, typeof saver>>();
export { s };
`);
  const marker = (schema.ifc as any).writeAuthorizedBy.__ctWriterIdentityOf;
  assertEquals(marker.file, "/test.tsx");
  assertEquals(marker.path, ["saver"]);
});

Deno.test("WriteAuthorizedBy with a qualified typeof binding attaches no marker", async () => {
  // A qualified `typeof container.save` is not a plain identifier type-query, so
  // the identity extraction bails and no writer-identity marker is emitted.
  const schema = await schemaValue(`/// <cts-enable />
import { toSchema, WriteAuthorizedBy } from "commonfabric";
const container = { save() {} };
const s = toSchema<WriteAuthorizedBy<{ title: string }, typeof container.save>>();
export { s };
`);
  assertEquals(schema.type, "object");
  assertEquals(schema.ifc, undefined);
});

Deno.test("UI-contract hint attaches to an object $UI property schema", async () => {
  // The `<UiAction>` in the UI slot records a hint that is grafted onto the
  // generated $UI property schema's `ifc.uiContract`.
  const out = await transformSource(
    `/// <cts-enable />
import { pattern, UI, UiAction } from "commonfabric";
export default pattern<{ title: string }>((state) => ({
  [UI]: <UiAction action="SubmitDirectCommand">Go</UiAction>,
  title: state.title,
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const { output } = patternSchemas(parseModule(out));
  const contract = ((output.properties as any).$UI.ifc as any)
    .uiContract as any;
  assertEquals(contract.helper, "UiAction");
  assertEquals(contract.action, "SubmitDirectCommand");
});

Deno.test("UI-contract hint wraps a boolean-true $UI property as an ifc-only schema", async () => {
  // When the output type declares `[UI]: any`, the $UI property schema is the
  // boolean `true`; attaching the contract turns it into `{ ifc: { uiContract }}`.
  const out = await transformSource(
    `/// <cts-enable />
import { pattern, UI, UiAction } from "commonfabric";
type Out = { title: string; [UI]: any };
export default pattern<{ title: string }, Out>((state) => ({
  [UI]: <UiAction action="SubmitDirectCommand">Go</UiAction>,
  title: state.title,
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const { output } = patternSchemas(parseModule(out));
  const uiSchema = (output.properties as any).$UI;
  // The property schema is the ifc-only object: no `type`, just `ifc`.
  assertEquals(Object.keys(uiSchema), ["ifc"]);
  assertEquals((uiSchema.ifc as any).uiContract.action, "SubmitDirectCommand");
});

Deno.test("UI-contract hint on a whole boolean-true schema becomes an ifc-only schema", async () => {
  // An `any` output type makes the whole generated schema the boolean `true`,
  // so the contract is attached as `{ ifc: { uiContract } }` without a `not`.
  const out = await transformSource(
    `/// <cts-enable />
import { pattern, UI, UiAction } from "commonfabric";
export default pattern<{ title: string }, any>((state) => ({
  [UI]: <UiAction action="SubmitDirectCommand">Go</UiAction>,
  title: state.title,
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const { output } = patternSchemas(parseModule(out));
  assertEquals((output.ifc as any).uiContract.action, "SubmitDirectCommand");
  assertEquals(output.not, undefined);
});

Deno.test("UI-contract hint on a whole boolean-false schema negates via not:true", async () => {
  // A `never` output type makes the whole generated schema the boolean `false`,
  // so the contract is attached as `{ not: true, ifc: { uiContract } }`.
  const out = await transformSource(
    `/// <cts-enable />
import { pattern, UI, UiAction } from "commonfabric";
export default pattern<{ title: string }, never>((state) => ({
  [UI]: <UiAction action="SubmitDirectCommand">Go</UiAction>,
  title: state.title,
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const { output } = patternSchemas(parseModule(out));
  assertEquals(output.not, true);
  assertEquals((output.ifc as any).uiContract.action, "SubmitDirectCommand");
});

Deno.test("toSchema option object evaluates literals, arrays, nested objects and constants", async () => {
  // The options bag is spread onto the emitted schema; booleans, null, arrays,
  // nested object literals and enum-constant references are all evaluated, while
  // an undefined-valued option is dropped.
  const schema = await schemaValue(`/// <cts-enable />
import { toSchema } from "commonfabric";
const enum E { V = 5 }
interface C { value: number; }
const s = toSchema<C>({
  flagTrue: true,
  flagFalse: false,
  nothing: null,
  undef: undefined,
  list: [1, "a", true, null],
  nested: { inner: 3, deep: { x: "y" } },
  constant: E.V,
  wrappedParen: ("p"),
  wrappedCast: "c" as string,
  wrappedSatisfies: "t" satisfies string,
  wrappedNonNull: "n"!,
});
export { s };
`);
  assertEquals(schema.flagTrue, true);
  assertEquals(schema.flagFalse, false);
  assertEquals(schema.nothing, null);
  assertEquals(schema.list, [1, "a", true, null]);
  assertEquals(schema.nested, { inner: 3, deep: { x: "y" } });
  assertEquals(schema.constant, 5);
  assert(!("undef" in schema), "undefined option should be dropped");
  // Each wrapper spelling a .tsx source can carry reaches the same value; the
  // evaluator reads the shared set rather than a hand-written subset. The
  // angle-bracket assertion is JSX in .tsx and so is not among them.
  assertEquals(schema.wrappedParen, "p");
  assertEquals(schema.wrappedCast, "c");
  assertEquals(schema.wrappedSatisfies, "t");
  assertEquals(schema.wrappedNonNull, "n");
});
