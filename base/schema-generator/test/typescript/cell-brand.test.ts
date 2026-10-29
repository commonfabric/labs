import { assertEquals, assertExists } from "@std/assert";
import ts from "typescript";

import {
  getCellBrand,
  getCellWrapperInfo,
} from "../../src/typescript/cell-brand.ts";

function createProgram(source: string): {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
} {
  const fileName = "test.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS,
  );

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
  };

  const host = ts.createCompilerHost(compilerOptions, true);

  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.fileExists = (name) => name === fileName;
  host.getDirectories = () => [];
  host.getCurrentDirectory = () => "/";
  host.writeFile = () => {};

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { checker: program.getTypeChecker(), sourceFile };
}

function getPropertyType(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  interfaceName: string,
  propertyName: string,
): ts.Type {
  const statements = sourceFile.statements.filter(ts.isInterfaceDeclaration);
  const iface = statements.find((stmt) => stmt.name.text === interfaceName);
  assertExists(iface, `Interface ${interfaceName} not found`);

  const property = iface.members.find((
    member,
  ): member is ts.PropertySignature =>
    ts.isPropertySignature(member) &&
    !!member.name &&
    ts.isIdentifier(member.name) &&
    member.name.text === propertyName
  );
  assertExists(property, `Property ${propertyName} not found`);

  return checker.getTypeAtLocation(property);
}

Deno.test("getCellWrapperInfo handles unions containing branded cells", () => {
  const source = `
    declare const CELL_BRAND: unique symbol;
    interface BrandedCell<T, Brand extends string> {
      readonly [CELL_BRAND]: Brand;
    }
    interface Cell<T> extends BrandedCell<T, "cell"> {}
    type MaybeCell = Cell<number> | undefined;
    type NullableCell = Cell<string> | null;

    interface Schema {
      maybe: MaybeCell;
      nullable: NullableCell;
    }
  `;

  const { checker, sourceFile } = createProgram(source);
  const maybeType = getPropertyType(checker, sourceFile, "Schema", "maybe");
  const nullableType = getPropertyType(
    checker,
    sourceFile,
    "Schema",
    "nullable",
  );

  const maybeInfo = getCellWrapperInfo(maybeType, checker);
  assertExists(maybeInfo, "Expected wrapper info for MaybeCell");
  assertEquals(maybeInfo.kind, "Cell");
  const maybeArg = maybeInfo.typeRef.typeArguments?.[0];
  assertExists(maybeArg);
  assertEquals(checker.typeToString(maybeArg), "number");

  const nullableInfo = getCellWrapperInfo(nullableType, checker);
  assertExists(nullableInfo, "Expected wrapper info for NullableCell");
  assertEquals(nullableInfo.kind, "Cell");
  const nullableArg = nullableInfo.typeRef.typeArguments?.[0];
  assertExists(nullableArg);
  assertEquals(checker.typeToString(nullableArg), "string");
});

Deno.test("getCellBrand ignores synthetic brand properties", () => {
  const source = `
    type SyntheticBrand = { [Key in "CELL_BRAND"]: "cell" };

    interface Schema {
      value: SyntheticBrand;
    }
  `;

  const { checker, sourceFile } = createProgram(source);
  const type = getPropertyType(checker, sourceFile, "Schema", "value");
  const brand = checker.getPropertiesOfType(type).find((property) =>
    property.getName() === "CELL_BRAND"
  );

  assertExists(brand);
  assertEquals(brand.getDeclarations(), undefined);
  assertEquals(getCellBrand(type, checker), undefined);
});
