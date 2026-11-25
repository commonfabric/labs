import { expect } from "@std/expect";
import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import {
  getMemberSymbol,
  getNodeText,
  getTypeAtLocationWithFallback,
  getVariableInitializer,
  isOptionalMemberSymbol,
  setParentPointers,
} from "../../src/ast/utils.ts";
import { describe, it, test } from "@commonfabric/test-support/test";

function createProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    skipLibCheck: true,
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
    ts.ScriptKind.TS,
  );
  const host = ts.createCompilerHost(compilerOptions, true);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);

  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === fileName
      ? sourceFile
      : baseGetSourceFile(name, languageVersion, onError, shouldCreate);
  host.readFile = (name) => name === fileName ? source : baseReadFile(name);
  host.fileExists = (name) => name === fileName || baseFileExists(name);

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { sourceFile, checker: program.getTypeChecker() };
}

function findFirst<T extends ts.Node>(
  root: ts.Node,
  guard: (node: ts.Node) => node is T,
  predicate: (node: T) => boolean = () => true,
): T {
  let found: T | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && guard(node) && predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!found) throw new Error("node not found");
  return found;
}

test("getMemberSymbol resolves a property access through the base type", () => {
  const { sourceFile, checker } = createProgram(
    `interface Config { title: string }
     declare const config: Config;
     const value = config.title;`,
  );
  const access = findFirst(sourceFile, ts.isPropertyAccessExpression);
  const symbol = getMemberSymbol(access, checker);
  assert(symbol);
  assertEquals(symbol.getName(), "title");
});

test(
  "getMemberSymbol resolves a string-literal element access through the base type",
  () => {
    const { sourceFile, checker } = createProgram(
      `interface Config { title: string }
       declare const config: Config;
       const value = config["title"];`,
    );
    const access = findFirst(sourceFile, ts.isElementAccessExpression);
    const symbol = getMemberSymbol(access, checker);
    assert(symbol);
    assertEquals(symbol.getName(), "title");
  },
);

test(
  "getMemberSymbol returns undefined for an unknown element-access key",
  () => {
    const { sourceFile, checker } = createProgram(
      `interface Config { title: string }
       declare const config: Config;
       const value = config["missing"];`,
    );
    const access = findFirst(sourceFile, ts.isElementAccessExpression);
    // No such property on the base type, so no member symbol is resolved.
    assertEquals(getMemberSymbol(access, checker), undefined);
  },
);

test("isOptionalMemberSymbol reflects the optional property flag", () => {
  const { sourceFile, checker } = createProgram(
    `interface Config { maybe?: string; required: string }
     declare const config: Config;
     const a = config.maybe;
     const b = config.required;`,
  );
  const accesses: ts.PropertyAccessExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) accesses.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const maybe = accesses.find((a) => a.name.text === "maybe")!;
  const required = accesses.find((a) => a.name.text === "required")!;
  assertEquals(isOptionalMemberSymbol(maybe, checker), true);
  assertEquals(isOptionalMemberSymbol(required, checker), false);
});

test("getVariableInitializer returns the initializer of a const binding", () => {
  const { sourceFile, checker } = createProgram(
    `const seed = 41 + 1; const used = seed;`,
  );
  const usage = findFirst(
    sourceFile,
    ts.isIdentifier,
    (n) =>
      n.text === "seed" && ts.isVariableDeclaration(n.parent) &&
      n.parent.name !== n,
  );
  const initializer = getVariableInitializer(usage, checker);
  assert(initializer);
  assert(ts.isBinaryExpression(initializer));
});

test(
  "getVariableInitializer returns undefined for a non-identifier expression",
  () => {
    const { sourceFile, checker } = createProgram(`const value = 1 + 2;`);
    const binary = findFirst(sourceFile, ts.isBinaryExpression);
    assertEquals(getVariableInitializer(binary, checker), undefined);
  },
);

test(
  "getTypeAtLocationWithFallback prefers a registered synthetic type",
  () => {
    const { sourceFile, checker } = createProgram(`declare const x: unknown;`);
    const identifier = findFirst(sourceFile, ts.isIdentifier);
    const registry = new WeakMap<ts.Node, ts.Type>();
    const stringType = checker.getStringType();
    registry.set(identifier, stringType);
    const resolved = getTypeAtLocationWithFallback(
      identifier,
      checker,
      registry,
    );
    assertEquals(resolved, stringType);
  },
);

test(
  "getTypeAtLocationWithFallback falls back to a better-typed initializer for an any binding",
  () => {
    // `raw` has no annotation and an `any`-typed initializer at the checker
    // level, but the registry supplies a concrete initializer type that the
    // fallback should surface instead of the widened any.
    const { sourceFile, checker } = createProgram(
      `declare function makeAny(): any; const raw = makeAny(); const used = raw;`,
    );
    const usage = findFirst(
      sourceFile,
      ts.isIdentifier,
      (n) =>
        n.text === "raw" && ts.isVariableDeclaration(n.parent) &&
        n.parent.name !== n,
    );
    const declaration = findFirst(
      sourceFile,
      ts.isVariableDeclaration,
      (d) => ts.isIdentifier(d.name) && d.name.text === "raw",
    );
    const registry = new WeakMap<ts.Node, ts.Type>();
    registry.set(declaration.initializer!, checker.getNumberType());
    const resolved = getTypeAtLocationWithFallback(usage, checker, registry);
    assertEquals(resolved, checker.getNumberType());
  },
);

test("setParentPointers wires parent links on a synthetic subtree", () => {
  const inner = ts.factory.createIdentifier("inner");
  const call = ts.factory.createCallExpression(inner, undefined, []);
  const statement = ts.factory.createExpressionStatement(call);
  setParentPointers(statement);
  assertEquals(call.parent, statement);
  assertEquals(inner.parent, call);
});

test("getNodeText prints a synthetic node that has no source file", () => {
  const identifier = ts.factory.createIdentifier("synthetic");
  assertEquals(getNodeText(identifier), "synthetic");
});

describe("utils", () => {
  describe("getTypeAtLocationWithFallback()", () => {
    // Without `strictNullChecks`, a `let` initialized to `null` or
    // `undefined` is declared `any`, and a read inside another function sees
    // that declared type rather than a flow-narrowed one.
    function loose(source: string) {
      const fileName = "/loose.ts";
      const options: ts.CompilerOptions = {
        noLib: true,
        strictNullChecks: false,
      };
      const sourceFile = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.ESNext,
        true,
      );
      const host = ts.createCompilerHost(options);
      host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
      host.fileExists = (name) => name === fileName;
      const checker = ts.createProgram([fileName], options, host)
        .getTypeChecker();
      const returned = (functionName: string): ts.Expression =>
        findFirst(
          sourceFile,
          ts.isReturnStatement,
          (node) =>
            ts.isFunctionDeclaration(node.parent.parent) &&
            node.parent.parent.name?.text === functionName,
        ).expression!;
      return { checker, returned };
    }

    it("returns the initializer's type for an unannotated binding the checker widens to `any`", () => {
      const { checker, returned } = loose(
        "let empty = null; function read() { return empty; }",
      );
      const read = returned("read");

      expect(checker.getTypeAtLocation(read).flags & ts.TypeFlags.Any)
        .not.toBe(0);
      const type = getTypeAtLocationWithFallback(read, checker);
      expect(type && checker.typeToString(type)).toBe("null");
    });

    it("returns `any` when the initializer is itself `any` or the binding is annotated", () => {
      const { checker, returned } = loose(
        `let cast = null as any; function readCast() { return cast; }
         let declared: any = null; function readDeclared() { return declared; }`,
      );

      for (const name of ["readCast", "readDeclared"]) {
        const type = getTypeAtLocationWithFallback(returned(name), checker);
        expect(type && checker.typeToString(type)).toBe("any");
      }
    });

    it("returns `undefined` for a node the checker cannot resolve", () => {
      const { checker } = loose("let present = 1;");
      const detached = ts.createSourceFile(
        "/detached.ts",
        "let q = 1; q;",
        ts.ScriptTarget.ESNext,
        false,
      );
      const [, statement] = detached.statements;
      assert(statement && ts.isExpressionStatement(statement));

      // Parsed without parent pointers, the identifier makes the checker
      // throw while it walks upward from the node.
      expect(() => checker.getTypeAtLocation(statement.expression)).toThrow();
      expect(getTypeAtLocationWithFallback(statement.expression, checker))
        .toBeUndefined();
    });
  });
});
