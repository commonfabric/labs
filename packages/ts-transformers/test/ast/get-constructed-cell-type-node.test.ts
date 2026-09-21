import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import {
  getConstructedCellTypeNode,
  namesValueBinding,
} from "../../src/ast/type-building.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { collect } from "../transformed-ast.ts";

function programFor(source: string, declarations: Record<string, string> = {}) {
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
    ...Object.entries({ ...COMMONFABRIC_TYPES, ...declarations }).map((
      [name, text],
    ) =>
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
      const path = name === "commonfabric"
        ? "/commonfabric.d.ts"
        : name === "commonfabric/cfc"
        ? "/cfc.ts"
        : `/${name.replace(/^\.\//, "")}.d.ts`;
      return files.has(path)
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

describe("getConstructedCellTypeNode()", () => {
  it("preserves the writer binding through a named cell and const aliases", () => {
    const { checker, result, sourceFile } = programFor(`
      import { Writable } from "commonfabric";
      const writer = () => {};
      const name = new Writable<typeof writer>(writer).for("name");
      const alias = name;
      const result = alias;
    `);
    const registry = new WeakMap<ts.Node, ts.Type>();
    const type = getConstructedCellTypeNode(result, checker, registry);
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
    expect(getConstructedCellTypeNode(result, checker)).toBeUndefined();
  });

  it("does not treat a foreign constructor with a writer type as a fabric cell", () => {
    const { checker, result } = programFor(`
      class Writable<T> { constructor(value: T) {} }
      const writer = () => {};
      const result = new Writable<typeof writer>(writer);
    `);
    expect(getConstructedCellTypeNode(result, checker)).toBeUndefined();
  });

  it("leaves mutable and explicitly typed bindings to normal type inference", () => {
    for (const binding of ["let name", "const name: unknown"]) {
      const { checker, result } = programFor(`
        import { Writable } from "commonfabric";
        const writer = () => {};
        ${binding} = new Writable<typeof writer>(writer);
        const result = name;
      `);
      expect(getConstructedCellTypeNode(result, checker)).toBeUndefined();
    }
  });
});

describe("namesValueBinding()", () => {
  function constructorArgument(
    source: string,
    declarations?: Record<string, string>,
  ) {
    const { checker, sourceFile } = programFor(source, declarations);
    const argument = collect(sourceFile, ts.isNewExpression)[0]
      .typeArguments![0];
    return { argument, checker };
  }
  const names = (source: string, declarations?: Record<string, string>) => {
    const { argument, checker } = constructorArgument(source, declarations);
    return namesValueBinding(argument, checker);
  };
  const prelude = `
    import { Writable } from "commonfabric";
    const writer = () => {};
  `;

  it("finds a binding written in place, under parentheses and type arguments", () => {
    expect(names(`${prelude}
      type Box<T> = { value: T };
      const result = new Writable<(Box<typeof writer>)>({ value: writer });
    `)).toBe(true);
  });

  it("finds a binding that a plain alias, or a chain of them, stands for", () => {
    expect(names(`${prelude}
      type Binding = typeof writer;
      type Named = Binding;
      const result = new Writable<Named>(writer);
    `)).toBe(true);
  });

  it("finds a binding written in a generic alias's body", () => {
    expect(names(`${prelude}
      type Held<T> = { value: T; by: typeof writer };
      const result = new Writable<Held<string>>({ value: "", by: writer });
    `)).toBe(true);
  });

  it("finds a binding written in an interface member", () => {
    expect(names(`${prelude}
      interface Held { by: typeof writer }
      const result = new Writable<Held>({ by: writer });
    `)).toBe(true);
  });

  it("answers no for a shape that names no binding, through aliases too", () => {
    expect(names(`${prelude}
      type Text = { text: string };
      type Named = Text;
      const result = new Writable<Named>({ text: "" });
    `)).toBe(false);
  });

  it("terminates on an alias that refers to itself", () => {
    expect(names(`${prelude}
      type Tree = { children: Tree[] };
      const result = new Writable<Tree>({ children: [] });
    `)).toBe(false);
  });

  it("does not follow a declaration file's own typeof", () => {
    // A library spells a brand key with `typeof`. It names no writer, and the
    // same alias written in the authored module is followed.
    const branded = "{ readonly brand: typeof BRAND; text: string }";
    expect(names(
      `${prelude}
      import type { Branded } from "./brand";
      const result = new Writable<Branded>(undefined as never);
    `,
      {
        "brand.d.ts":
          `export declare const BRAND: unique symbol;\nexport type Branded = ${branded};`,
      },
    )).toBe(false);
    expect(names(`${prelude}
      declare const BRAND: unique symbol;
      type Branded = ${branded};
      const result = new Writable<Branded>(undefined as never);
    `)).toBe(true);
  });
});
