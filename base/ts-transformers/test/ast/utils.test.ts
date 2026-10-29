import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import {
  getExpressionText,
  getMemberSymbol,
  getMethodCallTarget,
  getNodeText,
  getTypeAtLocationWithFallback,
  getVariableInitializer,
  isFunctionParameter,
  isMethodCall,
  isOptionalMemberSymbol,
  setParentPointers,
  visitEachChildWithJsx,
} from "../../src/ast/utils.ts";

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

function findIdentifier(
  sourceFile: ts.SourceFile,
  text: string,
  predicate: (node: ts.Identifier) => boolean = () => true,
): ts.Identifier {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found && ts.isIdentifier(node) && node.text === text && predicate(node)
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Missing identifier ${text}`);
  return found;
}

function findInitializer(
  sourceFile: ts.SourceFile,
  name: string,
): ts.Expression {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Missing initializer ${name}`);
  return found;
}

function findPropertyAccess(
  sourceFile: ts.SourceFile,
  property: string,
): ts.PropertyAccessExpression {
  let found: ts.PropertyAccessExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found && ts.isPropertyAccessExpression(node) &&
      node.name.text === property
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Missing property access ${property}`);
  return found;
}

function findElementAccess(
  sourceFile: ts.SourceFile,
  property: string,
): ts.ElementAccessExpression {
  let found: ts.ElementAccessExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === property
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Missing element access ${property}`);
  return found;
}

Deno.test("AST utils print source and synthetic nodes safely", () => {
  const { sourceFile } = createProgram("const value = source.member;");
  const access = findPropertyAccess(sourceFile, "member");
  const synthetic = ts.factory.createPropertyAccessExpression(
    ts.factory.createIdentifier("state"),
    "count",
  );

  assertEquals(getNodeText(access), "source.member");
  assertEquals(getNodeText(access), "source.member");
  assertEquals(getExpressionText(synthetic), "state.count");
});

Deno.test("AST utils prefer registered synthetic initializer types", () => {
  const { sourceFile, checker } = createProgram(`
    declare function unknownFactory(): any;
    const value = unknownFactory();
    const annotated: unknown = unknownFactory();
  `);
  const valueName = findIdentifier(
    sourceFile,
    "value",
    (node) => ts.isVariableDeclaration(node.parent),
  );
  const annotatedName = findIdentifier(
    sourceFile,
    "annotated",
    (node) => ts.isVariableDeclaration(node.parent),
  );
  const valueInitializer = findInitializer(sourceFile, "value");
  const annotatedInitializer = findInitializer(sourceFile, "annotated");
  const registry = new WeakMap<ts.Node, ts.Type>();
  registry.set(valueInitializer, checker.getStringType());
  registry.set(annotatedInitializer, checker.getNumberType());

  assertEquals(
    getTypeAtLocationWithFallback(valueName, checker, registry),
    checker.getStringType(),
  );
  assertEquals(
    checker.typeToString(
      getTypeAtLocationWithFallback(annotatedName, checker, registry)!,
    ),
    "unknown",
  );
});

Deno.test("AST utils resolve variable initializers through shorthand properties", () => {
  const { sourceFile, checker } = createProgram(`
    const source = { value: 1 };
    const wrapper = { source };
  `);
  const shorthand = findIdentifier(
    sourceFile,
    "source",
    (node) => ts.isShorthandPropertyAssignment(node.parent),
  );

  assertEquals(
    getNodeText(getVariableInitializer(shorthand, checker)!),
    "{ value: 1 }",
  );
  assertEquals(
    getVariableInitializer(findInitializer(sourceFile, "wrapper"), checker),
    undefined,
  );
});

Deno.test("AST utils resolve member symbols and optional members", () => {
  const { sourceFile, checker } = createProgram(`
    interface Item {
      required: string;
      optional?: number;
    }
    declare const item: Item;
    declare const key: keyof Item;
    const fromProperty = item.required;
    const fromElement = item["optional"];
    const fromDynamic = item[key];
  `);
  const required = findPropertyAccess(sourceFile, "required");
  const optional = findElementAccess(sourceFile, "optional");
  const dynamic = findInitializer(sourceFile, "fromDynamic");

  assertEquals(getMemberSymbol(required, checker)?.getName(), "required");
  assertEquals(getMemberSymbol(optional, checker)?.getName(), "optional");
  assertEquals(
    getMemberSymbol(dynamic as ts.ElementAccessExpression, checker)?.getName(),
    undefined,
  );
  assertEquals(isOptionalMemberSymbol(required, checker), false);
  assertEquals(isOptionalMemberSymbol(optional, checker), true);
});

Deno.test("AST utils classify function parameters outside builder callbacks", () => {
  const { sourceFile, checker } = createProgram(`
    declare function lift<T, R>(callback: (value: T) => R): unknown;
    declare function pattern<T, R>(callback: (value: T) => R): unknown;
    function ordinary(param: string) {
      return param;
    }
    const lifted = lift((value: string) => value);
    const patterned = pattern((input: string) => input);
    const local = "value";
  `);
  const ordinaryUse = findIdentifier(
    sourceFile,
    "param",
    (node) => ts.isReturnStatement(node.parent),
  );
  const liftedUse = findIdentifier(
    sourceFile,
    "value",
    (node) => ts.isArrowFunction(node.parent) && node.parent.body === node,
  );
  const patternedUse = findIdentifier(
    sourceFile,
    "input",
    (node) => ts.isArrowFunction(node.parent) && node.parent.body === node,
  );
  const local = findIdentifier(
    sourceFile,
    "local",
    (node) => ts.isVariableDeclaration(node.parent),
  );

  assertEquals(isFunctionParameter(ordinaryUse, checker), true);
  assertEquals(isFunctionParameter(liftedUse, checker), false);
  assertEquals(isFunctionParameter(patternedUse, checker), false);
  assertEquals(isFunctionParameter(local, checker), false);
});

Deno.test("AST utils set synthetic parent pointers for method-call helpers", () => {
  const call = ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(
      ts.factory.createPropertyAccessExpression(
        ts.factory.createIdentifier("state"),
        "counter",
      ),
      "set",
    ),
    undefined,
    [],
  );
  setParentPointers(call);
  const callee = call.expression;
  assert(ts.isPropertyAccessExpression(callee));

  assertEquals(isMethodCall(callee), true);
  assertEquals(
    getExpressionText(getMethodCallTarget(callee)!),
    "state.counter",
  );
  assertEquals(
    isMethodCall(callee.expression as ts.PropertyAccessExpression),
    false,
  );
  assertEquals(
    getMethodCallTarget(callee.expression as ts.PropertyAccessExpression),
    undefined,
  );
});

Deno.test("visitEachChildWithJsx traverses elements, self-closing tags, and fragments", () => {
  const source =
    `const elem = <div a={oldName}><span b={oldName} />{oldName}</div>;\n` +
    `const frag = <>{oldName} trailing</>;`;
  const sourceFile = ts.createSourceFile(
    "/test.tsx",
    source,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TSX,
  );

  const result = ts.transform(sourceFile, [
    (context) => (root) => {
      const visit: ts.Visitor = (visited) => {
        if (ts.isIdentifier(visited) && visited.text === "oldName") {
          return ts.factory.createIdentifier("newName");
        }
        return visitEachChildWithJsx(visited, visit, context);
      };
      return ts.visitNode(root, visit) as ts.SourceFile;
    },
  ]);

  const printed = ts.createPrinter().printFile(
    result.transformed[0] as ts.SourceFile,
  );
  result.dispose?.();

  // The rename reached identifiers nested inside the element, the self-closing
  // child, and the fragment — proving each branch traversed its children.
  assertEquals(printed.includes("oldName"), false);
  assert(printed.includes("<div a={newName}>"));
  assert(printed.includes("<span b={newName}/>"));
  assert(printed.includes("<>{newName} trailing</>"));
});
