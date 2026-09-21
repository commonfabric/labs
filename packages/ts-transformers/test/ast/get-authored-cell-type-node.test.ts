import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { getAuthoredCellTypeNode } from "../../src/ast/type-building.ts";
import { collect } from "../transformed-ast.ts";

function programFor(source: string) {
  const fileName = "/test.ts";
  const options: ts.CompilerOptions = {
    noLib: true,
    strict: true,
    target: ts.ScriptTarget.ES2020,
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    options.target!,
    true,
  );
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  const result = collect(sourceFile, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text === "result"
  )!.initializer!;
  return { checker, result };
}

describe("getAuthoredCellTypeNode()", () => {
  it("preserves the writer binding through a named cell and const aliases", () => {
    const { checker, result } = programFor(`
      import { Writable } from "commonfabric";
      const writer = () => {};
      const name = new Writable<typeof writer>(writer).for("name");
      const alias = name;
      const result = alias;
    `);
    const registry = new WeakMap<ts.Node, ts.Type>();
    const type = getAuthoredCellTypeNode(result, checker, registry);
    expect(type && ts.isTypeReferenceNode(type)).toBe(true);
    const reference = type as ts.TypeReferenceNode;
    expect(ts.isQualifiedName(reference.typeName)).toBe(true);
    const qualified = reference.typeName as ts.QualifiedName;
    expect((qualified.left as ts.Identifier).text).toBe("__cfHelpers");
    expect(qualified.right.text).toBe("Writable");
    expect(reference.typeArguments).toHaveLength(1);
    const query = reference.typeArguments![0] as ts.TypeQueryNode;
    expect(ts.isTypeQueryNode(query)).toBe(true);
    expect((query.exprName as ts.Identifier).text).toBe("writer");
    expect(registry.has(reference)).toBe(true);
  });

  it("terminates on circular const aliases without inventing a cell type", () => {
    const { checker, result } = programFor(`
      const first = second;
      const second = first;
      const result = first;
    `);
    expect(getAuthoredCellTypeNode(result, checker)).toBeUndefined();
  });

  it("does not treat a foreign constructor with a writer type as a fabric cell", () => {
    const { checker, result } = programFor(`
      class Writable<T> { constructor(value: T) {} }
      const writer = () => {};
      const result = new Writable<typeof writer>(writer);
    `);
    expect(getAuthoredCellTypeNode(result, checker)).toBeUndefined();
  });

  it("leaves mutable and explicitly typed bindings to normal type inference", () => {
    for (const binding of ["let name", "const name: unknown"]) {
      const { checker, result } = programFor(`
        import { Writable } from "commonfabric";
        const writer = () => {};
        ${binding} = new Writable<typeof writer>(writer);
        const result = name;
      `);
      expect(getAuthoredCellTypeNode(result, checker)).toBeUndefined();
    }
  });
});
