import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { internSchema } from "@commonfabric/data-model-schema";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../src/builder/types.ts";
import {
  cfcObjectSchemaIsClosed,
  INJECTION_SAFE_ATOM,
  isPrimitiveJsonValue,
  isPromptInjectionMaterialRiskAtom,
  resolveCfcSchemaRefRoot,
  resolveSchemaForValidation,
  schemaWithInjectionSafeAnnotations,
  validateAgainstSchema,
  validateAndSanitizeSchemaValueWithOpaqueLinks,
  validateSchemaDefinition,
  validateSchemaValue,
} from "../src/cfc/mod.ts";
import { CELL_KINDS } from "../src/scope.ts";

const promptRisk = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind:
    "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
  source: "of:hostile",
} as const;

const promptInfluence = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
  source: "of:hostile",
} as const;

describe("cfc schema sanitization", () => {
  it("classifies primitive values and prompt-injection risk atoms", () => {
    expect(isPrimitiveJsonValue(null)).toBe(true);
    expect(isPrimitiveJsonValue("text")).toBe(true);
    expect(isPrimitiveJsonValue(1)).toBe(true);
    expect(isPrimitiveJsonValue(false)).toBe(true);
    expect(isPrimitiveJsonValue({})).toBe(false);

    expect(
      isPromptInjectionMaterialRiskAtom("prompt-injection-risk-unscreened"),
    )
      .toBe(true);
    expect(isPromptInjectionMaterialRiskAtom("prompt-injection-risk"))
      .toBe(false);
    expect(isPromptInjectionMaterialRiskAtom({
      type: CFC_ATOM_TYPE.Caveat,
      kind: "prompt-injection-risk-value-screened",
    })).toBe(true);
    expect(isPromptInjectionMaterialRiskAtom({
      type: CFC_ATOM_TYPE.Caveat,
      kind: "prompt-influence",
    })).toBe(false);
  });

  it("detects closed object schemas", () => {
    expect(cfcObjectSchemaIsClosed({ type: "object" })).toBe(true);
    expect(cfcObjectSchemaIsClosed({ properties: {} })).toBe(true);
    expect(cfcObjectSchemaIsClosed({ required: ["title"] })).toBe(true);
    expect(cfcObjectSchemaIsClosed({ additionalProperties: false })).toBe(
      true,
    );
    expect(cfcObjectSchemaIsClosed({ additionalProperties: true })).toBe(
      false,
    );
    expect(cfcObjectSchemaIsClosed({
      additionalProperties: { type: "string" },
    })).toBe(false);
  });

  it("resolves refs for validation and falls back on unresolved refs", () => {
    const fullSchema = {
      $defs: {
        Count: { type: "integer" },
      },
    } as const;

    expect(resolveSchemaForValidation({ $ref: "#/$defs/Count" }, fullSchema))
      .toEqual({ type: "integer" });
    expect(resolveSchemaForValidation({ $ref: "#/$defs/Missing" }, fullSchema))
      .toBe(false);
    expect(resolveSchemaForValidation(
      { $ref: "#/$defs/toString" },
      { $defs: {} },
    )).toBe(false);
    expect(resolveCfcSchemaRefRoot({ $ref: "#/$defs/Missing" }, fullSchema))
      .toBe(fullSchema);
    expect(resolveSchemaForValidation({ type: "string" }, fullSchema))
      .toEqual({ type: "string" });

    const embeddedAlias: JSONSchema = {
      $ref: "#/$defs/VNode",
      $defs: {
        VNode: { $ref: "https://commonfabric.org/schemas/vnode.json" },
      },
    };
    expect(resolveSchemaForValidation(embeddedAlias, embeddedAlias))
      .not.toBe(false);
    expect(validateSchemaValue(embeddedAlias, {
      type: "vnode",
      name: "div",
      props: {},
    })).toBeUndefined();
  });

  it("annotates injection-safe primitive schema shapes", () => {
    const risk = {
      type: CFC_ATOM_TYPE.Caveat,
      kind: "prompt-injection-risk-unscreened",
    } as const;
    const retained = {
      type: CFC_ATOM_TYPE.Caveat,
      kind: "prompt-influence",
    } as const;

    const annotated = schemaWithInjectionSafeAnnotations({
      type: "object",
      properties: {
        approved: { type: "boolean" },
        status: { enum: ["open", "closed"] },
        note: { type: "string" },
      },
      required: ["approved", "status", "note"],
      additionalProperties: false,
    }, [risk, retained]) as any;

    expect(annotated.required).toBeUndefined();
    expect(annotated.properties.approved.ifc.addIntegrity).toContainEqual(
      INJECTION_SAFE_ATOM,
    );
    expect(annotated.properties.approved.ifc.confidentiality).toEqual([
      retained,
    ]);
    expect(annotated.properties.status.ifc.addIntegrity).toContainEqual(
      INJECTION_SAFE_ATOM,
    );
    expect(annotated.properties.note.ifc.confidentiality).toContainEqual(risk);
    expect(annotated.properties.note.ifc.confidentiality).toContainEqual(
      retained,
    );
  });

  it("leaves boolean schemas unchanged while annotating", () => {
    expect(schemaWithInjectionSafeAnnotations(true, ["secret"])).toBe(true);
  });

  it("breaks ref cycles during annotation", () => {
    const annotated = schemaWithInjectionSafeAnnotations({
      $defs: {
        Node: { $ref: "#/$defs/Node" },
      },
      $ref: "#/$defs/Node",
    }, ["secret"]) as any;

    expect(annotated.ifc.confidentiality).toEqual(["secret"]);
  });

  it("annotates refs, branches, arrays, and open objects", () => {
    const observed = ["secret"];
    const annotated = schemaWithInjectionSafeAnnotations({
      $defs: {
        Choice: {
          anyOf: [
            { type: "boolean" },
            { type: "string" },
          ],
        },
      },
      type: "object",
      properties: {
        child: { $ref: "#/$defs/Choice" },
        list: {
          type: "array",
          items: { type: "integer" },
        },
      },
      additionalProperties: true,
    }, observed) as any;

    expect(annotated.ifc.confidentiality).toEqual(observed);
    expect(annotated.properties.child.ifc.confidentiality).toEqual(observed);
    expect(annotated.properties.list.ifc.addIntegrity).toContainEqual(
      INJECTION_SAFE_ATOM,
    );
    expect(annotated.properties.list.items.ifc.addIntegrity).toContainEqual(
      INJECTION_SAFE_ATOM,
    );

    const extended = schemaWithInjectionSafeAnnotations({
      type: ["number", "undefined"],
    }, observed) as any;
    expect(extended.ifc.addIntegrity).toContainEqual(INJECTION_SAFE_ATOM);
  });

  it("annotates a nested ref against the document's map, not the subtree's own `$defs`", () => {
    // `#/$defs/Value` names the root's number, which is injection-safe; the
    // string under the subtree's own `$defs` is inert below the root's map.
    const annotated = schemaWithInjectionSafeAnnotations({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { value: { $ref: "#/$defs/Value" } },
          $defs: { Value: { type: "string" } },
        },
      },
      $defs: { Value: { type: "number" } },
    }, [promptRisk]) as any;
    const valueIfc = annotated.properties.nested.properties.value.ifc;

    expect(valueIfc.addIntegrity).toContainEqual(INJECTION_SAFE_ATOM);
  });

  it("annotates oneOf, allOf, empty objects, and not schemas", () => {
    const annotated = schemaWithInjectionSafeAnnotations({
      type: "object",
      properties: {
        choice: {
          oneOf: [
            { type: "boolean" },
            { type: "null" },
          ],
        },
        combined: {
          allOf: [
            { type: "integer" },
            { const: 1 },
          ],
        },
      },
      required: ["choice", "combined"],
      additionalProperties: false,
      not: {
        required: ["blocked"],
      },
    }, ["secret"]) as any;

    expect(annotated.required).toBeUndefined();
    expect(annotated.properties.choice.oneOf[0].ifc.addIntegrity)
      .toContainEqual(INJECTION_SAFE_ATOM);
    expect(annotated.properties.combined.allOf[1].ifc.addIntegrity)
      .toContainEqual(INJECTION_SAFE_ATOM);
    expect(annotated.not.required).toBeUndefined();

    const emptyObject = schemaWithInjectionSafeAnnotations({
      type: "object",
      additionalProperties: false,
    }, ["secret"]) as any;
    expect(emptyObject.ifc.addIntegrity).toContainEqual(INJECTION_SAFE_ATOM);
  });

  it("validates values against schema features", () => {
    expect(validateAgainstSchema(true, "anything")).toBeUndefined();
    expect(validateAgainstSchema(false, "anything")).toBe(
      "schema rejects all values",
    );
    expect(validateAgainstSchema({
      $defs: { Count: { type: "integer" } },
      $ref: "#/$defs/Count",
    }, 2)).toBeUndefined();
    expect(validateAgainstSchema({
      allOf: [
        { type: "object" },
        { required: ["name"] },
      ],
    }, {})).toBe("missing required property name");
    expect(validateAgainstSchema({
      allOf: [{ type: "number" }, { minimum: 0 }],
    }, 1)).toBeUndefined();
    expect(validateAgainstSchema({
      anyOf: [{ type: "string" }, { type: "number" }],
    }, false)).toBe("value does not match anyOf");
    expect(validateAgainstSchema({
      oneOf: [{ type: "number" }, { type: "integer" }],
    }, 1)).toBe("value does not match exactly one oneOf branch");
    expect(validateAgainstSchema({ enum: ["a", "b"] }, "c")).toBe(
      "value is not in enum",
    );
    expect(validateAgainstSchema({ const: "ready" }, "waiting")).toBe(
      "value does not match const",
    );
    expect(validateAgainstSchema({ type: ["string", "number"] }, false)).toBe(
      "value does not match type string|number",
    );
    expect(validateAgainstSchema({ type: "unknown" }, Symbol("value")))
      .toBeUndefined();
    expect(validateAgainstSchema({ type: "null" }, null)).toBeUndefined();
    expect(validateAgainstSchema({ type: "custom" } as any, "value"))
      .toBeUndefined();
    expect(validateAgainstSchema({
      type: "object",
      properties: { count: { type: "number" } },
      additionalProperties: false,
    }, { count: 1, extra: true })).toBe("additional property extra");
    expect(validateAgainstSchema({
      type: "object",
      properties: { title: { type: "string" } },
      additionalProperties: { type: "number" },
    }, { title: "ok", extra: "bad" })).toBe(
      "extra: value does not match type number",
    );
    expect(validateAgainstSchema({
      type: "object",
      properties: { title: { type: "string" } },
      additionalProperties: { type: "number" },
    }, { title: "ok", extra: 1 })).toBeUndefined();
    expect(validateAgainstSchema({
      type: "array",
      items: { type: "string" },
    }, ["ok", 2])).toBe("1: value does not match type string");
    expect(validateAgainstSchema({
      type: "array",
      items: { type: "string" },
    }, ["ok"])).toBeUndefined();
  });

  it("reads an optional property holding undefined as absent ONLY on request", () => {
    // `undefined` is a value in this system, not a hole: the codec stores its
    // presence as `{"/Undefined@1": null}` and `type: "undefined"` is a type
    // this validator supports. So measuring it is the DEFAULT, and
    // `pull-materialization.test.ts` pins both halves of that contract with
    // "does not hide present explicit undefined behind an optional alias" and
    // "retains explicit undefined at an optional derived Cell root".
    //
    // One caller opts out: the stored-argument check a pattern update runs.
    // Its refusal is PERMANENT — see `isStoredArgumentSchemaRefusal` in
    // runner.ts, the same identity refuses identically — and a handler mints
    // the shape without meaning to. Measured: `topics/topic.tsx` pushes
    // `{ author, ... }` from `addComment` whenever no `agentName` is supplied,
    // so the document REFUSED its own pattern's next update with
    // `comments: 0: author: value does not match type object`;
    // `lunch-poll/main.tsx` did the same through `imageUrl`.
    const lenient = { optionalUndefinedIsAbsent: true } as const;
    const optionalObject = {
      type: "object",
      properties: {
        author: { type: "object", properties: { name: { type: "string" } } },
        body: { type: "string" },
      },
    } as const satisfies JSONSchema;

    // Omitted is fine either way — the control that says the cases below are
    // about PRESENCE of undefined, not about the key being optional.
    expect(validateSchemaValue(optionalObject, { body: "old" }))
      .toBeUndefined();
    expect(
      validateSchemaValue(optionalObject, { body: "old" }, undefined, lenient),
    )
      .toBeUndefined();

    // Default: measured, and it fails. Opted in: absent.
    const present = { author: undefined, body: "old" };
    expect(validateSchemaValue(optionalObject, present))
      .toBe("author: value does not match type object");
    expect(validateSchemaValue(optionalObject, present, undefined, lenient))
      .toBeUndefined();

    // The same, inside an array — where the topics document actually holds it.
    const inArray = { type: "array", items: optionalObject } as const;
    const rows = [{ author: undefined, body: "old" }];
    expect(validateSchemaValue(inArray, rows))
      .toBe("0: author: value does not match type object");
    expect(validateSchemaValue(inArray, rows, undefined, lenient))
      .toBeUndefined();

    // The opt-in stops at OPTIONAL. A required object holding undefined keeps
    // failing on its type even when asked to be lenient.
    expect(validateSchemaValue(
      {
        type: "object",
        properties: { author: { type: "object" } },
        required: ["author"],
      },
      { author: undefined },
      undefined,
      lenient,
    ))
      .toBe("author: value does not match type object");

    // Why required is measured rather than read as absent: a REQUIRED property
    // declared `type: "undefined"` holds undefined legitimately and must still
    // be ACCEPTED. Reading undefined as absence everywhere reports this as a
    // missing property — caught by `runner.test.ts`'s "preserves explicit
    // undefined while combining union defaults", which validates a defaults
    // object built from exactly this shape.
    expect(validateSchemaValue(
      {
        type: "object",
        properties: { x: { type: "undefined" } },
        required: ["x"],
      },
      { x: undefined },
      undefined,
      lenient,
    )).toBeUndefined();

    // The opt-in reaches DECLARED properties only. An undeclared key is still
    // measured, opt-in or not: `required` may name a key that `properties`
    // does not, so skipping undefined-valued keys in the additional-property
    // scans let a required-but-undeclared one bypass both
    // `additionalProperties: false` and an `additionalProperties` subschema
    // (reported by review on #5251). Nothing measured needed that leniency —
    // `topic.tsx`'s `author` and `lunch-poll`'s `imageUrl` are both declared.
    const closed = {
      type: "object",
      properties: { body: { type: "string" } },
      additionalProperties: false,
    } as const;
    const withExtra = { body: "old", extra: undefined };
    expect(validateSchemaValue(closed, withExtra))
      .toBe("additional property extra");
    expect(validateSchemaValue(closed, withExtra, undefined, lenient))
      .toBe("additional property extra");
    expect(validateSchemaValue(
      {
        type: "object",
        properties: {},
        required: ["x"],
        additionalProperties: false,
      },
      { x: undefined },
      undefined,
      lenient,
    )).toBe("additional property x");
  });

  it("drops the undefined-is-absent opt-in inside allOf branches", () => {
    // `optionalUndefinedIsAbsent` decides "optional" from the `required` array
    // on the node doing the check, and `allOf` is the combinator that can put
    // `required` on one node and `properties` on another. Without dropping it
    // for the branches, the branch that TYPES `x` sees no `required` and skips
    // the check, accepting `{x: undefined}` against a required string
    // (reported by review on #5251).
    //
    // Dropped rather than plumbed: nothing needs it. `packages/schema-generator`
    // emits no `allOf` at all and no committed pattern baseline contains one,
    // so a pattern argument schema — the only place the opt-in is enabled —
    // cannot reach this branch. Strict is the safe direction for a shape that
    // does not occur.
    const split = {
      allOf: [
        { required: ["x"] },
        { properties: { x: { type: "string" } } },
      ],
    } as const satisfies JSONSchema;
    const lenient = { optionalUndefinedIsAbsent: true } as const;

    expect(validateSchemaValue(split, { x: undefined }))
      .toBe("x: value does not match type string");
    expect(validateSchemaValue(split, { x: undefined }, undefined, lenient))
      .toBe("x: value does not match type string");
    // The control: the branch is still doing its ordinary work either way.
    expect(validateSchemaValue(split, { x: 1 }, undefined, lenient))
      .toBe("x: value does not match type string");
    expect(validateSchemaValue(split, { x: "ok" }, undefined, lenient))
      .toBeUndefined();
  });

  it("strictly validates `FabricValue`s for schema migrations", () => {
    expect(validateSchemaValue({ type: "undefined" }, undefined))
      .toBeUndefined();
    expect(validateSchemaValue({ type: "undefined" }, "not undefined"))
      .toContain("type undefined");
    expect(validateSchemaValue({
      type: "object",
      properties: { known: { type: "number" } },
    }, { known: 1, extra: true })).toBeUndefined();
    expect(validateSchemaValue({
      type: "object",
      properties: { known: { type: "number" } },
      additionalProperties: false,
    }, { known: 1, extra: true })).toContain("additional property extra");
    expect(validateSchemaValue({ type: "custom" } as any, "value"))
      .toContain("unsupported schema type custom");

    const opaque = Object.create(null);
    const onlyWhenAuthorized = (_value: unknown, schema: JSONSchema) =>
      typeof schema === "object" && Array.isArray(schema.asCell);
    const plainUnion: JSONSchema = { type: ["number", "undefined"] };
    expect(validateSchemaValue(
      plainUnion,
      opaque,
      plainUnion,
      { acceptOpaqueValue: onlyWhenAuthorized },
    )).toContain("type number|undefined");
    const cellUnion: JSONSchema = {
      type: ["number", "undefined"],
      asCell: ["cell"],
    };
    expect(validateSchemaValue(
      cellUnion,
      opaque,
      cellUnion,
      { acceptOpaqueValue: onlyWhenAuthorized },
    )).toBeUndefined();

    expect(validateSchemaValue({
      type: "object",
      properties: { toString: { type: "number" as const } },
      required: ["toString"],
    }, {})).toContain("missing required property toString");
    expect(validateSchemaValue({
      type: "object",
      properties: { toString: { type: "number" as const } },
    }, {})).toBeUndefined();
    expect(validateSchemaValue({
      type: "object",
      dependentRequired: { toString: ["value"] },
    }, {})).toBeUndefined();

    const sparse = [1, , 3];
    expect(validateSchemaValue({
      type: "array",
      items: { type: "number" },
    }, sparse)).toBeUndefined();
    expect(validateSchemaValue({
      type: "array",
      items: { type: "number" },
    }, [1, undefined, 3])).toContain("1:");
    const sparsePrefix = [, 2];
    expect(validateSchemaValue({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    }, sparsePrefix)).toBeUndefined();
    expect(validateSchemaValue({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    }, [undefined, 2])).toContain("0:");

    expect(validateSchemaValue({ type: "array", uniqueItems: true }, [
      new FabricBytes(new Uint8Array([1])),
      new FabricBytes(new Uint8Array([2])),
    ])).toBeUndefined();
    expect(validateSchemaValue({ type: "array", uniqueItems: true }, [
      new FabricBytes(new Uint8Array([1])),
      new FabricBytes(new Uint8Array([1])),
    ])).toContain("not unique");

    const validSchema: JSONSchema = {
      type: "object",
      minProperties: 3,
      maxProperties: 3,
      required: ["count", "label", "items"],
      properties: {
        count: {
          type: "number",
          minimum: 10,
          exclusiveMinimum: 9,
          maximum: 20,
          exclusiveMaximum: 21,
          multipleOf: 2,
        },
        label: {
          type: "string",
          minLength: 3,
          maxLength: 20,
          pattern: "^[a-z@.]+$",
          format: "email",
        },
        items: {
          type: "array",
          minItems: 2,
          maxItems: 3,
          uniqueItems: true,
          prefixItems: [{ type: "string" }],
          items: { type: "number" },
          contains: { type: "number", minimum: 10 },
          minContains: 1,
          maxContains: 2,
        },
      },
      dependentRequired: { count: ["label"] },
      dependentSchemas: { count: { required: ["items"] } },
      propertyNames: { pattern: "^[a-z]+$" },
      patternProperties: { "^lab": { type: "string" } },
    };
    expect(validateSchemaValue(validSchema, {
      count: 12,
      label: "a@b.co",
      items: ["first", 12],
    })).toBeUndefined();
  });

  it("resolves a nested ref against the document's map for preflight and values", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { value: { $ref: "#/$defs/Value" } },
          $defs: { Value: { type: "string" } },
        },
      },
      $defs: { Value: { type: "number" } },
    };

    expect(validateSchemaDefinition(schema)).toBeUndefined();
    expect(validateSchemaValue(schema, { nested: { value: 1 } }))
      .toBeUndefined();
    expect(validateSchemaValue(schema, { nested: { value: "local" } }))
      .toContain("value does not match type number");

    // With no map on the root, a ref that only the nested `$defs` could
    // satisfy names nothing.
    const localOnlyDefinition: JSONSchema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { value: { $ref: "#/$defs/LocalOnly" } },
          $defs: { LocalOnly: { type: "string" } },
        },
      },
    };
    expect(validateSchemaDefinition(localOnlyDefinition))
      .toContain("cannot resolve schema reference");
    expect(
      validateSchemaValue(localOnlyDefinition, { nested: { value: "local" } }),
    ).toContain("cannot resolve schema reference");
  });

  it("validates `FabricPrimitive` schema types by prototype", () => {
    const bytes = new FabricBytes(new Uint8Array([1, 2]));

    // The `FabricPrimitive` names are legal schema definitions.
    expect(validateSchemaDefinition({ type: "FabricBytes" })).toBeUndefined();
    expect(validateSchemaDefinition({ type: ["FabricHash", "null"] }))
      .toBeUndefined();

    // A FabricBytes satisfies its own type, and "object" via the subtype
    // rule (each `FabricPrimitive` type is a subtype of "object").
    expect(validateSchemaValue({ type: "FabricBytes" }, bytes))
      .toBeUndefined();
    expect(validateSchemaValue({ type: "object" }, bytes)).toBeUndefined();

    // The specific types don't cross-match, and the subtype relation is
    // one-way: a plain record is not a FabricBytes.
    expect(validateSchemaValue({ type: "FabricHash" }, bytes))
      .toContain("value does not match type FabricHash");
    expect(validateSchemaValue({ type: "FabricBytes" }, { a: 1 }))
      .toContain("value does not match type FabricBytes");
    expect(validateSchemaValue({ type: "FabricBytes" }, "bytes-ish"))
      .toContain("value does not match type FabricBytes");
  });

  it("checks an object schema's required keys against a FabricPrimitive's accessors", () => {
    const bytes = new FabricBytes(new Uint8Array([1, 2]));

    // Required keys must exist on the leaf; class accessors count (`in`,
    // prototype chain included). typeMatches stays permissive; this is the
    // complete check behind the filter.
    expect(validateSchemaValue({ type: "object", required: ["x"] }, bytes))
      .toContain("missing required property x");
    expect(validateSchemaValue({ required: ["x"] }, bytes))
      .toContain("missing required property x");
    expect(validateSchemaValue({ type: "object", required: ["length"] }, bytes))
      .toBeUndefined();
    // The nominal brand key generated schemas require has no runtime
    // existence; a `FabricSpecialObject` satisfies it by construction. This
    // is the shape the schema-generator emits for a FabricBytes-typed field
    // today.
    expect(validateSchemaValue({
      type: "object",
      required: ["length", "@commonfabric/FabricSpecialObject"],
    }, bytes)).toBeUndefined();
    expect(validateSchemaValue({ type: "object", required: [] }, bytes))
      .toBeUndefined();
    // A `FabricPrimitive`-typed schema is not gated by `required`.
    expect(validateSchemaValue({ type: "FabricBytes", required: ["x"] }, bytes))
      .toBeUndefined();
  });

  it("resolves a referenced definition body's refs against the document's map", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { item: { $ref: "#/$defs/Entry" } },
      $defs: {
        Entry: {
          type: "object",
          properties: { value: { $ref: "#/$defs/Value" } },
          required: ["value"],
          $defs: { Value: { type: "string" } },
        },
        Value: { type: "number" },
      },
    };

    expect(validateSchemaDefinition(schema)).toBeUndefined();
    expect(validateSchemaValue(schema, { item: { value: 1 } }))
      .toBeUndefined();
    expect(validateSchemaValue(schema, { item: { value: "local" } }))
      .toContain("value does not match type number");
  });

  it("walks a shared definition map once, not once per ref path", () => {
    // resolveCfcSchemaRef() hands every resolved view the owning `$defs`
    // object. Walking those bodies again at each view expands the definition
    // graph as a tree rather than a DAG, so node visits grow as
    // (definition count)^(ref depth) — the shape that made
    // packages/patterns/lobby/main.tsx take over a minute to validate.
    // Counting reads of one definition body keeps the bound on the work
    // itself rather than on the clock.
    const depth = 8;
    const definitions: Record<string, JSONSchema> = {};
    for (let index = 0; index < depth; index++) {
      definitions[`D${index}`] = index === depth - 1 ? { type: "string" } : {
        type: "object",
        properties: {
          a: { $ref: `#/$defs/D${index + 1}` },
          b: { $ref: `#/$defs/D${index + 1}` },
        },
      };
    }
    const countedBody = definitions.D4;
    let reads = 0;
    Object.defineProperty(definitions, "D4", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads++;
        return countedBody;
      },
    });
    const schema: JSONSchema = {
      type: "object",
      properties: { root: { $ref: "#/$defs/D0" } },
      $defs: definitions,
    };

    expect(validateSchemaDefinition(schema)).toBeUndefined();
    // 463911 reads before the definition map was claimed once per root; the
    // bound this asserts does not grow with `depth`.
    expect(reads).toBeLessThan(100);
  });

  it("reports definition bodies a recursive ref would cut short", () => {
    // The definition map belongs to the schema that carries it outermost, so
    // its bodies are walked with no ref expansion in flight. Claiming it from
    // a resolved view instead would reach `child` through the very `$ref` the
    // recursion guard is holding open, and its own keywords would go unchecked.
    const schema: JSONSchema = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: {
            child: {
              $ref: "#/$defs/Node",
              type: "bogus",
            } as unknown as JSONSchema,
            name: { type: "string" },
          },
        },
      },
    };

    expect(validateSchemaDefinition(schema)).toContain(
      "unsupported schema type bogus",
    );
  });

  it("re-walks a definition map a cut walk claimed, entering from a fragment", () => {
    // The regression this pins is entry-point-specific: `assertSchemaSubset`
    // validates a FRAGMENT against a root, and the fragment carries no `$defs`
    // of its own, so the first resolved ref view is what claims the root's map.
    //
    // Here the fragment visits `A` then `B`. `A` references itself from a node
    // with an invalid sibling keyword, so the recursion guard cuts that walk
    // before the keyword is checked. `B` re-enters the map afterwards, when `A`
    // is no longer active — but only if the cut walk gave the map back.
    //
    // Claiming the map permanently made this ACCEPT an invalid schema. The
    // whole-schema entry point never showed it: there the outermost carrier
    // walks the map with no ref in flight, so nothing is cut.
    const root: JSONSchema = {
      type: "object",
      $defs: {
        A: {
          type: "object",
          properties: {
            self: { $ref: "#/$defs/A", type: "bogus" } as unknown as JSONSchema,
          },
        },
        B: { type: "object", properties: { v: { $ref: "#/$defs/C" } } },
        C: { type: "string" },
      },
    };
    const fragment: JSONSchema = {
      type: "object",
      properties: { a: { $ref: "#/$defs/A" }, b: { $ref: "#/$defs/B" } },
    };

    expect(validateSchemaDefinition(fragment, root)).toContain(
      "unsupported schema type bogus",
    );
  });

  it("releases a definition map claimed by a view that then hit the ref guard", () => {
    // A `{$ref}` view claims the owning `$defs` on ENTRY, then returns straight
    // away on the active-ref guard having walked nothing. The release used to
    // live only inside the `$defs` iteration, so that frame never reached it
    // and every later carrier of the map skipped it — forever. `Unreferenced`
    // is what proves the map went unwalked: nothing else reaches it.
    const root: JSONSchema = {
      type: "object",
      $defs: {
        Rec: { $ref: "#/$defs/Rec", type: "object" } as unknown as JSONSchema,
        Ok: { allOf: [{ $ref: "#/$defs/Rec" }] },
        Unreferenced: {
          type: "number",
          required: ["a", "a"],
        } as unknown as JSONSchema,
      },
    };
    const fragment: JSONSchema = {
      type: "object",
      properties: { a: { $ref: "#/$defs/Rec" }, b: { $ref: "#/$defs/Ok" } },
    };

    expect(validateSchemaDefinition(fragment, root)).toContain(
      "must be an array of unique strings",
    );
  });

  it("drops proofs that leaned on a claim, when the claim is handed back", () => {
    // `provenByRoot` may record a schema that SKIPPED a definition map on the
    // strength of someone else's claim. If the claimer later releases that map,
    // the proof was resting on a claim that no longer stands — so the release
    // has to take those records with it, or a second path hits the memo and
    // never re-walks the released map.
    //
    // Interning is what makes the resolved views identity-stable enough to hit
    // the memo, and the builder interns schemas throughout — so this is the
    // production shape, not an exotic one.
    const root = internSchema({
      type: "object",
      $defs: {
        W: { type: "object", properties: { x: { $ref: "#/$defs/X" } } },
        X: { type: "object", properties: { k: { $ref: "#/$defs/Leaf" } } },
        Leaf: { type: "string" },
        BadHost: {
          type: "object",
          properties: { n: { $ref: "#/$defs/W", type: "bogus" } },
        },
      },
    } as unknown as JSONSchema);
    const fragment = internSchema({
      type: "object",
      properties: { f0: { $ref: "#/$defs/W" }, f1: { $ref: "#/$defs/X" } },
    } as unknown as JSONSchema);

    expect(validateSchemaDefinition(fragment, root)).toContain(
      "unsupported schema type bogus",
    );
  });

  it("rejects sparse schema keyword arrays without rejecting sparse values", () => {
    const sparseType = [, "number"];
    const sparseRequired = [, "value"];
    const sparseDependency = [, "other"];
    const sparseEnum = [,];
    const sparseAnyOf = [, { type: "number" }];
    const sparsePrefixItems = [, { type: "number" }];
    const accessorType = ["number"];
    Object.defineProperty(accessorType, 0, {
      enumerable: true,
      get: () => "number",
    });
    const nonEnumerableRequired = ["value"];
    Object.defineProperty(nonEnumerableRequired, 0, {
      value: "value",
      enumerable: false,
    });
    const malformed = [
      { type: sparseType },
      { type: accessorType },
      { required: sparseRequired },
      { required: nonEnumerableRequired },
      { dependentRequired: { value: sparseDependency } },
      { enum: sparseEnum },
      { anyOf: sparseAnyOf },
      { prefixItems: sparsePrefixItems },
    ] as unknown as JSONSchema[];

    for (const schema of malformed) {
      expect(validateSchemaDefinition(schema)).toBeDefined();
    }
    expect(() => validateSchemaValue(malformed[0], 1)).not.toThrow();

    const sparseValue = [1, , 3];
    expect(validateSchemaValue({
      type: "array",
      items: { type: "number" },
    }, sparseValue)).toBeUndefined();
  });

  it("validates Common Fabric cell-wrapper extensions", () => {
    const valid: JSONSchema = {
      type: "undefined",
      default: undefined,
      scope: "session",
      anyOf: [
        ...CELL_KINDS.map((kind) => ({ asCell: [kind] })),
        { asCell: [{ kind: "cell", scope: "any" }] },
        { asCell: [{ kind: "cell", scope: undefined }] },
      ],
    };
    expect(validateSchemaDefinition(valid)).toBeUndefined();

    const sparseAsCell = [, "cell"];
    const accessorAsCell = ["cell"];
    Object.defineProperty(accessorAsCell, 0, {
      enumerable: true,
      get: () => "cell",
    });
    const inheritedKind = Object.create({ kind: "cell" });
    const inheritedScope = Object.assign(Object.create({ scope: "session" }), {
      kind: "cell",
    });
    const inheritedAsCell = Object.create({ asCell: ["cell"] });
    const inheritedSchemaScope = Object.create({ scope: "session" });
    const nonEnumerableKind = {};
    Object.defineProperty(nonEnumerableKind, "kind", { value: "cell" });
    const nonEnumerableScope = { kind: "cell" };
    Object.defineProperty(nonEnumerableScope, "scope", { value: "session" });
    const nonEnumerableAsCell = {};
    Object.defineProperty(nonEnumerableAsCell, "asCell", {
      value: ["cell"],
    });
    const nonEnumerableSchemaScope = {};
    Object.defineProperty(nonEnumerableSchemaScope, "scope", {
      value: "session",
    });
    const malformed = [
      { asCell: [] },
      { asCell: sparseAsCell },
      { asCell: accessorAsCell },
      { asCell: ["bogus"] },
      { asCell: [42] },
      { asCell: [{ kind: "bogus" }] },
      { asCell: [{ kind: "cell", scope: "bogus" }] },
      { asCell: [inheritedKind] },
      { asCell: [inheritedScope] },
      { asCell: [nonEnumerableKind] },
      { asCell: [nonEnumerableScope] },
      inheritedAsCell,
      nonEnumerableAsCell,
      { scope: "bogus" },
      inheritedSchemaScope,
      nonEnumerableSchemaScope,
    ] as unknown as JSONSchema[];
    for (const schema of malformed) {
      expect(validateSchemaDefinition(schema)).toBeDefined();
    }
  });

  it("reports malformed strict keyword shapes at their exact child", () => {
    const malformed: [JSONSchema, string][] = [
      [{ type: ["number", 1] } as unknown as JSONSchema, "non-string"],
      [{ type: ["number", "number"] }, "duplicate"],
      [{ minLength: -1 }, "non-negative integer"],
      [{ pattern: 1 } as unknown as JSONSchema, "pattern must be a string"],
      [{ properties: [] } as unknown as JSONSchema, "object of schemas"],
      [
        { dependentRequired: [] } as unknown as JSONSchema,
        "dependentRequired: must be an object",
      ],
      [
        { uniqueItems: "yes" } as unknown as JSONSchema,
        "uniqueItems: must be a boolean",
      ],
      [{ enum: [1, 1] }, "enum: values must be unique"],
      [
        { anyOf: [{ type: ["number", "number"] }] },
        "anyOf[0]",
      ],
      [
        { prefixItems: [{ type: ["number", "number"] }] },
        "prefixItems[0]",
      ],
      [
        { items: { type: ["number", "number"] } },
        "items",
      ],
      // A keyword holding something no schema can be. A stored schema is not
      // always generator output, and the runner's schema walk defers to this
      // rule for what a subschema may be.
      [
        { properties: { a: null } } as unknown as JSONSchema,
        "properties.a: schema must be an object or boolean",
      ],
      [
        { additionalProperties: "ab" } as unknown as JSONSchema,
        "additionalProperties: schema must be an object or boolean",
      ],
      // An array is one of those, which is what makes the pre-2019 tuple
      // spelling of `items` unreadable rather than merely unsupported.
      [
        { items: [{ type: "string" }] } as unknown as JSONSchema,
        "items: schema must be an object or boolean",
      ],
    ];
    for (const [schema, message] of malformed) {
      expect(validateSchemaDefinition(schema)).toContain(message);
    }
  });

  it("fails closed for cyclic values and indeterminate schema branches", () => {
    const recursive: JSONSchema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
        },
      },
    };
    const cyclic: { next?: unknown } = {};
    cyclic.next = cyclic;
    expect(validateSchemaValue(recursive, cyclic)).toContain(
      "recursive schema",
    );

    expect(validateSchemaValue([] as unknown as JSONSchema, 1)).toContain(
      "object or boolean",
    );
    expect(validateSchemaValue({ $ref: "#/$defs/Missing" }, 1)).toContain(
      "cannot resolve schema reference",
    );
    expect(validateSchemaValue({
      anyOf: [
        { type: "number" },
        { $ref: "#/$defs/Missing" },
      ],
    }, "not-a-number")).toContain("cannot resolve schema reference");
  });

  it("skips sparse value holes in every collection validation mode", () => {
    const sparse = [1, , 3];
    expect(validateAgainstSchema({ items: { type: "number" } }, sparse))
      .toBeUndefined();
    expect(validateSchemaValue({ uniqueItems: true }, [1, , 1])).toContain(
      "not unique",
    );
    expect(validateSchemaValue({ contains: { type: "number" } }, [1, ,]))
      .toBeUndefined();

    const sameFunction = () => 1;
    expect(validateSchemaValue({ uniqueItems: true }, [
      sameFunction,
      sameFunction,
    ])).toContain("not unique");
    expect(validateSchemaValue({ uniqueItems: true }, [
      () => 1,
      () => 1,
    ])).toBeUndefined();
  });

  it("reports every strict migration constraint it cannot satisfy", () => {
    const invalid: [JSONSchema, unknown, string][] = [
      [{ not: { type: "number" } }, 1, "not schema"],
      [{ if: { type: "number" }, then: { minimum: 2 } }, 1, "minimum"],
      [{ if: { type: "number" }, else: { minLength: 2 } }, "x", "minLength"],
      [{ minimum: 2 }, 1, "minimum"],
      [{ exclusiveMinimum: 1 }, 1, "exclusiveMinimum"],
      [{ maximum: 1 }, 2, "maximum"],
      [{ exclusiveMaximum: 2 }, 2, "exclusiveMaximum"],
      [{ multipleOf: 2 }, 3, "multiple"],
      [{ multipleOf: 0 }, 0, "multiple"],
      [{ minLength: 2 }, "x", "minLength"],
      [{ maxLength: 1 }, "xy", "maxLength"],
      [{ pattern: "[" }, "x", "invalid pattern"],
      [{ pattern: "^x$" }, "y", "pattern"],
      [{ format: "email" }, "invalid", "format email"],
      [{ minItems: 2 }, [1], "minItems"],
      [{ maxItems: 1 }, [1, 2], "maxItems"],
      [{ uniqueItems: true }, [1, 1], "not unique"],
      [{ prefixItems: [{ type: "string" }] }, [1], "0:"],
      [{ items: { type: "number" } }, ["x"], "0:"],
      [{ contains: { type: "number" } }, ["x"], "fewer than 1"],
      [
        {
          contains: { type: "number" },
          maxContains: 1,
        },
        [1, 2],
        "more than 1",
      ],
      [{ minProperties: 2 }, { one: 1 }, "minProperties"],
      [{ maxProperties: 1 }, { one: 1, two: 2 }, "maxProperties"],
      [
        {
          dependentRequired: { one: ["two"] },
        },
        { one: 1 },
        "dependent property two",
      ],
      [
        {
          dependentSchemas: { one: { required: ["two"] } },
        },
        { one: 1 },
        "missing required property two",
      ],
      [{ propertyNames: { pattern: "^[a-z]+$" } }, { "BAD!": 1 }, "BAD!"],
      [
        { patternProperties: { "[": { type: "number" } } },
        { x: 1 },
        "invalid property pattern",
      ],
      [{ patternProperties: { "^x": { type: "number" } } }, { x: "bad" }, "x:"],
      [{ contentEncoding: "base64" }, "encoded", "not supported"],
      [{ contentMediaType: "application/json" }, "encoded", "not supported"],
      [{ contentSchema: { type: "object" } }, "encoded", "not supported"],
    ];
    for (const [schema, value, message] of invalid) {
      expect(validateSchemaValue(schema, value)).toContain(message);
    }
    expect(validateSchemaValue({
      prefixItems: [{ type: "string" }, { type: "number" }],
    }, ["only-present-item"])).toBeUndefined();
  });

  it("fails closed on recursive schema validation", () => {
    const recursive: JSONSchema = {
      allOf: [{ $ref: "#/$defs/Loop" }],
      $defs: {
        Loop: { allOf: [{ $ref: "#/$defs/Loop" }] },
      },
    };

    expect(() => validateSchemaValue(recursive, "value")).not.toThrow();
    expect(validateSchemaValue(recursive, "value")).toContain(
      "recursive schema",
    );

    const productive: JSONSchema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "number" },
            next: { $ref: "#/$defs/Node" },
          },
          required: ["value"],
        },
      },
    };
    expect(validateSchemaValue(productive, {
      value: 1,
      next: { value: 2 },
    })).toBeUndefined();
  });

  it("reports a ref that only a subschema's own `$defs` could satisfy as unresolvable", () => {
    const shared = { $ref: "#/$defs/V" } as const;
    const schema: JSONSchema = {
      type: "object",
      properties: {
        text: { $defs: { V: { type: "string" } }, allOf: [shared] },
      },
    };

    expect(validateSchemaDefinition(schema))
      .toContain("cannot resolve schema reference");
  });

  it("reports malformed referenced schemas and literal payloads", () => {
    const cyclic: any = {
      type: "object",
      properties: {},
    };
    cyclic.properties.self = cyclic;
    const malformed: JSONSchema[] = [
      {
        $ref: "#/$defs/X",
        $defs: { X: null },
      } as unknown as JSONSchema,
      { const: Symbol("unique") } as unknown as JSONSchema,
      { enum: [new Map()] } as unknown as JSONSchema,
      { default: () => {} } as unknown as JSONSchema,
      { default: new Uint8Array([1]) } as unknown as JSONSchema,
      cyclic,
    ];

    for (const schema of malformed) {
      expect(() => validateSchemaDefinition(schema)).not.toThrow();
      expect(validateSchemaDefinition(schema)).toBeDefined();
    }
  });

  it("does not treat indeterminate recursive branches as ordinary mismatches", () => {
    const loop = { allOf: [{ $ref: "#/$defs/Loop" }] };
    const definitions = { Loop: loop };
    const expectRecursiveFailure = (
      schema: Exclude<JSONSchema, boolean>,
      value: unknown,
    ) => {
      expect(validateSchemaValue({ ...schema, $defs: definitions }, value))
        .toContain("recursive schema");
    };

    expectRecursiveFailure({ not: { $ref: "#/$defs/Loop" } }, "value");
    expectRecursiveFailure({
      oneOf: [{ type: "string" }, { $ref: "#/$defs/Loop" }],
    }, "value");
    expectRecursiveFailure({
      if: { $ref: "#/$defs/Loop" },
      then: false,
      else: true,
    }, "value");
    expectRecursiveFailure({
      type: "array",
      contains: { $ref: "#/$defs/Loop" },
      minContains: 0,
      maxContains: 0,
    }, ["value"]);

    expect(validateSchemaValue({
      anyOf: [{ type: "string" }, { $ref: "#/$defs/Loop" }],
      $defs: definitions,
    }, "value")).toBeUndefined();

    expect(validateSchemaValue({
      not: { type: "custom" } as unknown as JSONSchema,
    }, "value")).toContain("unsupported schema type custom");
    expect(validateSchemaValue({
      oneOf: [
        { type: "string" },
        { type: "custom" } as unknown as JSONSchema,
      ],
    }, "value")).toContain("unsupported schema type custom");
    expect(validateSchemaValue({
      if: { type: "string", pattern: "[" },
      then: false,
      else: true,
    }, "value")).toContain("invalid pattern");
    expect(validateSchemaValue({
      not: { type: "string", contentEncoding: "base64" },
    }, "value")).toContain("content validation is not supported");
    expect(validateSchemaValue({
      anyOf: [
        { type: "string" },
        { type: "custom" } as unknown as JSONSchema,
      ],
    }, "value")).toBeUndefined();
  });

  it("validates the schema formats generated by Common Fabric", () => {
    const valid: [string, string][] = [
      ["email", "a@b.co"],
      ["email", "a@localhost"],
      ["email", '"quoted local"@example.com'],
      ["uri", "https://example.com/path"],
      ["date", "2026-07-14"],
      ["date-time", "2026-07-14T12:34:56Z"],
      ["date-time", "2026-07-14t12:34:56z"],
      ["date-time", "2016-12-31T23:59:60Z"],
    ];
    for (const [format, value] of valid) {
      expect(validateSchemaValue({ type: "string", format }, value))
        .toBeUndefined();
    }
    for (
      const [format, value] of [
        ["email", ".a@example.com"],
        ["email", "a..b@example.com"],
        ["email", "a@example..com"],
        ["uri", "not a uri"],
        ["date", "not a date"],
        ["date", "2026-02-30"],
        ["date-time", "not a timestamp"],
        ["date-time", "2026-02-30T12:00:00Z"],
        ["date-time", "2026-01-01T24:00:00Z"],
        ["custom", "value"],
      ]
    ) {
      expect(validateSchemaValue({ type: "string", format }, value))
        .toContain(`format ${format}`);
    }
  });
});

describe("schema-based prompt injection sanitization compatibility", () => {
  it("adds InjectionSafe to closed enum, number, and boolean fields but not free strings", () => {
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["approve", "reject"] },
        confidence: { type: "number" },
        approved: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["action", "confidence", "approved", "reason"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const sanitized = schemaWithInjectionSafeAnnotations(schema, [
      promptRisk,
      promptInfluence,
    ]) as any;

    expect(sanitized.ifc).toBeUndefined();
    expect(sanitized.properties.action.ifc).toMatchObject({
      confidentiality: [promptInfluence],
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
    expect(sanitized.properties.confidence.ifc).toMatchObject({
      confidentiality: [promptInfluence],
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
    expect(sanitized.properties.approved.ifc).toMatchObject({
      confidentiality: [promptInfluence],
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
    expect(sanitized.properties.reason.ifc).toMatchObject({
      confidentiality: [promptRisk, promptInfluence],
    });
    expect(sanitized.properties.reason.ifc.addIntegrity).toBeUndefined();
  });

  it("discharges ALL material-risk caveats on a large label (fuel scales past the default 64)", () => {
    // A path carrying more than DEFAULT_EXCHANGE_FUEL (64) material-risk
    // ALTERNATIVES must still be fully discharged on an instruction-inert
    // field — the old strip removed all of them, and the fuel budget must
    // scale (over the summed clause-alternative count, not the clause count)
    // so the rule path matches that (cubic P2 on #4567). With a fixed 64-fuel
    // budget this retains the tail. Mixes flat caveats AND OR-clauses whose
    // material-risk alternative must be dropped from within the clause — the
    // alternative-count path the fuel budget sums over.
    const risk = (i: number) => ({
      type: CFC_ATOM_TYPE.Caveat,
      kind:
        "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
      source: `of:hostile-${i}`,
    });
    const keep = (i: number) => ({
      type: CFC_ATOM_TYPE.User,
      subject: `did:key:reader-${i}`,
    });
    const flatRisks = Array.from({ length: 50 }, (_, i) => risk(i));
    // 40 OR-clauses (80 alternatives), each a risk beside a retained atom.
    const orRisks = Array.from(
      { length: 40 },
      (_, i) => ({ anyOf: [risk(1000 + i), keep(i)] }),
    );
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["approve", "reject"] },
      },
      required: ["action"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const sanitized = schemaWithInjectionSafeAnnotations(
      schema,
      [
        ...flatRisks,
        ...orRisks,
        "prompt-injection-risk-unscreened",
        { anyOf: ["prompt-injection-risk-unscreened", keep(100)] },
      ],
    ) as any;

    const remaining: unknown[] = sanitized.properties.action.ifc
      .confidentiality ?? [];
    // No material-risk alternative survives anywhere — not as a bare clause,
    // not nested inside a surviving OR-clause.
    const hasMaterialRiskAnywhere = remaining.some((clause) =>
      isPromptInjectionMaterialRiskAtom(clause) ||
      (isObjectOrArray(clause) &&
        Array.isArray((clause as { anyOf?: unknown }).anyOf) &&
        (clause as { anyOf: unknown[] }).anyOf.some(
          isPromptInjectionMaterialRiskAtom,
        ))
    );
    expect(hasMaterialRiskAnywhere).toBe(false);
    // The retained (non-risk) alternatives survive.
    expect(remaining.length).toBe(41);
  });

  it("marks a whole closed object when every readable child is instruction-inert", () => {
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["approve", "reject"] },
        confidence: { type: "integer" },
      },
      required: ["action", "confidence"],
    } as const satisfies JSONSchema;

    const sanitized = schemaWithInjectionSafeAnnotations(schema, [
      promptRisk,
    ]) as any;

    expect(sanitized.ifc).toMatchObject({
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
    expect(sanitized.ifc.confidentiality ?? []).not.toContain(promptRisk);
  });

  it("keeps open object schemas tainted at the parent", () => {
    const schema = {
      type: "object",
      properties: {
        confidence: { type: "number" },
      },
      additionalProperties: true,
    } as const satisfies JSONSchema;

    const sanitized = schemaWithInjectionSafeAnnotations(schema, [
      promptRisk,
    ]) as any;

    expect(sanitized.ifc.confidentiality).toEqual([promptRisk]);
    expect(sanitized.properties.confidence.ifc).toMatchObject({
      addIntegrity: [INJECTION_SAFE_ATOM],
    });
  });

  it("validates closed structured values before sanitization", () => {
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["approve", "reject"] },
      },
      required: ["action"],
    } as const satisfies JSONSchema;

    expect(validateAgainstSchema(schema, { action: "approve" }))
      .toBeUndefined();
    expect(validateAgainstSchema(schema, { action: "maybe" })).toContain(
      "enum",
    );
    expect(validateAgainstSchema(schema, {
      action: "approve",
      body: "extra",
    })).toContain("additional property body");
  });

  it("leaves empty schemas permissive while closing object-shaped schemas", () => {
    expect(validateAgainstSchema({}, { body: "extra" })).toBeUndefined();
    expect(validateAgainstSchema(true, { body: "extra" })).toBeUndefined();
    expect(validateAgainstSchema({
      properties: { approved: { type: "boolean" } },
    }, { approved: true, body: "extra" })).toContain(
      "additional property body",
    );
  });

  it("terminates on a self-recursive combinator branch surface", () => {
    const recursiveUnion = (keyword: "anyOf" | "oneOf" | "allOf") => ({
      type: "object",
      [keyword]: [{ $ref: "#/$defs/Node" }],
      $defs: {
        Node: {
          type: "object",
          [keyword]: [
            { type: "object", properties: { leaf: { type: "number" } } },
            { $ref: "#/$defs/Node" },
          ],
        },
      },
    } as unknown as JSONSchema);

    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      const schema = recursiveUnion(keyword);
      // The walk that reads a union's property surface follows the same
      // `$ref` the union declares, so without a visited set this overflows
      // the stack instead of answering.
      expect(() => validateAgainstSchema(schema, { leaf: 1 })).not.toThrow();
      // A cycle contributes nothing rather than opening the surface, so a key
      // no branch models is still refused.
      expect(validateAgainstSchema(schema, { leaf: 1, smuggled: "x" }))
        .toBeDefined();
    }

    // The branches carry the shape, so a union node still admits what they
    // declare — the guard cuts the cycle, not the surface.
    expect(validateAgainstSchema(recursiveUnion("anyOf"), { leaf: 1 }))
      .toBeUndefined();
  });

  it("collects the names of two branches that share one `$ref` under different constraints", () => {
    const schema = {
      type: "object",
      anyOf: [
        { $ref: "#/$defs/Base", properties: { alpha: { type: "number" } } },
        { $ref: "#/$defs/Base", properties: { beta: { type: "number" } } },
      ],
      $defs: { Base: { type: "object" } },
    } as unknown as JSONSchema;

    // Each branch is a ref SITE of its own: the definition they share says
    // nothing about properties, so the names live on the sites. A guard that
    // remembered the ref for the whole walk would skip the second site and
    // treat the key it declares as unmodeled.
    expect(validateAgainstSchema(schema, { alpha: 1 })).toBeUndefined();
    expect(validateAgainstSchema(schema, { beta: 1 })).toBeUndefined();
    // A name no branch declares is refused, by the branches themselves.
    expect(validateAgainstSchema(schema, { alpha: 1, smuggled: "x" }))
      .toBeDefined();
  });

  it("answers for a combinator chain far deeper than the call stack", () => {
    const depth = 20_000;
    let chain: JSONSchema = {
      type: "object",
      properties: { [`key${depth}`]: { type: "number" } },
    } as unknown as JSONSchema;
    for (let index = depth - 1; index >= 0; index--) {
      chain = {
        type: "object",
        properties: { [`key${index}`]: { type: "number" } },
        anyOf: [chain],
      } as unknown as JSONSchema;
    }
    // The value matches the first branch, so validation itself stops there;
    // the surface walk is what visits every link of the chain.
    const schema = {
      type: "object",
      properties: { head: { type: "number" } },
      anyOf: [
        { type: "object", properties: { head: { type: "number" } } },
        chain,
      ],
    } as unknown as JSONSchema;

    // Nothing about the chain is cyclic, so no visited set cuts it: only a
    // walk that keeps its own worklist reaches the end of it and answers.
    expect(validateAgainstSchema(schema, { head: 1 })).toBeUndefined();
  });

  it("terminates on a branch surface that cycles through a nested ref", () => {
    const schema = {
      type: "object",
      anyOf: [{ $ref: "#/$defs/Node" }],
      $defs: {
        Node: {
          type: "object",
          anyOf: [
            { type: "object", properties: { leaf: { type: "number" } } },
            { $ref: "#/$defs/Wrapper" },
          ],
        },
        Wrapper: {
          type: "object",
          allOf: [{ $ref: "#/$defs/Node" }],
        },
      },
    } as unknown as JSONSchema;

    expect(validateAgainstSchema(schema, { leaf: 1 })).toBeUndefined();
    expect(validateAgainstSchema(schema, { leaf: 1, smuggled: "x" }))
      .toBeDefined();
  });

  it("leaves a union open when a branch of it is open", () => {
    // The node itself closes only by the implicit default, so it defers to
    // its branches: one branch that admits anything leaves the whole surface
    // open, and the node stops policing keys its branches will judge.
    const openBranch = {
      type: "object",
      anyOf: [{
        type: "object",
        properties: { a: { type: "number" } },
        additionalProperties: true,
      }],
    } as const satisfies JSONSchema;
    expect(validateAgainstSchema(openBranch, { a: 1, extra: "x" }))
      .toBeUndefined();

    // A boolean branch is the same answer by a shorter route: `true` models
    // nothing and refuses nothing.
    const booleanBranch = {
      type: "object",
      anyOf: [true],
    } as const satisfies JSONSchema;
    expect(validateAgainstSchema(booleanBranch, { extra: "x" }))
      .toBeUndefined();

    // `false` admits nothing, so it contributes nothing — neither property
    // names nor openness. The closed branch beside it decides the surface.
    const rejectingBranch = {
      type: "object",
      anyOf: [
        false,
        { type: "object", properties: { a: { type: "number" } } },
      ],
    } as const satisfies JSONSchema;
    expect(validateAgainstSchema(rejectingBranch, { a: 1 })).toBeUndefined();
    // The branch judges the key before the node's own surface check does, so
    // the refusal reads as the branch's rather than the node's — refused
    // either way.
    expect(validateAgainstSchema(rejectingBranch, { a: 1, extra: "x" }))
      .toBeDefined();
  });

  it("leaves a union open when a branch of a branch is open", () => {
    // Openness reached through a nested combinator is openness all the same:
    // the outer branch is a closed object, but its own branch admits
    // anything, so the surface the outer node reads is open and it stops
    // policing keys the branches will judge.
    const nestedOpen = {
      type: "object",
      anyOf: [{
        type: "object",
        properties: { kind: { type: "string" } },
        anyOf: [{
          type: "object",
          properties: { a: { type: "number" } },
          additionalProperties: true,
        }],
      }],
    } as const satisfies JSONSchema;
    expect(validateAgainstSchema(nestedOpen, { kind: "a", extra: "x" }))
      .toBeUndefined();

    // The same shape with the nested branch closed keeps the surface closed,
    // so the key no branch models is refused.
    const nestedClosed = {
      type: "object",
      anyOf: [{
        type: "object",
        properties: { kind: { type: "string" } },
        anyOf: [{
          type: "object",
          properties: { a: { type: "number" } },
        }],
      }],
    } as const satisfies JSONSchema;
    expect(validateAgainstSchema(nestedClosed, { a: 1, extra: "x" }))
      .toBeDefined();
    // A key a nested branch does model is admitted either way.
    expect(validateAgainstSchema(nestedClosed, { a: 1 })).toBeUndefined();
  });

  it("takes an explicitly closed object at its word over its branches", () => {
    const schema = {
      type: "object",
      properties: { kind: { type: "string" } },
      additionalProperties: false,
      oneOf: [{
        type: "object",
        properties: { kind: { type: "string" }, count: { type: "number" } },
      }],
    } as const satisfies JSONSchema;

    expect(validateAgainstSchema(schema, { kind: "a" })).toBeUndefined();
    expect(validateAgainstSchema(schema, { kind: "a", count: 1 })).toContain(
      "additional property count",
    );
  });

  it("recognizes material-risk caveats without treating prompt influence as clearable", () => {
    expect(isPromptInjectionMaterialRiskAtom(promptRisk)).toBe(true);
    expect(isPromptInjectionMaterialRiskAtom(promptInfluence)).toBe(false);
  });

  it("terminates on self-referential ref schemas", () => {
    const schema = {
      $defs: {
        Node: {
          type: "object",
          properties: {
            label: { type: "string" },
            children: {
              type: "array",
              items: { $ref: "#/$defs/Node" },
            },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
      $ref: "#/$defs/Node",
    } as const satisfies JSONSchema;

    const sanitized = schemaWithInjectionSafeAnnotations(schema, [
      promptInfluence,
    ]) as any;

    expect(sanitized).toBeDefined();
    expect(typeof sanitized).toBe("object");
  });

  it("does not mutate the input schema", () => {
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["approve", "reject"] },
        reason: { type: "string" },
      },
      required: ["action", "reason"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    const before = JSON.stringify(schema);

    schemaWithInjectionSafeAnnotations(schema, [promptRisk, promptInfluence]);

    expect(JSON.stringify(schema)).toBe(before);
  });

  it("validates nested refs by preserving root defs across recursion", () => {
    const schema = {
      $defs: {
        Outer: {
          type: "object",
          properties: {
            label: { type: "string" },
            payload: { $ref: "#/$defs/Inner" },
          },
          required: ["label", "payload"],
          additionalProperties: false,
        },
        Inner: {
          type: "object",
          properties: {
            value: { type: "number" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      },
      $ref: "#/$defs/Outer",
    } as const satisfies JSONSchema;

    expect(
      validateAgainstSchema(schema, {
        label: "ok",
        payload: { value: 42 },
      }),
    ).toBeUndefined();

    expect(
      validateAgainstSchema(schema, {
        label: "ok",
        payload: { value: "not a number" },
      }),
    ).toBeDefined();
  });

  it("sanitizes free strings to opaque links while preserving schema-inert values", () => {
    const schema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["approve", "reject"] },
        confidence: { type: "number" },
        evidence: { type: "string" },
      },
      required: ["action", "confidence", "evidence"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const sanitized = validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: {
        action: "approve",
        confidence: 0.9,
        evidence: "untrusted page text",
      },
      opaqueHandleId: "child-run-1",
    });

    expect(sanitized).toEqual({
      value: {
        action: "approve",
        confidence: 0.9,
        evidence: { "@link": "opaque:child-run-1#/evidence" },
      },
      linkedStringCount: 1,
      sealedPaths: [["evidence"]],
    });
  });

  it("seals a `FabricSpecialObject` rather than showing it", () => {
    // A special object holds its state behind no property name, so the record
    // arm cannot measure it against the schema the way the unmodeled-key
    // policy measures a record. Sealing is the fail-closed answer, and the
    // one that policy already gives for a key it cannot model; passing the
    // value through would show contents nothing had checked.

    const schema = {
      type: "object",
      properties: { blob: { type: "object" } },
      required: ["blob"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const sanitized = validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: { blob: new FabricBytes(new Uint8Array([1, 2, 3])) },
      opaqueHandleId: "child-run-1",
    });

    expect(sanitized).toEqual({
      value: { blob: { "@link": "opaque:child-run-1#/blob" } },
      linkedStringCount: 0,
      sealedPaths: [["blob"]],
    });
  });

  it("sanitizes tuple (prefixItems) elements against their slot schema", () => {
    // `itemSchemaForIndex` collects the `prefixItems` slot schema for a
    // covered index, so a tuple element is sanitized against its own slot: a
    // raw string in a number slot is replaced with an opaque link.
    const schema = {
      type: "object",
      properties: {
        pair: {
          type: "array",
          prefixItems: [
            { type: "string", enum: ["label"] },
            { type: "number" },
          ],
        },
      },
      required: ["pair"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const sanitized = validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: { pair: ["label", "untrusted page text"] },
      opaqueHandleId: "child-run-1",
    });

    // Slot 0 pins the string via its enum — kept (schema-inert); slot 1 is
    // a number slot, so the raw string is linkified rather than passed
    // through.
    expect(sanitized).toEqual({
      value: {
        pair: ["label", { "@link": "opaque:child-run-1#/pair/1" }],
      },
      linkedStringCount: 1,
      sealedPaths: [["pair", 1]],
    });
  });

  it("boolean tuple slots sanitize with boolean semantics", () => {
    // itemSchemaForIndex pushes boolean slot schemas through combineAllOf: a
    // `true` slot keeps non-string values as-is (free strings still
    // linkify — an unconstrained schema does not pin them); a `false` slot
    // admits nothing, so the raw string there is linkified.
    const schema = {
      type: "object",
      properties: {
        pair: {
          type: "array",
          prefixItems: [true, false],
        },
      },
      required: ["pair"],
      additionalProperties: false,
    } as unknown as JSONSchema;

    const sanitized = validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: { pair: [5, "blocked"] },
      opaqueHandleId: "child-run-1",
    });

    expect(sanitized).toEqual({
      value: {
        pair: [5, { "@link": "opaque:child-run-1#/pair/1" }],
      },
      linkedStringCount: 1,
      sealedPaths: [["pair", 1]],
    });
  });

  it("preserves caller-provided opaque links when the matching schema branch allows them", () => {
    const opaqueLinkSchema = {
      type: "object",
      properties: {
        "@link": { type: "string" },
      },
      required: ["@link"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    const schema = {
      type: "object",
      properties: {
        evidence: {
          anyOf: [
            opaqueLinkSchema,
            { type: "string" },
          ],
        },
      },
      required: ["evidence"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const sanitized = validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: {
        evidence: { "@link": "opaque:child-run-1#/raw" },
      },
      opaqueHandleId: "child-run-1",
    });

    expect(sanitized).toEqual({
      value: {
        evidence: { "@link": "opaque:child-run-1#/raw" },
      },
      linkedStringCount: 0,
      sealedPaths: [],
    });
  });

  it("keeps a raw string a nested oneOf branch names as a constant", () => {
    // The outer `oneOf` picks the branch, and the branch is a union of its
    // own: the string survives only if the walk keeps descending through it.
    const schema = {
      type: "object",
      properties: {
        label: {
          oneOf: [
            { oneOf: [{ const: "one" }, { const: "two" }] },
            { type: "number" },
          ],
        },
      },
      required: ["label"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: { label: "two" },
      opaqueHandleId: "run-1",
    })).toEqual({
      value: { label: "two" },
      linkedStringCount: 0,
      sealedPaths: [],
    });

    // A string no branch names is not inert text, so it goes over as a link.
    expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema: {
        type: "object",
        properties: { label: { oneOf: [{ type: "string" }] } },
        required: ["label"],
        additionalProperties: false,
      } as const satisfies JSONSchema,
      value: { label: "three" },
      opaqueHandleId: "run-1",
    })).toEqual({
      value: { label: { "@link": "opaque:run-1#/label" } },
      linkedStringCount: 1,
      sealedPaths: [["label"]],
    });
  });

  it("keeps a raw string a nested anyOf branch names as a constant", () => {
    const schema = {
      type: "object",
      properties: {
        tag: {
          oneOf: [
            { anyOf: [{ const: "alpha" }, { const: "beta" }] },
            { type: "number" },
          ],
        },
      },
      required: ["tag"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: { tag: "beta" },
      opaqueHandleId: "run-1",
    })).toEqual({
      value: { tag: "beta" },
      linkedStringCount: 0,
      sealedPaths: [],
    });

    // The number branch of the same union is inert on its own terms.
    expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: { tag: 7 },
      opaqueHandleId: "run-1",
    })).toEqual({ value: { tag: 7 }, linkedStringCount: 0, sealedPaths: [] });
  });

  it("seals a very large array without overflowing the argument limit", () => {
    // 150k sealed siblings under one parent: a spread-append of the child's
    // sealed paths passes each as a call argument and throws RangeError.
    const size = 150_000;
    const sanitized = validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema: {
        type: "object",
        properties: {
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["notes"],
        additionalProperties: false,
      },
      value: { notes: Array.from({ length: size }, (_, i) => `note ${i}`) },
      opaqueHandleId: "run-1",
    });
    expect(sanitized.linkedStringCount).toBe(size);
    expect(sanitized.sealedPaths.length).toBe(size);
    expect(sanitized.sealedPaths[0]).toEqual(["notes", 0]);
    expect(sanitized.sealedPaths[size - 1]).toEqual(["notes", size - 1]);
  });

  it("preserves an opaque link an allOf or oneOf branch declares", () => {
    const opaqueLinkSchema = {
      type: "object",
      properties: { "@link": { type: "string" } },
      required: ["@link"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    const allOfSchema = {
      type: "object",
      properties: { evidence: { allOf: [opaqueLinkSchema] } },
      required: ["evidence"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema: allOfSchema,
      value: { evidence: { "@link": "opaque:child-run-1#/raw" } },
      opaqueHandleId: "run-1",
    })).toEqual({
      value: { evidence: { "@link": "opaque:child-run-1#/raw" } },
      linkedStringCount: 0,
      sealedPaths: [],
    });

    const oneOfSchema = {
      type: "object",
      properties: {
        evidence: { oneOf: [opaqueLinkSchema, { type: "number" }] },
      },
      required: ["evidence"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema: oneOfSchema,
      value: { evidence: { "@link": "opaque:child-run-1#/raw" } },
      opaqueHandleId: "run-1",
    })).toEqual({
      value: { evidence: { "@link": "opaque:child-run-1#/raw" } },
      linkedStringCount: 0,
      sealedPaths: [],
    });
  });

  it("drops a reserved key the schema does not model instead of sealing", () => {
    const schema = {
      type: "object",
      properties: { total: { type: "number" } },
      required: ["total"],
    } as const satisfies JSONSchema;

    // Reserved names are excused from the unmodeled-key policy, so the
    // computed number survives instead of the whole object going over as one
    // opaque link — and the reserved keys are dropped rather than shown.
    expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: { total: 42, $NAME: "Doubler", $UI: { tag: "div" } },
      opaqueHandleId: "run-1",
      reservedKeys: ["$NAME", "$UI"],
    })).toEqual({
      value: { total: 42 },
      linkedStringCount: 0,
      sealedPaths: [],
    });

    // A name NOT on the reserved list is refused by the same closed-object
    // rule the reserved names are excused from.
    expect(() =>
      validateAndSanitizeSchemaValueWithOpaqueLinks({
        schema,
        value: { total: 42, leaked: "secret" },
        opaqueHandleId: "run-1",
        reservedKeys: ["$NAME", "$UI"],
      })
    ).toThrow("additional property leaked");

    // Where the schema is open enough to admit it, an unreserved key still
    // seals the object: a key the schema cannot model is a key whose spelling
    // may itself be data.
    expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema: { ...schema, additionalProperties: true },
      value: { total: 42, leaked: "secret", $NAME: "Doubler" },
      opaqueHandleId: "run-1",
      reservedKeys: ["$NAME", "$UI"],
    })).toEqual({
      value: { "@link": "opaque:run-1" },
      linkedStringCount: 0,
      sealedPaths: [[]],
    });
  });

  it("seals a nested object carrying an unmodeled reserved name instead of dropping it", () => {
    const schema = {
      type: "object",
      properties: {
        total: { type: "number" },
        nested: {
          type: "object",
          properties: { kept: { type: "number" } },
          additionalProperties: true,
        },
      },
      required: ["total"],
    } as const satisfies JSONSchema;

    // The framework names the keys of the result it produced, and nothing
    // inside it: one level down, `$NAME` was chosen by whoever wrote the data
    // there, so the object seals like any other object with a key the schema
    // does not model. Dropping the name and releasing `kept` would be author
    // data leaving on the strength of a spelling the author chose.
    expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: {
        total: 42,
        $NAME: "Doubler",
        nested: { kept: 7, $NAME: "sibling" },
      },
      opaqueHandleId: "run-1",
      reservedKeys: ["$NAME", "$UI"],
    })).toEqual({
      // The top level keeps its exemption: the reserved key is dropped and
      // the modeled number beside it survives.
      value: { total: 42, nested: { "@link": "opaque:run-1#/nested" } },
      linkedStringCount: 0,
      sealedPaths: [["nested"]],
    });

    // Where the nested object is CLOSED, the same unmodeled key is a
    // validation failure, exactly as an unreserved name would be.
    expect(() =>
      validateAndSanitizeSchemaValueWithOpaqueLinks({
        schema: {
          type: "object",
          properties: {
            nested: {
              type: "object",
              properties: { kept: { type: "number" } },
            },
          },
        } as const satisfies JSONSchema,
        value: { $NAME: "Doubler", nested: { kept: 7, $NAME: "sibling" } },
        opaqueHandleId: "run-1",
        reservedKeys: ["$NAME", "$UI"],
      })
    ).toThrow("additional property $NAME");
  });

  it("sanitizes against a self-recursive union without walking the call stack", () => {
    const schema = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      required: ["node"],
      $defs: {
        Node: {
          type: "object",
          anyOf: [
            { $ref: "#/$defs/Node" },
            { type: "object", properties: { leaf: { type: "number" } } },
          ],
        },
      },
    } as unknown as JSONSchema;

    // Reading which names a union models follows the same `$ref` the union
    // declares, so the walk has to cut its own cycle rather than ride the
    // stack down.
    expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: { node: { leaf: 1 } },
      opaqueHandleId: "run-1",
    })).toEqual({
      value: { node: { leaf: 1 } },
      linkedStringCount: 0,
      sealedPaths: [],
    });
  });

  it("measures a reserved key the schema does model, and measures it raw", () => {
    const schema = {
      oneOf: [{
        type: "object",
        properties: {
          count: { type: "number" },
          $NAME: { type: "string", const: "allowed" },
        },
        required: ["count", "$NAME"],
      }],
    } as const satisfies JSONSchema;

    // The value is measured as it arrived: the branch asks what `$NAME`
    // holds, and a value that does not answer is refused. Projecting the
    // reserved key out before validating would hand the branch `{count: 42}`
    // and have it accepted.
    expect(() =>
      validateAndSanitizeSchemaValueWithOpaqueLinks({
        schema,
        value: { count: 42, $NAME: "wrong" },
        opaqueHandleId: "run-1",
        reservedKeys: ["$NAME"],
      })
    ).toThrow();

    // A reserved key a composed schema declares is still available: it is
    // modeled, so it is kept and sanitized rather than dropped.
    expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: { count: 42, $NAME: "allowed" },
      opaqueHandleId: "run-1",
      reservedKeys: ["$NAME"],
    })).toEqual({
      value: { count: 42, $NAME: "allowed" },
      linkedStringCount: 0,
      sealedPaths: [],
    });
  });

  it("keeps a property only a later matching anyOf branch declares", () => {
    // `anyOf` is "one or more branches match", so a value matching two of them
    // is described by both. Reading only the first leaves the second branch's
    // properties unmodeled — validation accepts `note`, and the sanitizer then
    // seals the whole object over the very key validation just admitted.
    const schema = {
      type: "object",
      anyOf: [
        {
          type: "object",
          properties: { id: { type: "number" } },
          additionalProperties: true,
        },
        {
          type: "object",
          properties: { id: { type: "number" }, note: { const: "ok" } },
          additionalProperties: true,
        },
      ],
    } as unknown as JSONSchema;

    expect(validateAndSanitizeSchemaValueWithOpaqueLinks({
      schema,
      value: { id: 1, note: "ok" },
      opaqueHandleId: "run-1",
    })).toEqual({
      value: { id: 1, note: "ok" },
      linkedStringCount: 0,
      sealedPaths: [],
    });
  });
});
