import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import { parseModule } from "./transformed-ast.ts";

import {
  ensureTypeNodeRegistered,
  getTypeFromTypeNodeWithFallback,
  hasArrayTypeArgument,
  inferArrayElementType,
  inferContextualType,
  inferParameterType,
  inferReturnType,
  inferWidenedTypeFromExpression,
  isAnyOrUnknownType,
  isAnyType,
  isCollectionType,
  isUnknownType,
  isUnresolvedSchemaType,
  registerLiftAppliedCallType,
  registerSyntheticCallType,
  registerTypeForNode,
  tryExplicitParameterType,
  typeToSchemaTypeNode,
  typeToTypeNode,
  unwrapCellLikeType,
  unwrapOpaqueLikeType,
  widenLiteralType,
} from "../src/ast/type-inference.ts";

interface ProgramParts {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
}

function createProgram(source: string): ProgramParts {
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
): ts.Identifier {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isIdentifier(node) && node.text === text) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Missing identifier ${text}`);
  return found;
}

function findVariable(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Missing variable ${name}`);
  return found;
}

function findTypeAlias(
  sourceFile: ts.SourceFile,
  name: string,
): ts.TypeAliasDeclaration {
  let found: ts.TypeAliasDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Missing type alias ${name}`);
  return found;
}

function findArrow(sourceFile: ts.SourceFile, variableName: string) {
  const variable = findVariable(sourceFile, variableName);
  if (!variable.initializer || !ts.isArrowFunction(variable.initializer)) {
    throw new Error(`Missing arrow initializer for ${variableName}`);
  }
  return variable.initializer;
}

function typeText(
  type: ts.Type | undefined,
  checker: ts.TypeChecker,
): string {
  return type ? checker.typeToString(type) : "undefined";
}

// Reparse a printed type (the checker's `typeToString` output) into a real
// type node by wrapping it in `type __T = …;`. Assertions then read the
// parsed structure instead of matching a substring of the printed string,
// which a wider type (`{ title: string } & X`) could otherwise satisfy.
function reparseType(printed: string): ts.TypeNode {
  const root = parseModule(`type __T = ${printed};`);
  const alias = root.statements[0];
  assert(
    ts.isTypeAliasDeclaration(alias),
    `expected a type alias for ${printed}`,
  );
  return alias.type;
}

// The property names of a printed object type, as a set.
function objectMemberNames(printed: string): Set<string> {
  const node = reparseType(printed);
  assert(ts.isTypeLiteralNode(node), `expected an object type for ${printed}`);
  const names = new Set<string>();
  for (const member of node.members) {
    assert(ts.isPropertySignature(member));
    const name = member.name;
    assert(ts.isIdentifier(name) || ts.isStringLiteralLike(name));
    names.add(name.text);
  }
  return names;
}

Deno.test("type inference helpers classify special types and widen literals", () => {
  const { sourceFile, checker } = createProgram(`
    type Generic<T> = T;
    type AnyAlias = any;
    type UnknownAlias = unknown;
    const numberLiteral = 42 as const;
    const stringLiteral = "title" as const;
    const objectValue = { title: "kept" };
  `);
  const anyType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "AnyAlias").type,
  );
  const unknownType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "UnknownAlias").type,
  );
  const typeParameter = checker.getTypeAtLocation(
    findTypeAlias(sourceFile, "Generic").typeParameters![0]!.name,
  );
  const numberType = checker.getTypeAtLocation(
    findIdentifier(sourceFile, "numberLiteral"),
  );
  const stringType = checker.getTypeAtLocation(
    findIdentifier(sourceFile, "stringLiteral"),
  );
  const objectType = checker.getTypeAtLocation(
    findIdentifier(sourceFile, "objectValue"),
  );
  const booleanUnion = (checker as ts.TypeChecker & {
    getUnionType: (types: readonly ts.Type[]) => ts.Type;
  }).getUnionType([
    checker.getTrueType(),
    checker.getFalseType(),
  ]);

  assertEquals(isAnyType(undefined), false);
  assertEquals(isAnyType(anyType), true);
  assertEquals(isUnknownType(undefined), false);
  assertEquals(isUnknownType(unknownType), true);
  assertEquals(isAnyOrUnknownType(undefined), false);
  assertEquals(isAnyOrUnknownType(anyType), true);
  assertEquals(isUnresolvedSchemaType(undefined), false);
  assertEquals(isUnresolvedSchemaType(typeParameter), true);
  assertEquals(
    typeText(widenLiteralType(numberType, checker), checker),
    "number",
  );
  assertEquals(
    typeText(widenLiteralType(stringType, checker), checker),
    "string",
  );
  assertEquals(widenLiteralType(booleanUnion, checker), booleanUnion);
  assertEquals(widenLiteralType(objectType, checker), objectType);
});

Deno.test("type inference helpers infer parameters, returns, and contextual types", () => {
  const { sourceFile, checker } = createProgram(`
    const typed = (value: { title: string }) => value.title;
    const contextual: (value: { count: number }) => number = (value) => value.count;
    type Fn = (item: { count: number }) => number;
    declare const declared: Fn;
    const literal = 1 as const;
  `);
  const typed = findArrow(sourceFile, "typed");
  const contextual = findArrow(sourceFile, "contextual");
  const declared = findVariable(sourceFile, "declared");
  const typedSignature = checker.getSignatureFromDeclaration(typed)!;
  const declaredSignature = checker.getSignaturesOfType(
    checker.getTypeAtLocation(declared.name),
    ts.SignatureKind.Call,
  )[0]!;
  const registry = new WeakMap<ts.Node, ts.Type>();

  const explicit = tryExplicitParameterType(
    typed.parameters[0],
    checker,
    registry,
  );
  assert(explicit);
  assertEquals(
    getTypeFromTypeNodeWithFallback(explicit.typeNode, checker, registry),
    explicit.type,
  );
  assert(objectMemberNames(typeText(explicit.type, checker)).has("title"));

  const inferredFromSignature = inferParameterType(
    undefined,
    declaredSignature,
    checker,
  );
  assert(
    objectMemberNames(typeText(inferredFromSignature, checker)).has("count"),
  );
  assertEquals(
    inferParameterType(typed.parameters[0], typedSignature, checker),
    explicit.type,
  );
  assertEquals(
    typeText(inferReturnType(typed, typedSignature, checker), checker),
    "string",
  );
  // The contextual type is the whole function signature; its first parameter
  // is the object carrying `count`.
  const contextualType = reparseType(
    typeText(inferContextualType(contextual, checker), checker),
  );
  assert(ts.isFunctionTypeNode(contextualType));
  const contextualParam = contextualType.parameters[0]?.type;
  assert(contextualParam && ts.isTypeLiteralNode(contextualParam));
  assert(
    contextualParam.members.some((member) =>
      ts.isPropertySignature(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === "count"
    ),
  );
  assertEquals(
    typeText(
      inferWidenedTypeFromExpression(
        findVariable(sourceFile, "literal").initializer!,
        checker,
      ),
      checker,
    ),
    "number",
  );
});

Deno.test("type inference helpers register synthetic type nodes", () => {
  const { sourceFile, checker } = createProgram(`
    type Name = string;
    type Count = number;
    type Existing = { done: boolean };
    declare function lift(): unknown;
  `);
  const nameNode = findTypeAlias(sourceFile, "Name").type;
  const countNode = findTypeAlias(sourceFile, "Count").type;
  const existingNode = findTypeAlias(sourceFile, "Existing").type;
  const registry = new WeakMap<ts.Node, ts.Type>();
  const typeLiteral = ts.factory.createTypeLiteralNode([
    ts.factory.createPropertySignature(
      undefined,
      "name",
      undefined,
      nameNode,
    ),
    ts.factory.createPropertySignature(
      undefined,
      "count",
      ts.factory.createToken(ts.SyntaxKind.QuestionToken),
      countNode,
    ),
  ]);
  const arrayNode = ts.factory.createArrayTypeNode(nameNode);
  const unionNode = ts.factory.createUnionTypeNode([nameNode, countNode]);
  const parenthesizedNode = ts.factory.createParenthesizedType(nameNode);

  assertEquals(
    ensureTypeNodeRegistered(nameNode, checker),
    checker.getStringType(),
  );
  assertEquals(
    getTypeFromTypeNodeWithFallback(existingNode, checker, registry),
    ensureTypeNodeRegistered(existingNode, checker, registry),
  );
  assert(
    objectMemberNames(
      typeText(
        ensureTypeNodeRegistered(typeLiteral, checker, registry),
        checker,
      ),
    ).has("name"),
  );
  const arrayType = reparseType(
    typeText(ensureTypeNodeRegistered(arrayNode, checker, registry), checker),
  );
  assert(ts.isArrayTypeNode(arrayType));
  assertEquals(arrayType.elementType.kind, ts.SyntaxKind.StringKeyword);
  const unionType = reparseType(
    typeText(ensureTypeNodeRegistered(unionNode, checker, registry), checker),
  );
  assert(ts.isUnionTypeNode(unionType));
  assertEquals(
    unionType.types.map((member) => member.kind).sort(),
    [ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword].sort(),
  );
  assertEquals(
    ensureTypeNodeRegistered(parenthesizedNode, checker, registry),
    checker.getStringType(),
  );

  const returnedNode = registerTypeForNode(
    countNode,
    checker.getNumberType(),
    registry,
  );
  assertEquals(returnedNode, countNode);
  assertEquals(registry.get(countNode), checker.getNumberType());

  const call = ts.factory.createCallExpression(
    findIdentifier(sourceFile, "lift"),
    undefined,
    [],
  );
  registerSyntheticCallType(call, checker.getBooleanType(), registry);
  assertEquals(registry.get(call), checker.getBooleanType());
  const secondCall = ts.factory.createCallExpression(
    findIdentifier(sourceFile, "lift"),
    undefined,
    [],
  );
  registerLiftAppliedCallType(
    secondCall,
    nameNode,
    undefined,
    checker,
    registry,
  );
  assertEquals(registry.get(secondCall), checker.getStringType());
});

Deno.test("type inference helpers detect collections and array element types", () => {
  const { sourceFile, checker } = createProgram(`
    type ArrayContainer = Array<string[]>;
    type UnionContainer = Array<string[]> | Array<number>;
    type IntersectionContainer = Array<string[]> & { tag: string };
    const numbers = [1, 2, 3];
    const tuple = ["name", 1] as const;
    const unionArray = Math.random() > 0.5 ? ["a"] : [1];
    const scalar = 1;
    declare const arrayContainer: ArrayContainer;
    declare const scalarContainer: Array<string>;
  `);
  const numbers = findIdentifier(sourceFile, "numbers");
  const tuple = findIdentifier(sourceFile, "tuple");
  const unionArray = findIdentifier(sourceFile, "unionArray");
  const scalar = findIdentifier(sourceFile, "scalar");
  const arrayContainer = findIdentifier(sourceFile, "arrayContainer");
  const scalarContainer = findIdentifier(sourceFile, "scalarContainer");
  const arrayContainerType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "ArrayContainer").type,
  );
  const unionContainerType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "UnionContainer").type,
  );
  const intersectionContainerType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "IntersectionContainer").type,
  );

  assertEquals(isCollectionType(undefined, checker), false);
  assertEquals(
    isCollectionType(checker.getTypeAtLocation(numbers), checker),
    true,
  );
  assertEquals(
    isCollectionType(checker.getTypeAtLocation(tuple), checker),
    true,
  );
  assertEquals(
    isCollectionType(checker.getTypeAtLocation(unionArray), checker),
    true,
  );
  assertEquals(hasArrayTypeArgument(arrayContainerType, checker), true);
  assertEquals(hasArrayTypeArgument(unionContainerType, checker), true);
  assertEquals(hasArrayTypeArgument(intersectionContainerType, checker), true);
  assertEquals(
    hasArrayTypeArgument(checker.getTypeAtLocation(scalarContainer), checker),
    false,
  );

  assertEquals(
    typeText(
      inferArrayElementType(numbers, {
        checker,
        factory: ts.factory,
        sourceFile,
      }).type,
      checker,
    ),
    "number",
  );
  assertEquals(
    typeText(
      inferArrayElementType(arrayContainer, {
        checker,
        factory: ts.factory,
        sourceFile,
      }).type,
      checker,
    ),
    "string",
  );
  assertEquals(
    typeText(
      inferArrayElementType(scalarContainer, {
        checker,
        factory: ts.factory,
        sourceFile,
      }).type,
      checker,
    ),
    "string",
  );
  assertEquals(
    inferArrayElementType(scalar, {
      checker,
      factory: ts.factory,
      sourceFile,
    }).typeNode.kind,
    ts.SyntaxKind.UnknownKeyword,
  );
});

Deno.test("type inference helpers convert and unwrap types conservatively", () => {
  const { sourceFile, checker } = createProgram(`
    type Box<T> = { value: T };
    type NameBox = Box<string>;
    type NameOrCount = string | number;
    const value: NameBox = { value: "Ada" };
  `);
  const boxType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "NameBox").type,
  );
  const unionType = checker.getTypeFromTypeNode(
    findTypeAlias(sourceFile, "NameOrCount").type,
  );
  const value = findIdentifier(sourceFile, "value");

  const unwrappedUnion = reparseType(
    typeText(unwrapOpaqueLikeType(unionType, checker), checker),
  );
  assert(ts.isUnionTypeNode(unwrappedUnion));
  assertEquals(
    unwrappedUnion.types.map((member) => member.kind).sort(),
    [ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword].sort(),
  );
  assertEquals(unwrapCellLikeType(undefined, checker), undefined);
  assertEquals(unwrapCellLikeType(boxType, checker), boxType);

  const asTypeNode = typeToTypeNode(boxType, checker, sourceFile);
  assert(asTypeNode);
  // The converted node refers back to the named alias rather than inlining the
  // object shape.
  assert(ts.isTypeReferenceNode(asTypeNode));
  assert(ts.isIdentifier(asTypeNode.typeName));
  assertEquals(asTypeNode.typeName.text, "NameBox");
  const schemaTypeNode = typeToSchemaTypeNode(
    checker.getTypeAtLocation(value),
    checker,
    sourceFile,
  );
  assert(schemaTypeNode);
});
