import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callSchemas,
  callsNamed,
  emittedSchemas,
  parseModule,
  patternSchemas,
} from "./transformed-ast.ts";
import { transformFiles } from "./utils.ts";

/** The transformed module of `source`, type-checked. */
const transformed = async (source: string): Promise<ts.SourceFile> =>
  parseModule(
    (await transformFiles({ "/main.tsx": source }, {
      types: COMMONFABRIC_TYPES,
      typeCheck: true,
    }))["/main.tsx"]!,
  );

/**
 * `schema` with each `anyOf`'s branches in one order, and with the
 * `{ type: "undefined" }` branch of an optional property's schema left out,
 * since the property admits `undefined` whether or not its schema lists it. A
 * single branch left is merged into the schema around it.
 */
const equivalentSchema = (schema: unknown, optional = false): unknown => {
  if (Array.isArray(schema)) {
    return schema.map((item) => equivalentSchema(item));
  }
  if (typeof schema !== "object" || schema === null) return schema;
  const object = schema as Record<string, unknown>;
  const required = Array.isArray(object.required) ? object.required : [];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    result[key] = key === "properties"
      ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map((
          [name, property],
        ) => [
          name,
          equivalentSchema(property, !required.includes(name)),
        ]),
      )
      : equivalentSchema(value);
  }
  if (!Array.isArray(result.anyOf)) return result;
  const branches = (result.anyOf as unknown[]).filter((branch) =>
    !(optional && JSON.stringify(branch) === '{"type":"undefined"}')
  ).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const { anyOf: _, ...rest } = result;
  const [sole] = branches;
  return branches.length === 1 && typeof sole === "object" && sole !== null &&
      Object.entries(sole).every(([key, value]) =>
        !(key in rest) || JSON.stringify(rest[key]) === JSON.stringify(value)
      )
    ? { ...rest, ...sole }
    : { ...rest, anyOf: branches };
};

describe("scope-wrapper-alias-schema", () => {
  for (const form of ["local", "exported", "imported"]) {
    it(`keeps the scope of a ${form} alias of a scope wrapper`, async () => {
      const prefix = form === "local" ? "" : "export ";
      const declarations = `import type { PerUser } from "commonfabric";
${prefix}type Inner = { a: string };
${prefix}type Rec = PerUser<Inner>;
`;
      const consumer =
        `import { computed, handler, pattern, Writable } from "commonfabric";
const cancel = handler<void, { run: Writable<Rec> }>((_, { run }) => {
  run.set({ a: "" });
});
export default pattern<{ run: Writable<Rec> }>(({ run }) => ({
  x: computed(() => run.get().a),
  cancel: cancel({ run }),
}));`;
      const files: Record<string, string> = form === "imported"
        ? {
          "/records.ts": declarations,
          "/main.tsx": 'import type { Rec } from "./records.ts";\n' + consumer,
        }
        : { "/main.tsx": declarations + consumer };
      const output = await transformFiles(files, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      });
      const module = parseModule(output["/main.tsx"]!);
      const scopedCell = {
        $ref: "#/$defs/Inner",
        scope: "user",
        asCell: ["cell"],
      };

      const { input } = patternSchemas(module);
      expect(input.properties).toEqual({ run: scopedCell });
      expect(Object.keys(input.$defs as object)).toEqual(["Inner"]);

      const [, state] = callSchemas(module, "handler");
      // The handler only writes, so its capability narrows to `writeonly`.
      expect((state as { properties: unknown }).properties).toEqual({
        run: { ...scopedCell, asCell: ["writeonly"] },
      });

      const [liftInput] = callSchemas(module, "lift");
      expect(
        (liftInput as { properties: { run: Record<string, unknown> } })
          .properties.run,
      ).toMatchObject({ $ref: "#/$defs/Inner", scope: "user" });
    });
  }

  describe("a scope wrapper read by its type", () => {
    // Where no written reference names the wrapper, its type does: by the
    // wrapper's alias, where the checker keeps one, and otherwise by the brand
    // it leaves on the type.

    it("keeps the scope at the root and on each reference of a recursive wrapper's schema", async () => {
      const [schema] = emittedSchemas(
        await transformed(
          `import { toSchema, type Cell, type PerUser } from "commonfabric";
type Rec = PerUser<{ value: string; next?: Cell<Rec> }>;
export const schema = toSchema<Rec>();`,
        ),
      );
      const [name] = Object.keys(schema!.$defs as object);
      const reference = { $ref: `#/$defs/${name}`, scope: "user" };

      const value = {
        type: "object",
        properties: {
          value: { type: "string" },
          next: { ...reference, asCell: ["cell"] },
        },
        required: ["value"],
      };

      expect(schema).toEqual({
        ...value,
        scope: "user",
        $defs: { [name!]: value },
      });
    });

    it("keeps the policy a scoped alias's declaration spells where a holder's values are read by type", async () => {
      // Only the declaration spells the policy, bound by `typeof`; the alias
      // the values' type keeps is what reaches it.
      const output = await transformFiles({
        "/rules.ts":
          `import { exchangeRule, exchangeRules, THIS_POLICY } from "commonfabric/cfc";
export const rules = exchangeRules([exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: ["never"] },
  post: { dropClause: true },
})]);`,
        "/main.tsx":
          `import { computed, pattern, type Confidential, type PerUser } from "commonfabric";
import { type PolicyOf } from "commonfabric/cfc";
import { rules } from "./rules.ts";
interface Secret { a: string }
interface Dict<U> { [key: string]: U }
type Box<T> = PerUser<Confidential<T, [PolicyOf<typeof rules>]>>;
type Outer<T> = { inner: Dict<Box<T>> };
export default pattern<{ a: Outer<Secret> }>(({ a }) => ({
  out: computed(() => a.inner),
}));`,
      }, { types: COMMONFABRIC_TYPES, typeCheck: true });
      const module = parseModule(output["/main.tsx"]!);
      const valuesOf = (schema: Record<string, unknown>) =>
        // deno-lint-ignore no-explicit-any
        (schema.properties as any).a.properties.inner.additionalProperties;

      for (
        const schema of [
          patternSchemas(module).input,
          callSchemas(module, "lift")[0]!,
        ]
      ) {
        expect(valuesOf(schema)).toMatchObject({
          $ref: "#/$defs/Secret",
          scope: "user",
          ifc: {
            confidentiality: [{
              policyRefKind: "module",
              __ctPolicyIdentityOf: { file: "/rules.ts", path: ["rules"] },
            }],
          },
        });
      }
    });

    it("reads a wrapper around an intersection as the intersection in its scope", async () => {
      const { output } = patternSchemas(
        await transformed(
          `import { computed, pattern, type PerUser } from "commonfabric";
interface A { a: string }
interface B { b: number }
export default pattern(() => {
  const result = computed((): PerUser<A & B> => ({ a: "x", b: 1 }));
  return { result };
});`,
        ),
      );

      expect((output.properties as Record<string, unknown>).result).toEqual({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a", "b"],
        scope: "user",
      });
    });

    it("reads a wrapper around a labeled value with its labels in its scope", async () => {
      // `Confidential<Secret, …>` is itself an intersection, which the checker
      // cannot intersect again without the brand.
      const { output } = patternSchemas(
        await transformed(
          `import { computed, pattern, type Confidential, type PerUser } from "commonfabric";
interface Secret { a: string }
export default pattern(() => {
  const secret = computed(
    (): PerUser<Confidential<Secret, readonly ["owner"]>> => ({ a: "x" }),
  );
  return { secret };
});`,
        ),
      );

      expect((output.properties as Record<string, unknown>).secret).toEqual({
        $ref: "#/$defs/Secret",
        ifc: { confidentiality: ["owner"] },
        scope: "user",
      });
    });

    for (
      const [payload, labels] of [
        ["T", {}],
        [
          'Confidential<T, readonly ["owner"]>',
          { ifc: { confidentiality: ["owner"] } },
        ],
      ] as const
    ) {
      it(`reads a generic wrapper around \`${payload}\` by its arguments`, async () => {
        // While the payload holds a type parameter, the brand is a deferred
        // type, so the wrapper's alias is what names it.
        const { input } = patternSchemas(
          await transformed(
            `import { computed, pattern, type Confidential, type PerUser } from "commonfabric";
interface Secret { a: string }
function make<T extends { a: string }>() {
  return pattern<{ secret: PerUser<${payload}> }>(({ secret }) => ({
    out: computed(() => secret.a),
  }));
}
export default make<Secret>();`,
          ),
        );

        expect((input.properties as Record<string, unknown>).secret).toEqual({
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          ...labels,
          scope: "user",
        });
      });
    }

    describe("a generic wrapper beside `null` or `undefined`", () => {
      // Written as a union member, the generic wrapper is read by its alias.

      const schemasOf = async (declared: string) => {
        const module = await transformed(
          `import { computed, pattern, type PerUser } from "commonfabric";
interface Secret { a: string }
function make<T extends { a: string }>() {
  return pattern<{ secret: ${declared} }>(({ secret }) => ({
    out: computed(() => secret?.a),
  }));
}
export default make<Secret>();`,
        );
        return {
          input: patternSchemas(module).input,
          capture: callSchemas(module, "lift")[0]!,
        };
      };

      it("reads `PerUser<T> | null` as `PerUser<T | null>`", async () => {
        const outside = await schemasOf("PerUser<T> | null");

        expect(outside).toEqual(await schemasOf("PerUser<T | null>"));
        expect((outside.input.properties as Record<string, unknown>).secret)
          .toMatchObject({ scope: "user" });
      });

      it("reads `PerUser<T> | undefined` as `PerUser<T | undefined>`, each capture an optional property in the scope", async () => {
        // Each capture's property is optional, which admits `undefined`
        // whether or not its schema lists it.
        const outside = await schemasOf("PerUser<T> | undefined");
        const inside = await schemasOf("PerUser<T | undefined>");

        expect(outside.input).toEqual(inside.input);
        for (const { capture } of [outside, inside]) {
          expect(capture.required ?? []).not.toContain("secret");
          expect((capture.properties as Record<string, unknown>).secret)
            .toMatchObject({ scope: "user" });
        }
      });
    });

    it("keeps the scope of a capture of a generic wrapper read through a generic interface's property", async () => {
      // A property of a generic interface, read through its expression, is
      // `PerUser<T>` to the checker, with no written reference to it.
      const module = await transformed(
        `import { computed, pattern, type PerUser } from "commonfabric";
interface Secret { a: string }
interface Holder<T extends { a: string }> { secret: PerUser<T> }
function make<T extends { a: string }>() {
  return pattern<{ holder: Holder<T> }>(({ holder }) => ({
    out: computed(() => holder.secret),
  }));
}
export default make<Secret>();`,
      );
      const [input] = callSchemas(module, "lift");
      const captures = callsNamed(module, "lift").at(-1)!.typeArguments![0]!;

      expect(captures.getText(module).replace(/\s+/g, " ")).toBe(
        "{ holder: { secret: __cfHelpers.PerUser<T>; }; }",
      );
      expect((input!.properties as Record<string, unknown>).holder).toEqual({
        type: "object",
        properties: {
          secret: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
            scope: "user",
          },
        },
        required: ["secret"],
      });
    });

    it("reads a wrapper around a labeled intersection with its labels in its scope", async () => {
      // Neither `A & B` nor the labels on it can be told apart from the brand
      // as one member, so the structure and the labels are read separately.
      const { output } = patternSchemas(
        await transformed(
          `import { computed, pattern, type Confidential, type PerUser } from "commonfabric";
interface A { a: string }
interface B { b: number }
export default pattern(() => {
  const result = computed(
    (): PerUser<Confidential<A & B, readonly ["owner"]>> => ({ a: "x", b: 1 }),
  );
  return { result };
});`,
        ),
      );

      expect((output.properties as Record<string, unknown>).result).toEqual({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a", "b"],
        ifc: { confidentiality: ["owner"] },
        scope: "user",
      });
    });

    it("keeps the scope, the cap, the labels, and `null` of a labelled nullable scoped cell's capture", async () => {
      // The cell's alternative holds its CFC carrier beside it.
      const module = await transformed(
        `import { computed, pattern, Writable, type Confidential, type PerSpace } from "commonfabric";
interface A { a: string; b: number }
type Maybe = PerSpace<Confidential<Writable<A>, readonly ["owner"]>> | null;
export default pattern<{ enabled: boolean }>(({ enabled }) => {
  const handle: Maybe = enabled ? Writable.perSpace.of<A>({ a: "x", b: 1 }) : null;
  return { out: computed(() => handle?.get().a) };
});`,
      );
      const captures = callsNamed(module, "lift").at(-1)!.typeArguments![0]!;
      const [input] = callSchemas(module, "lift");

      expect(captures.getText(module).replace(/\s+/g, " ")).toBe(
        "{ handle: __cfHelpers.PerSpace<__cfHelpers.ReadonlyCell<A> | null>; }",
      );
      expect((input!.properties as Record<string, unknown>).handle).toEqual({
        anyOf: [
          {
            $ref: "#/$defs/A",
            asCell: [{ kind: "readonly", scope: "space" }],
          },
          { type: "null" },
        ],
        scope: "space",
        ifc: { confidentiality: ["owner"] },
      });
    });

    it("keeps the cell, the scope, the cap, and the labels of a labelled scoped cell intersected with another type in its capture", async () => {
      // `Cell<A> & Extra` is the cell, as schema generation reads it.
      const module = await transformed(
        `import { computed, pattern, type Cell, type Confidential, type PerSpace } from "commonfabric";
interface A { a: string }
declare const EXTRA: unique symbol;
type Extra = { readonly [EXTRA]: true };
type Handle = PerSpace<Confidential<Cell<A> & Extra, readonly ["owner"]>>;
export default pattern<{ handle: Handle }>(({ handle }) => ({
  handle,
  out: computed(() => handle.get().a),
}));`,
      );
      const captures = callsNamed(module, "lift").at(-1)!.typeArguments![0]!;
      const [input] = callSchemas(module, "lift");

      expect(captures.getText(module).replace(/\s+/g, " ")).toBe(
        "{ handle: __cfHelpers.PerSpace<__cfHelpers.ReadonlyCell<A>>; }",
      );
      expect((input!.properties as Record<string, unknown>).handle).toEqual({
        $ref: "#/$defs/A",
        asCell: [{ kind: "readonly", scope: "space" }],
        ifc: { confidentiality: ["owner"] },
      });
    });

    it("keeps the cell, the scope, the cap, and the labels of a labelled scoped payload of two cells in its capture", async () => {
      // Narrowing cannot take the scoped cell apart, so the capture keeps the
      // type it was declared with, whose payload member is labelled and holds
      // several members.
      const module = await transformed(
        `import { computed, pattern, type Cell, type Confidential, type PerSpace } from "commonfabric";
interface A { a: string }
interface B { b: number }
type Handle = PerSpace<Confidential<Cell<A> & Cell<B>, readonly ["owner"]>>;
export default pattern<{ handle: Handle }>(({ handle }) => ({
  handle,
  out: computed(() => handle.get().a),
}));`,
      );
      const [input] = callSchemas(module, "lift");

      expect((input!.properties as Record<string, unknown>).handle).toEqual({
        $ref: "#/$defs/A",
        asCell: [{ kind: "cell", scope: "space" }],
        ifc: { confidentiality: ["owner"] },
      });
    });

    it("reads a nullable labelled intersection in a scope alike written outside the wrapper and inside", async () => {
      const schemaOf = async (argument: string) =>
        emittedSchemas(
          await transformed(
            `import { toSchema, type Confidential, type PerUser } from "commonfabric";
interface A { a: string }
interface B { b: number }
type Maybe = ${argument};
export const schema = toSchema<Maybe>();`,
          ),
        )[0];

      const outside = await schemaOf(
        'PerUser<Confidential<A & B, readonly ["owner"]>> | null',
      );

      expect(
        await schemaOf(
          'PerUser<Confidential<A & B, readonly ["owner"]> | null>',
        ),
      ).toEqual(outside);
      expect(outside).toEqual({
        anyOf: [
          {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "number" } },
            required: ["a", "b"],
            ifc: { confidentiality: ["owner"] },
          },
          { type: "null" },
        ],
        scope: "user",
      });
    });

    it("reads a nullable wrapper around an intersection alike through an alias and written out", async () => {
      const schemaOf = async (declarations: string, argument: string) =>
        emittedSchemas(
          await transformed(
            `import { toSchema, type PerUser } from "commonfabric";
interface A { a: string }
interface B { b: number }
${declarations}
export const schema = toSchema<${argument}>();`,
          ),
        )[0];

      const written = await schemaOf("", "PerUser<A & B> | undefined");

      expect(
        await schemaOf("type Maybe = PerUser<A & B> | undefined;", "Maybe"),
      )
        .toEqual(written);
      expect(written).toEqual({
        anyOf: [
          { type: "undefined" },
          {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        ],
        scope: "user",
      });
    });

    it("refuses a wrapper nested in another of a different scope in an inferred result", async () => {
      // The checker keeps both scopes' brands on the one value, which no node
      // names as two wrappers.
      await expect(transformed(
        `import { computed, pattern, type PerSession, type PerUser } from "commonfabric";
interface A { a: string }
export default pattern(() => {
  const result = computed((): PerUser<PerSession<A>> => ({ a: "x" }));
  return { result };
});`,
      )).rejects.toThrow(
        "Nested scope wrappers require a cell boundary between scopes.",
      );
    });

    for (
      const [use, body] of [
        ["read by a computed", "({ out: computed(() => draft.get()) })"],
        ["returned unread", "({ draft })"],
      ] as const
    ) {
      it(`refuses an input cell in two scopes' wrappers ${use}`, async () => {
        // The declaration's schema and the capture's type both name the two
        // scopes, the cell's own and the one around it.
        await expect(transformed(
          `import { computed, pattern, Writable, type PerSession, type PerUser } from "commonfabric";
type Draft = PerUser<Writable<string>>;
export default pattern<{ draft: PerSession<Draft> }>(({ draft }) => ${body});`,
        )).rejects.toThrow(
          "Nested scope wrappers require a cell boundary between scopes.",
        );
      });
    }

    for (const nullish of ["null", "undefined"]) {
      it(`declares a scoped cell's scope for the slot and as its handle's cap beside \`${nullish}\``, async () => {
        const [schema] = emittedSchemas(
          await transformed(
            `import { toSchema, type Cell, type PerSpace } from "commonfabric";
export const schema = toSchema<{
  handle: PerSpace<Cell<{ field: string }>> | ${nullish};
}>();`,
          ),
        );

        expect((schema!.properties as Record<string, unknown>).handle).toEqual({
          anyOf: [
            { type: nullish },
            {
              type: "object",
              properties: { field: { type: "string" } },
              required: ["field"],
              asCell: [{ kind: "cell", scope: "space" }],
            },
          ],
          scope: "space",
        });
      });

      for (
        const [spelling, declared] of [
          ["outside", `PerSession<Writable<boolean>> | ${nullish}`],
          ["inside", `PerSession<Writable<boolean> | ${nullish}>`],
        ] as const
      ) {
        it(`keeps the scope, the cap, and \`${nullish}\` of a nullable scoped cell's capture, \`${nullish}\` written ${spelling} the wrapper`, async () => {
          const module = await transformed(
            `import { computed, pattern, UI, Writable, type PerSession } from "commonfabric";
export default pattern<{ enabled: boolean }>(({ enabled }) => {
  const confirming: ${declared} = enabled
    ? Writable.perSession.of<boolean>(false)
    : ${nullish};
  const isConfirming = computed(() => confirming?.get());
  return { [UI]: <div>{isConfirming ? "yes" : "no"}</div> };
});`,
          );
          const capture = callsNamed(module, "lift")
            .flatMap((lift) =>
              (lift.typeArguments![0]! as ts.TypeLiteralNode).members
            )
            .find((member) =>
              member.name?.getText(module) === "confirming"
            ) as ts.PropertySignature;
          const [input] = callSchemas(module, "lift");

          expect(capture.type!.getText(module)).toBe(
            `__cfHelpers.PerSession<__cfHelpers.ReadonlyCell<boolean> | ${nullish}>`,
          );
          expect((input!.properties as Record<string, unknown>).confirming)
            .toEqual({
              anyOf: [
                {
                  type: "boolean",
                  asCell: [{ kind: "readonly", scope: "session" }],
                },
                { type: nullish },
              ],
              scope: "session",
            });
        });
      }

      it(`keeps the scope, the cap, and \`${nullish}\` of an input scoped cell holding \`${nullish}\` in its capture`, async () => {
        // The input is narrowed to the capability its capture uses, which
        // takes the cell out of the wrapper beside the \`${nullish}\`.
        const module = await transformed(
          `import { computed, pattern, type Cell, type PerSpace } from "commonfabric";
interface A { a: string }
export default pattern<{ handle: PerSpace<Cell<A> | ${nullish}> }>(({ handle }) => ({
  out: computed(() => handle?.get().a),
}));`,
        );
        const [input] = callSchemas(module, "lift");

        expect((input!.properties as Record<string, unknown>).handle).toEqual({
          anyOf: [
            {
              $ref: "#/$defs/A",
              asCell: [{ kind: "readonly", scope: "space" }],
            },
            { type: nullish },
          ],
          scope: "space",
        });
      });

      it(`keeps the scope, the cap, the labels, and \`${nullish}\` of a nullable scoped cell intersected with another type's capture`, async () => {
        const module = await transformed(
          `import { computed, pattern, type Cell, type Confidential, type PerSpace } from "commonfabric";
interface A { a: string }
declare const EXTRA: unique symbol;
type Extra = { readonly [EXTRA]: true };
type Handle = PerSpace<Confidential<Cell<A> & Extra, readonly ["owner"]>> | ${nullish};
export default pattern<{ handle: Handle }>(({ handle }) => ({
  handle,
  out: computed(() => handle?.get().a),
}));`,
        );
        const capture = callsNamed(module, "lift")
          .flatMap((lift) =>
            (lift.typeArguments![0]! as ts.TypeLiteralNode).members
          )
          .find((member) =>
            member.name?.getText(module) === "handle"
          ) as ts.PropertySignature;
        const [input] = callSchemas(module, "lift");

        expect(capture.type!.getText(module)).toBe(
          `__cfHelpers.PerSpace<__cfHelpers.ReadonlyCell<A> | ${nullish}>`,
        );
        expect((input!.properties as Record<string, unknown>).handle).toEqual({
          anyOf: [
            {
              $ref: "#/$defs/A",
              asCell: [{ kind: "readonly", scope: "space" }],
            },
            { type: nullish },
          ],
          scope: "space",
          ifc: { confidentiality: ["owner"] },
        });
      });
    }

    it("keeps the scope and the cap of a nullable scoped capture of two cells' intersection", async () => {
      // Narrowing reads the intersection as its first cell, as schema
      // generation reads it.
      const module = await transformed(
        `import { computed, pattern, type Cell, type PerSpace } from "commonfabric";
interface A { a: string }
interface B { b: number }
type Handle = PerSpace<Cell<A> & Cell<B>> | null;
export default pattern<{ handle: Handle }>(({ handle }) => ({
  handle,
  out: computed(() => handle?.get().a),
}));`,
      );
      const [input] = callSchemas(module, "lift");

      expect((input!.properties as Record<string, unknown>).handle).toEqual({
        anyOf: [
          { $ref: "#/$defs/A", asCell: [{ kind: "readonly", scope: "space" }] },
          { type: "null" },
        ],
        scope: "space",
      });
    });

    for (
      const [shape, declaration, read] of [
        [
          "a cell around a recursive scoped value",
          "type Tree = PerUser<{ label: string; kids: Tree[] }>;\ntype Input = { handle: PerSession<Writable<Tree>> };",
          "handle.get().label",
        ],
        [
          "a recursive scoped cell",
          "type Tree = PerUser<Writable<{ label: string; next?: Tree }>>;\ntype Input = { handle: Tree };",
          "handle.get().label",
        ],
      ] as const
    ) {
      it(`keeps every scope of the capture of ${shape}`, async () => {
        // Each member of a scope wrapper is printed afresh, and the print of a
        // recursive one holds the wrapper again.
        const module = await transformed(
          `import { computed, pattern, Writable, type PerSession, type PerUser } from "commonfabric";
${declaration}
export default pattern<Input>(({ handle }) => ({
  out: computed(() => ${read}),
}));`,
        );
        const [input] = callSchemas(module, "lift");
        const [name] = Object.keys(input!.$defs as object);
        const reference = `#/$defs/${name}`;

        expect(input).toEqual(
          shape === "a recursive scoped cell"
            ? {
              type: "object",
              properties: {
                handle: {
                  $ref: reference,
                  asCell: [{ kind: "readonly", scope: "user" }],
                },
              },
              required: ["handle"],
              $defs: {
                [name!]: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    next: {
                      $ref: reference,
                      asCell: [{ kind: "cell", scope: "user" }],
                    },
                  },
                  required: ["label"],
                },
              },
            }
            : {
              type: "object",
              properties: {
                handle: {
                  $ref: reference,
                  scope: "user",
                  asCell: [{ kind: "readonly", scope: "session" }],
                },
              },
              required: ["handle"],
              $defs: {
                [name!]: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    kids: {
                      type: "array",
                      items: { $ref: reference, scope: "user" },
                    },
                  },
                  required: ["label", "kids"],
                },
              },
            },
        );
      });
    }
    for (const nullish of ["null", "undefined"]) {
      for (
        const [shape, payload, read] of [
          ["a primitive", "string", "x"],
          ["an interface", "A", "x"],
          ["a labelled value", 'Confidential<A, readonly ["owner"]>', "x"],
          [
            "a labelled intersection",
            'Confidential<A & B, readonly ["owner"]>',
            "x",
          ],
          ["a value with a default", 'Default<string, "d">', "x"],
          ["a cell", "Writable<A>", "x?.get()"],
          [
            "a labelled cell",
            'Confidential<Writable<A>, readonly ["owner"]>',
            "x?.get()",
          ],
        ] as const
      ) {
        it(`reads \`PerUser<T> | ${nullish}\` as \`PerUser<T | ${nullish}>\` for ${shape}`, async () => {
          // A union read from its type alone, as a capture is and the payload
          // of `PerUser<T> | null` is, orders an `anyOf` by its members' types
          // rather than as written, and an optional property admits
          // `undefined` whether or not its schema lists it, so the schemas are
          // compared up to both (`equivalentSchema()`).
          const schemasOf = async (declared: string) => {
            const module = await transformed(
              `import { computed, pattern, toSchema, Writable, type Confidential, type Default, type PerUser } from "commonfabric";
interface A { a: string }
interface B { b: number }
type X = ${declared};
export const aliased = toSchema<X>();
export const written = toSchema<{ x: ${declared} }>();
export default pattern<{ x: X }>(({ x }) => ({ out: computed(() => ${read}) }));`,
            );
            return equivalentSchema({
              schemas: emittedSchemas(module),
              input: patternSchemas(module).input,
              capture: callSchemas(module, "lift")[0],
            });
          };

          expect(await schemasOf(`PerUser<${payload}> | ${nullish}`)).toEqual(
            await schemasOf(`PerUser<${payload} | ${nullish}>`),
          );
        });
      }

      it(`scopes a wrapper around \`${nullish}\` alone, and no other \`${nullish}\` beside it`, async () => {
        // The checker reduces the wrapper to the type it wraps.
        const [schema, alone] = emittedSchemas(
          await transformed(
            `import { toSchema, type PerUser } from "commonfabric";
export const schema = toSchema<{
  scoped: PerUser<${nullish}>;
  other: string | ${nullish};
}>();
export const alone = toSchema<{ other: string | ${nullish} }>();`,
          ),
        );

        expect(schema!.properties).toEqual({
          scoped: { type: nullish, scope: "user" },
          other: (alone!.properties as Record<string, unknown>).other,
        });
      });
    }
  });
});
