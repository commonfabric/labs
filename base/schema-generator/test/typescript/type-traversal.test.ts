import { expect } from "@std/expect";
import ts from "typescript";

import {
  traverseTypeHierarchy,
  type TypeTraversalOptions,
} from "../../src/typescript/type-traversal.ts";
import { createTestProgram } from "../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

const SOURCE = `
interface Marked { mark: true }
interface Gen<T> { value: T }
interface Base { base: true }
interface Derived extends Base { derived: true }
interface Probes<T extends Marked> {
  param: T;
  reference: Gen<string>;
  derived: Derived;
  union: string | Marked;
  intersection: { a: 1 } & Marked;
}
`;

/**
 * The type of each member of `Probes<T>`, by name, and the declared types of
 * the interfaces `SOURCE` declares, by name.
 */
async function program() {
  const { checker, sourceFile } = await createTestProgram(SOURCE);
  const declared = new Map<string, ts.Type>();
  const probes = new Map<string, ts.Type>();
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    const symbol = checker.getSymbolAtLocation(statement.name)!;
    declared.set(statement.name.text, checker.getDeclaredTypeOfSymbol(symbol));
    if (statement.name.text !== "Probes") continue;
    for (const member of statement.members.filter(ts.isPropertySignature)) {
      probes.set(
        member.name.getText(),
        checker.getTypeFromTypeNode(member.type!),
      );
    }
  }
  return { checker, declared, probes };
}

describe("traverseTypeHierarchy()", () => {
  /**
   * What `traverseTypeHierarchy()` returns for the probe `name` when it
   * looks for the declared type `target`, the further options being
   * `options`.
   */
  async function find(
    name: string,
    target: string,
    options: Partial<TypeTraversalOptions<string>> = {},
  ) {
    const { checker, declared, probes } = await program();
    const wanted = declared.get(target)!;
    return traverseTypeHierarchy(probes.get(name)!, {
      checker,
      checkType: (type) => type === wanted ? target : undefined,
      ...options,
    });
  }

  it("returns the match of a type parameter's apparent type where asked to visit it", async () => {
    expect(await find("param", "Marked", { visitApparentType: true })).toBe(
      "Marked",
    );
    expect(await find("param", "Marked")).toBeUndefined();
  });

  it("returns the match of a reference's target where asked to visit it", async () => {
    // The target of `Gen<string>` is the generic `Gen<T>` itself, the type
    // its declaration declares.
    expect(
      await find("reference", "Gen", { visitTypeReferenceTarget: true }),
    ).toBe("Gen");
    expect(await find("reference", "Gen")).toBeUndefined();
  });

  it("returns the match of an interface's base type where asked to visit it", async () => {
    expect(await find("derived", "Base", { visitBaseTypes: true })).toBe(
      "Base",
    );
    expect(await find("derived", "Base")).toBeUndefined();
  });

  it("returns the match of a union's or an intersection's member", async () => {
    expect(await find("union", "Marked")).toBe("Marked");
    expect(await find("intersection", "Marked")).toBe("Marked");
    expect(await find("union", "Base")).toBeUndefined();
  });
});
