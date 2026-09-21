import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { getAuthoredCellTypeNode } from "../../src/ast/type-building.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
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
  const files = new Map<string, ts.SourceFile>([
    [fileName, sourceFile],
    ...Object.entries(COMMONFABRIC_TYPES).map(([name, text]) =>
      [
        `/${name}`,
        ts.createSourceFile(`/${name}`, text, options.target!, true),
      ] as const
    ),
  ]);
  host.getSourceFile = (name) => files.get(name);
  host.getCurrentDirectory = () => "/";
  host.fileExists = (name) => files.has(name);
  host.readFile = (name) => files.get(name)?.text;
  host.resolveModuleNames = (names) =>
    names.map((name) => {
      const path = name === "commonfabric" ? "/commonfabric.d.ts" : "/cfc.ts";
      return name === "commonfabric" || name === "commonfabric/cfc"
        ? { resolvedFileName: path, isExternalLibraryImport: false }
        : undefined;
    });
  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  const result = collect(sourceFile, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text === "result"
  )!.initializer!;
  return { checker, result, sourceFile };
}

describe("getAuthoredCellTypeNode()", () => {
  it("preserves the writer binding through a named cell and const aliases", () => {
    const { checker, result, sourceFile } = programFor(`
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
    const registered = registry.get(reference)!;
    const constructor = collect(sourceFile, ts.isNewExpression)[0];
    const writer = collect(sourceFile, ts.isVariableDeclaration).find((node) =>
      ts.isIdentifier(node.name) && node.name.text === "writer"
    )!;
    expect(registered).toBe(checker.getTypeAtLocation(constructor));
    expect(registered.flags & ts.TypeFlags.Any).toBe(0);
    expect(registered.getSymbol()?.name).toBe("Cell");
    expect(registered.getSymbol()?.declarations?.[0].getSourceFile().fileName)
      .toBe("/commonfabric.d.ts");
    const typeArguments = checker.getTypeArguments(
      registered as ts.TypeReference,
    );
    expect(typeArguments).toHaveLength(1);
    expect(typeArguments[0]).toBe(checker.getTypeAtLocation(writer.name));
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
