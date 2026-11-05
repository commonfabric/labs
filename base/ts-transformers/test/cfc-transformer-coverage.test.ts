import { assertEquals } from "@std/assert";
import ts from "typescript";
import { transformSource, validateSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { collect, emittedSchemas, parseModule } from "./transformed-ast.ts";

/** The single emitted schema literal, evaluated to its JS value. */
async function schemaValue(source: string): Promise<Record<string, unknown>> {
  const out = await transformSource(source, { types: COMMONFABRIC_TYPES });
  const schemas = emittedSchemas(parseModule(out));
  assertEquals(schemas.length, 1, `expected one emitted schema in:\n${out}`);
  return schemas[0]!;
}

Deno.test("transformer coverage: nested aliases expand to canonical metadata", async () => {
  const source = `/// <cts-enable />
    import { toSchema } from "commonfabric";

    type Cfc<T, Meta> = T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
    type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
    type SecretText<T> = Confidential<T, readonly ["secret"]>;

    interface SchemaRoot {
      secret: SecretText<{ value: string }>;
    }

    const schema = toSchema<SchemaRoot>();
    export default schema;
  `;

  const schema = await schemaValue(source);
  const secret = (schema.properties as Record<string, any>).secret;
  assertEquals(secret.type, "object");
  assertEquals(secret.properties.value, { type: "string" });
  assertEquals(secret.ifc, { confidentiality: ["secret"] });
});

Deno.test("transformer coverage: projection paths lower as canonical pointers", async () => {
  const source = `/// <cts-enable />
    import { toSchema } from "commonfabric";

    type Cfc<T, Meta> = T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
    type ProjectionPath<T, From extends string, Path extends readonly unknown[]> = Cfc<T, { projection: { from: From; path: Path } }>;
    type ProjectionOf<Root, PathTuple extends readonly unknown[]> = ProjectionPath<Root, "/", PathTuple>;

    interface SchemaRoot {
      projection: ProjectionOf<{ title: string }, readonly ["nested", "path"]>;
    }

    const schema = toSchema<SchemaRoot>();
    export default schema;
  `;

  const schema = await schemaValue(source);
  const projection = (schema.properties as Record<string, any>).projection;
  assertEquals(projection.properties.title, { type: "string" });
  assertEquals(projection.ifc, {
    projection: { from: "/", path: "/nested/path" },
  });
});

Deno.test("transformer coverage: non-canonical Cfc payloads lower structurally", async () => {
  // The canonical OpaqueInput helper was removed (the runner rejects ifc.opaque
  // fail-closed), but a non-canonical local alias with EXPLICIT type arguments
  // still resolves through the Cfc carrier — the generic payload passthrough.
  // The resulting schema fails closed at commit, so this covers the structural
  // lowering mechanism, not an advertised capability. Defaulted type arguments
  // are NOT recovered on non-canonical aliases (only the canonical name
  // registry hardcoded defaults), so `OpaqueInput<string>` would emit no ifc.

  const source = `/// <cts-enable />
    import { toSchema } from "commonfabric";

    type Cfc<T, Meta> = T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
    type OpaqueInput<T, Spec extends true | { schema?: unknown; allowPassThrough?: boolean } = true> = Cfc<T, { opaque: Spec }>;

    interface SecretPayload {
      token: OpaqueInput<string, true>;
    }

    const schema = toSchema<SecretPayload>();
    export default schema;
  `;

  const schema = await schemaValue(source);
  const token = (schema.properties as Record<string, any>).token;
  assertEquals(token.type, "string");
  assertEquals(token.ifc, { opaque: true });
});

Deno.test("transformer coverage: imported Cfc metadata survives Writable.of type arguments", async () => {
  const source = `/// <cts-enable />
    import { type Cfc, Writable } from "commonfabric";

    type AuthorshipIntegrity<Author extends string> = {
      readonly kind: "authored-by";
      readonly subject: Author;
    };

    type AuthoredMessageBody<Author extends string> = Cfc<
      string,
      { integrity: readonly [AuthorshipIntegrity<Author>] }
    >;

    const body = Writable.of<AuthoredMessageBody<"alice">>(
      "Verified text" as AuthoredMessageBody<"alice">,
    );

    export default body;
  `;

  // The exact evaluated schema pins both the "string" base type and the
  // integrity metadata, and its success proves the intersection was resolved
  // rather than falling back to an "Unsupported intersection pattern" marker.
  const schema = await schemaValue(source);
  assertEquals(schema.type, "string");
  assertEquals(schema.ifc, {
    integrity: [{ kind: "authored-by", subject: "alice" }],
  });
});

Deno.test("transformer coverage: UI helpers rewrite to intrinsic tags and data-ui markers", async () => {
  const source = `/// <cts-enable />
    import { UiAction } from "commonfabric";

    export default () => (
      <UiAction action="SubmitDirectCommand">Go</UiAction>
    );
  `;

  const output = await transformSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  const root = parseModule(output);

  const buttons = collect(root, ts.isJsxElement).filter((element) =>
    ts.isIdentifier(element.openingElement.tagName) &&
    element.openingElement.tagName.text === "ct-button"
  );
  assertEquals(buttons.length, 1);
  assertEquals(jsxStringAttr(buttons[0]!.openingElement, "data-ui-action"), {
    value: "SubmitDirectCommand",
  });
  assertEquals(jsxTagNames(root).includes("UiAction"), false);
});

Deno.test("transformer coverage: WriteAuthorizedBy emits diagnostics for invalid forms", async () => {
  const source = `/// <cts-enable />
    import { toSchema, WriteAuthorizedBy } from "commonfabric";

    declare const missingInitializer: () => void;

    const invalidSchema = toSchema<
      WriteAuthorizedBy<{ title: string }, typeof missingInitializer>
    >();

    const invalidQuerySchema = toSchema<
      WriteAuthorizedBy<{ title: string }, string>
    >();

    export { invalidSchema, invalidQuerySchema };
  `;

  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });

  assertEquals(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "cfc-write-authorized-by"
    ),
    true,
  );
});

/** Every JSX tag name (opening/self-closing) appearing under `root`. */
function jsxTagNames(root: ts.Node): string[] {
  const names: string[] = [];
  const add = (tagName: ts.JsxTagNameExpression): void => {
    if (ts.isIdentifier(tagName)) names.push(tagName.text);
  };
  for (const element of collect(root, ts.isJsxElement)) {
    add(element.openingElement.tagName);
  }
  for (const element of collect(root, ts.isJsxSelfClosingElement)) {
    add(element.tagName);
  }
  return names;
}

/**
 * The string-literal value of attribute `name` on a JSX opening/self-closing
 * element, wrapped as `{ value }` when present so a missing attribute (`{}`) is
 * distinguishable from an attribute whose value is empty or dynamic.
 */
function jsxStringAttr(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): { value: string } | Record<string, never> {
  for (const attr of element.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== name) continue;
    const initializer = attr.initializer;
    if (initializer && ts.isStringLiteral(initializer)) {
      return { value: initializer.text };
    }
    return {};
  }
  return {};
}
