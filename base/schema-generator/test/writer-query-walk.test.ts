/**
 * Holds the walk that looks for a policy writer's `typeof` query beneath a
 * default-library alias to two things: what it finds, and how much of the
 * checker it asks for. The second is counted as calls on the checker, which
 * a run reports the same way every time, where a duration would not.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type ts from "typescript";

import { SchemaGenerator } from "../src/schema-generator.ts";
import { asObjectSchema, getTypeFromCode } from "./utils.ts";

const ALIASES = `
  type Cfc<T, Meta> = T & { readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T } };
  type WriteAuthorizedBy<T, B> = Cfc<T, { writeAuthorizedBy: B }>;
  declare const f: { readonly label: string };
`;

/** The schema of a member a policy lets `f` alone write. */
const WRITTEN_BY_F = {
  type: "string",
  ifc: {
    writeAuthorizedBy: {
      __ctWriterIdentityOf: { file: "test.ts", path: ["f"] },
    },
  },
};

/** Generates the schema of `Holder`, declared by `code` after `ALIASES`. */
async function schemaOf(code: string) {
  const { type, checker } = await getTypeFromCode(ALIASES + code, "Holder");
  return asObjectSchema(
    new SchemaGenerator().generateSchema(type, checker, undefined, {
      writerIdentityForSourceFile: (file) => ({ file }),
    }),
  );
}

/**
 * Returns the number of calls `SchemaGenerator` makes on the checker to
 * generate the schema of `Holder`, declared by `code`.
 */
async function checkerCallsFor(code: string): Promise<number> {
  const { type, checker } = await getTypeFromCode(code, "Holder");
  let calls = 0;
  const counted = new Proxy(checker, {
    get(target, key, receiver) {
      const member: unknown = Reflect.get(target, key, receiver);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        calls++;
        return Reflect.apply(member, target, args);
      };
    },
  }) satisfies ts.TypeChecker;
  new SchemaGenerator().generateSchema(type, counted);
  return calls;
}

/**
 * Returns the source of `layers` interfaces, each of whose two members refers
 * to the next, under a `Holder` that reaches the first through `Record`. The
 * last layer is reached by two to the power of `layers - 1` paths.
 */
function layeredHolder(layers: number): string {
  const declarations = Array.from({ length: layers }, (_, layer) => {
    const next = layer + 1 < layers ? `Layer${layer + 1}` : "string";
    return `interface Layer${layer} { left: ${next}; right: ${next} }`;
  });
  return [
    ...declarations,
    "interface Holder { all: Record<string, Layer0> }",
  ].join("\n");
}

describe("writer query walk", () => {
  it("calls the checker in proportion to the declarations a `Record` value reaches, not to the paths that reach them", async () => {
    // Twice the layers is twice the declarations, and the square of the paths.
    // The bound leaves room for a cost per declaration that is not constant.

    const shallow = await checkerCallsFor(layeredHolder(6));
    const deep = await checkerCallsFor(layeredHolder(12));
    expect(deep).toBeLessThan(shallow * 3);
  });

  describe("a declaration the walk reaches more than once", () => {
    // Each case reaches one node twice, and only the second reach finds the
    // writer. An alias applied to its argument's declaration is the sign the
    // writer was found: read by type instead, `Partial` adds `undefined` to
    // each member and `Readonly` yields an object with no name to refer to.

    it("applies `Partial` to a generic's members when its argument is a plain member before it is a policy's writer", async () => {
      const schema = await schemaOf(`
        interface Box<T> { plain: T; guarded: WriteAuthorizedBy<string, T> }
        interface Holder { box: Partial<Box<typeof f>> }
      `);
      expect(schema.properties?.box).toEqual({
        type: "object",
        properties: {
          plain: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
          guarded: WRITTEN_BY_F,
        },
      });
    });

    it("refers to the declaration `Readonly` is applied to when a generic holds the writer and is referenced first with an unbound argument", async () => {
      const schema = await schemaOf(`
        interface Box<T> { guarded: WriteAuthorizedBy<string, T> }
        interface Top { make<K>(key: K): Box<K>; box: Box<typeof f> }
        interface Holder { top: Readonly<Top> }
      `);
      expect(schema.properties?.top).toEqual({ $ref: "#/$defs/Top" });
      expect(schema.$defs?.Top).toEqual({
        type: "object",
        properties: {
          box: {
            type: "object",
            properties: { guarded: WRITTEN_BY_F },
            required: ["guarded"],
          },
        },
        required: ["box"],
      });
    });

    it("refers to the declaration `Readonly` is applied to when the writer is first reached from inside the generic that holds it", async () => {
      // `Inner` is reached first from inside `Box`, where its own reference
      // to `Box` is not followed, and then from `Top`, where it is.

      const schema = await schemaOf(`
        interface Box<T> { guarded: WriteAuthorizedBy<string, T>; inner?: Inner }
        interface Inner { again: Box<typeof f> }
        interface Top { make<K>(key: K): Box<K>; inner: Inner }
        interface Holder { top: Readonly<Top> }
      `);
      expect(schema.properties?.top).toEqual({ $ref: "#/$defs/Top" });
      expect(schema.$defs?.Top).toEqual({
        type: "object",
        properties: { inner: { $ref: "#/$defs/Inner" } },
        required: ["inner"],
      });
      expect(schema.$defs?.Inner).toEqual({
        type: "object",
        properties: {
          again: {
            type: "object",
            properties: {
              guarded: WRITTEN_BY_F,
              inner: { $ref: "#/$defs/Inner" },
            },
            required: ["guarded"],
          },
        },
        required: ["again"],
      });
    });
  });
});
