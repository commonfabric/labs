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

  describe("a scope wrapper read as the conditional `Scoped` it is", () => {
    // The type `Scoped` resolves to carries its brand and no alias. One whose
    // payload holds a type parameter is deferred, with `Scoped` for its alias.

    it("keeps the scope on the root reference of a recursive wrapper's schema", async () => {
      const [schema] = emittedSchemas(
        await transformed(
          `import { toSchema, type Cell, type PerUser } from "commonfabric";
type Rec = PerUser<{ value: string; next?: Cell<Rec> }>;
export const schema = toSchema<Rec>();`,
        ),
      );
      const [name] = Object.keys(schema!.$defs as object);
      const reference = { $ref: `#/$defs/${name}`, scope: "user" };

      expect(schema).toEqual({
        ...reference,
        $defs: {
          [name!]: {
            type: "object",
            properties: {
              value: { type: "string" },
              next: { ...reference, asCell: ["cell"] },
            },
            required: ["value"],
          },
        },
      });
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
      it(`reads a wrapper the checker defers around \`${payload}\` by its arguments`, async () => {
        // Where the payload holds a type parameter, the checker defers the
        // conditional `Scoped`, which is then a type of its own.
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

    it("keeps the scope of a capture whose type is a wrapper the checker defers with `Scoped` for its alias", async () => {
      // A property of a generic interface, read through its expression, is
      // `Scoped<T, "user">` to the checker, which no wrapper's name names.
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

    for (const nullish of ["null", "undefined"]) {
      it(`refuses a scoped cell beside \`${nullish}\`, whose scope would not cap its handle`, async () => {
        await expect(transformed(
          `import { toSchema, type Cell, type PerSpace } from "commonfabric";
export const schema = toSchema<{
  handle: PerSpace<Cell<{ field: string }>> | ${nullish};
}>();`,
        )).rejects.toThrow(
          "A scope wrapper around a cell cannot hold another alternative",
        );
      });
    }
  });
});
