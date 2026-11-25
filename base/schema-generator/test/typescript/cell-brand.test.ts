import { assertEquals, assertExists } from "@std/assert";
import { expect } from "@std/expect";
import ts from "typescript";

import {
  getCellBrand,
  getCellWrapperInfo,
} from "../../src/typescript/cell-brand.ts";
import { createTestProgram } from "../utils.ts";
import { describe, it, test } from "@commonfabric/test-support/test";

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

test("getCellWrapperInfo handles unions containing branded cells", () => {
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

test("getCellBrand ignores synthetic brand properties", () => {
  const source = `
    declare const CELL_BRAND: unique symbol;
    type SyntheticBrand = { [Key in typeof CELL_BRAND]: "cell" };

    interface Schema {
      value: SyntheticBrand;
    }
  `;

  const { checker, sourceFile } = createProgram(source);
  const type = getPropertyType(checker, sourceFile, "Schema", "value");
  const brand = checker.getPropertiesOfType(type).find((property) =>
    property.getName().startsWith("__@CELL_BRAND")
  );

  assertExists(brand);
  assertEquals(brand.getDeclarations(), undefined);
  assertEquals(getCellBrand(type, checker), undefined);
});

describe("cell-brand", () => {
  /** The type of each member of the interface `Probes` in `code`, by name. */
  async function probes(code: string) {
    const { checker, sourceFile } = await createTestProgram(code);
    const probe = sourceFile.statements.find((
      statement,
    ): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "Probes"
    )!;
    const types = new Map<string, ts.Type>();
    for (const member of probe.members.filter(ts.isPropertySignature)) {
      types.set(
        member.name.getText(),
        checker.getTypeFromTypeNode(member.type!),
      );
    }
    return { checker, types };
  }

  describe("getCellBrand()", () => {
    it("returns the brand of a member keyed by a `CELL_BRAND` that is a string", async () => {
      // The member's name is the string, which names no cell marker; the
      // computed key it is declared with says it is the brand.
      const { checker, types } = await probes(`
        export {};
        declare const CELL_BRAND: "brand";
        interface Keyed<T> { readonly [CELL_BRAND]: "cell"; value: T }
        interface Named<T> { readonly brand: "cell"; value: T }
        interface Probes { keyed: Keyed<number>; named: Named<number> }
      `);

      expect(getCellBrand(types.get("keyed")!, checker)).toBe("cell");
      expect(getCellBrand(types.get("named")!, checker)).toBeUndefined();
    });

    it("returns `undefined` for a member whose string key is `CELL_BRAND`", async () => {
      const { checker, types } = await probes(`
        interface Plain<T> { readonly CELL_BRAND: "cell"; value: T }
        interface Probes { plain: Plain<number>; cell: Cell<number> }
      `);

      expect(getCellBrand(types.get("plain")!, checker)).toBeUndefined();
      expect(getCellBrand(types.get("cell")!, checker)).toBe("cell");
    });

    it("returns `readonly` for the brand `readonly | cell`, and `undefined` for a union of other kinds", async () => {
      // `ReadonlyCell` declares the first union, the brand that makes a `Cell`
      // assignable to it. The second names two kinds neither of which is
      // assignable to the other.
      const { checker, types } = await probes(`
        interface Readable<T> extends BrandedCell<T, "readonly" | "cell"> {}
        interface Mixed<T> extends BrandedCell<T, "cell" | "stream"> {}
        interface Probes {
          readable: Readable<number>;
          mixed: Mixed<number>;
          readonlyCell: ReadonlyCell<number>;
        }
      `);

      expect(getCellBrand(types.get("readable")!, checker)).toBe("readonly");
      expect(getCellBrand(types.get("mixed")!, checker)).toBeUndefined();
      expect(getCellBrand(types.get("readonlyCell")!, checker)).toBe(
        "readonly",
      );
    });
  });

  describe("getCellWrapperInfo()", () => {
    it("returns `undefined` for a cell whose brand names no wrapper", async () => {
      const { checker, types } = await probes(`
        interface Odd<T> extends BrandedCell<T, "odd"> {}
        interface Probes { odd: Odd<number>; cell: Cell<number> }
      `);

      expect(getCellBrand(types.get("odd")!, checker)).toBe("odd");
      // An info holds checker types, which `expect` takes too long to print
      // in a failure, so the case tests for its absence as a boolean.
      expect(getCellWrapperInfo(types.get("odd")!, checker) === undefined)
        .toBe(true);
      expect(getCellWrapperInfo(types.get("cell")!, checker)?.kind).toBe(
        "Cell",
      );
    });
  });
});
