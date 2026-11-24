import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { expansionDepth } from "../../src/typescript/expanding-recursion.ts";
import { createTestProgram } from "../utils.ts";

/**
 * The types of the type aliases `names` declares in `code`, each read from
 * its alias in turn, so that each is created after the ones before it.
 */
async function aliasTypes(
  code: string,
  names: readonly string[],
): Promise<{ types: ts.Type[]; checker: ts.TypeChecker }> {
  const { checker, sourceFile } = await createTestProgram(code);
  const aliases = new Map<string, ts.TypeAliasDeclaration>();
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node);
  });
  const types = names.map((name) => {
    const alias = aliases.get(name);
    if (!alias) throw new Error(`Type alias ${name} not found`);
    return checker.getTypeFromTypeNode(alias.type);
  });
  return { types, checker };
}

describe("expanding-recursion", () => {
  describe("expansionDepth()", () => {
    it("reads a mapped type the checker has not resolved yet as a reading of the type it maps over", async () => {
      // Neither mapped type has had its members resolved when it is read, so
      // the type each maps over is not yet known to it.

      const { types: [outer, same, other], checker } = await aliasTypes(
        `
          type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
          type Nest<T> = { v: T };
          type Pair<T> = { v: T };
          type Outer = DeepReadonly<Nest<string>>;
          type Same = DeepReadonly<Nest<string[]>>;
          type Other = DeepReadonly<Pair<string[]>>;
        `,
        ["Outer", "Same", "Other"],
      );

      expect(expansionDepth(same!, [outer!], checker)).toBe(2);
      expect(expansionDepth(other!, [outer!], checker)).toBe(1);
    });

    it("reads the static side of a class apart from its instance side, which shares its symbol", async () => {
      const { types: [instance, statics], checker } = await aliasTypes(
        `
          class Counter { count = 0; }
          type Instance = Counter;
          type Static = typeof Counter;
        `,
        ["Instance", "Static"],
      );

      expect(expansionDepth(statics!, [instance!], checker)).toBe(1);
      expect(expansionDepth(statics!, [statics!], checker)).toBe(2);
    });
  });
});
