import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import {
  extractDefaultValueFromBrandedMembers,
  extractValueFromLiteralType,
  resolvePropertyType,
} from "../src/type-utils.ts";
import { createTestProgram } from "./utils.ts";

/** The checker of `code`'s program and the aliases and constants it declares. */
async function programOf(code: string) {
  const { checker, sourceFile } = await createTestProgram(code);
  const alias = (name: string) => {
    const node = sourceFile.statements.find((
      statement,
    ): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name
    )!.type;
    return { node, type: checker.getTypeFromTypeNode(node) };
  };
  const print = (type: ts.Type | undefined) =>
    type && checker.typeToString(type);
  return { checker, alias, print };
}

describe("type-utils", () => {
  describe("resolvePropertyType()", () => {
    it("returns the fallback node's type for a property neither parent nor declaration types", async () => {
      // An object literal's member writes no type, and a parent without the
      // member says nothing about it; the fallback node comes before the
      // type the checker infers at the member.
      const { checker, alias, print } = await programOf(`
const literal = { count: 1 };
type Literal = typeof literal;
type Other = { name: string };
type Fallback = "fallback";
`);
      const count = alias("Literal").type.getProperty("count")!;
      const other = alias("Other").type;

      expect(
        print(
          resolvePropertyType(count, other, checker, alias("Fallback").node),
        ),
      ).toBe('"fallback"');
      expect(print(resolvePropertyType(count, other, checker))).toBe("number");
    });
  });

  describe("extractValueFromLiteralType()", () => {
    it("returns undefined for an object with a symbol-keyed member", async () => {
      // A member keyed by a unique symbol marks a brand, not data.
      const { checker, alias } = await programOf(`
declare const KEY: unique symbol;
type Branded = { readonly [KEY]: true; a: 1 };
type Plain = { a: 1; b: "x" };
`);

      expect(extractValueFromLiteralType(alias("Branded").type, checker))
        .toBeUndefined();
      expect(extractValueFromLiteralType(alias("Plain").type, checker))
        .toEqual({ value: { a: 1, b: "x" } });
    });
  });

  describe("extractDefaultValueFromBrandedMembers()", () => {
    it("returns undefined where a member carries no default marker", async () => {
      const { checker, alias } = await programOf(`
declare const DEFAULT_MARKER: unique symbol;
type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
type Note = Default<string, "n/a">;
`);
      const note = alias("Note").type;
      const members = note.isUnion() ? note.types : [];
      const branded = members.filter((member) => member.isIntersection());

      expect(branded).toHaveLength(1);
      expect(extractDefaultValueFromBrandedMembers(branded, checker))
        .toEqual({ value: "n/a" });
      expect(extractDefaultValueFromBrandedMembers(members, checker))
        .toBeUndefined();
    });
  });
});
