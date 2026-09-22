/**
 * Unit tests for symbolDeclaresCommonFabricDefault.
 *
 * The function returns true for properties whose declared type is the Common
 * Fabric Default<T,V> from `@commonfabric/api`. A user type named "Default"
 * does not trigger the same special handling.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";

import {
  getImportTypeModuleName,
  isCommonFabricDeclaration,
  isCommonFabricModuleName,
  isCommonFabricSymbol,
  symbolDeclaresCommonFabricDefault,
} from "../../src/typescript/common-fabric-symbols.ts";

//
// Test infrastructure
//

/**
 * Build a minimal TypeScript program from an in-memory file map.
 * Files named "commonfabric.d.ts" are included as root files so their global
 * declarations are visible without imports.
 */
function createProgram(sources: Record<string, string>): {
  program: ts.Program;
  checker: ts.TypeChecker;
} {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      const text = sources[name];
      if (text !== undefined) {
        return ts.createSourceFile(name, text, compilerOptions.target!, true);
      }
      return undefined;
    },
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => sources[name] !== undefined,
    readFile: (name) => sources[name],
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
  };

  const program = ts.createProgram(Object.keys(sources), compilerOptions, host);
  return { program, checker: program.getTypeChecker() };
}

/**
 * Return the ts.Symbol for a named property on a named interface in the
 * given source file.
 */
function getPropertySymbol(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  interfaceName: string,
  propName: string,
): ts.Symbol | undefined {
  let found: ts.Symbol | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      const ifaceSymbol = checker.getSymbolAtLocation(node.name);
      if (ifaceSymbol) {
        const ifaceType = checker.getDeclaredTypeOfSymbol(ifaceSymbol);
        found = ifaceType.getProperty(propName);
      }
    }
  });
  return found;
}

function getInterfaceSymbol(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  interfaceName: string,
): ts.Symbol | undefined {
  let found: ts.Symbol | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      found = checker.getSymbolAtLocation(node.name);
    }
  });
  return found;
}

function findFirstNode<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  predicate: (node: ts.Node) => node is T,
): T | undefined {
  let found: T | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

//
// Tests
//

describe("isCommonFabricModuleName", () => {
  it("matches Common Fabric module names", () => {
    assert(isCommonFabricModuleName("commonfabric"));
    assert(isCommonFabricModuleName("@commonfabric/api"));
    assert(isCommonFabricModuleName("@commonfabric/common"));
  });

  it("rejects unrelated module names", () => {
    assertFalse(isCommonFabricModuleName("not-commonfabric"));
    assertFalse(isCommonFabricModuleName("@notcommonfabric/api"));
  });
});

describe("getImportTypeModuleName", () => {
  it("reads the module name from an import type node", () => {
    const sourceFile = ts.createSourceFile(
      "/test.ts",
      `type Ref = import("@commonfabric/api").Cell<number>;`,
      ts.ScriptTarget.ES2020,
      true,
      ts.ScriptKind.TS,
    );

    const typeNode = findFirstNode(sourceFile, ts.isImportTypeNode);

    assert(typeNode);
    assertEquals(getImportTypeModuleName(typeNode), "@commonfabric/api");
  });
});

describe("isCommonFabricDeclaration", () => {
  it("matches declarations from Common Fabric source files", () => {
    const sourceFile = ts.createSourceFile(
      "/repo/packages/api/index.ts",
      `export interface Cell<T> { value: T }`,
      ts.ScriptTarget.ES2020,
      true,
      ts.ScriptKind.TS,
    );

    const declaration = findFirstNode(sourceFile, ts.isInterfaceDeclaration);

    assert(declaration);
    assert(isCommonFabricDeclaration(declaration));
  });

  it("matches declarations from installed Common Fabric package files", () => {
    const sourceFile = ts.createSourceFile(
      "/repo/node_modules/@commonfabric/api/index.d.ts",
      `export interface Cell<T> { value: T }`,
      ts.ScriptTarget.ES2020,
      true,
      ts.ScriptKind.TS,
    );

    const declaration = findFirstNode(sourceFile, ts.isInterfaceDeclaration);

    assert(declaration);
    assert(isCommonFabricDeclaration(declaration));
  });

  it("matches declarations inside Common Fabric ambient modules", () => {
    const sourceFile = ts.createSourceFile(
      "/types.d.ts",
      `declare module "@commonfabric/api" {
        export interface Cell<T> { value: T }
      }`,
      ts.ScriptTarget.ES2020,
      true,
      ts.ScriptKind.TS,
    );

    const declaration = findFirstNode(sourceFile, ts.isInterfaceDeclaration);

    assert(declaration);
    assert(isCommonFabricDeclaration(declaration));
  });

  it("rejects user declarations with matching names", () => {
    const sourceFile = ts.createSourceFile(
      "/test.ts",
      `interface Cell<T> { value: T }`,
      ts.ScriptTarget.ES2020,
      true,
      ts.ScriptKind.TS,
    );

    const declaration = findFirstNode(sourceFile, ts.isInterfaceDeclaration);

    assert(declaration);
    assertFalse(isCommonFabricDeclaration(declaration));
  });
});

describe("isCommonFabricSymbol", () => {
  it("matches symbols from Common Fabric source files", () => {
    const { program, checker } = createProgram({
      "/repo/packages/api/index.ts": `
        export interface Cell<T> {
          get(): T;
        }
      `,
    });

    const sf = program.getSourceFile("/repo/packages/api/index.ts")!;
    const symbol = getInterfaceSymbol(checker, sf, "Cell");

    assert(symbol);
    assert(isCommonFabricSymbol(symbol));
  });

  it("matches symbols from installed Common Fabric package files", () => {
    const { program, checker } = createProgram({
      "/repo/node_modules/@commonfabric/api/index.d.ts": `
        export interface Cell<T> {
          get(): T;
        }
      `,
    });

    const sf = program.getSourceFile(
      "/repo/node_modules/@commonfabric/api/index.d.ts",
    )!;
    const symbol = getInterfaceSymbol(checker, sf, "Cell");

    assert(symbol);
    assert(isCommonFabricSymbol(symbol));
  });

  it("rejects user symbols with Common Fabric names", () => {
    const { program, checker } = createProgram({
      "/test.ts": `
        interface Cell<T> {
          get(): T;
        }
      `,
    });

    const sf = program.getSourceFile("/test.ts")!;
    const symbol = getInterfaceSymbol(checker, sf, "Cell");

    assert(symbol);
    assertFalse(isCommonFabricSymbol(symbol));
  });
});

describe("symbolDeclaresCommonFabricDefault", () => {
  it("returns `false` for a mapped-type property, which has no declarations", () => {
    const { program, checker } = createProgram({
      "/test.ts": `
        declare const r: { [K in "x"]: number };
        export const y = r;
      `,
    });
    const sf = program.getSourceFile("/test.ts")!;
    const declaration = findFirstNode(
      sf,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === "y",
    );
    const property = checker.getPropertyOfType(
      checker.getTypeAtLocation(declaration!.name),
      "x",
    );

    assert(property !== undefined);
    assertEquals(property.getDeclarations(), undefined);
    assertFalse(symbolDeclaresCommonFabricDefault(property, checker));
  });

  describe("user-defined Default type (should return false)", () => {
    it("returns false when the property type references a user-defined Default alias in the same file", () => {
      // Default is declared in /test.ts — NOT in commonfabric.d.ts.
      const { program, checker } = createProgram({
        "/test.ts": `
          type Default<T, V = T> = T;

          interface MyArgs {
            title: Default<string, "Untitled">;
          }
        `,
      });

      const sf = program.getSourceFile("/test.ts")!;
      const titleSymbol = getPropertySymbol(checker, sf, "MyArgs", "title");

      assertFalse(
        symbolDeclaresCommonFabricDefault(titleSymbol, checker),
        "User-defined Default (same file) must NOT be treated as Common Fabric Default",
      );
    });

    it("returns false when Default is imported from a non-commonfabric file", () => {
      // Even if the alias chain eventually looks like Default, the source file
      // check should disqualify it when it doesn't come from commonfabric.d.ts.
      const { program, checker } = createProgram({
        "/lib/defaults.ts": `
          export type Default<T, V = T> = T;
        `,
        "/test.ts": `
          import type { Default } from "@commonfabric/lib/defaults";

          interface MyArgs {
            count: Default<number, 0>;
          }
        `,
      });

      const sf = program.getSourceFile("/test.ts")!;
      const countSymbol = getPropertySymbol(checker, sf, "MyArgs", "count");

      assertFalse(
        symbolDeclaresCommonFabricDefault(countSymbol, checker),
        "Default from a non-commonfabric file must NOT be treated as Common Fabric Default",
      );
    });

    it("returns false for a user Default used as an optional property", () => {
      const { program, checker } = createProgram({
        "/test.ts": `
          type Default<T, V = T> = T;

          interface Config {
            theme?: Default<string, "dark">;
          }
        `,
      });

      const sf = program.getSourceFile("/test.ts")!;
      const themeSymbol = getPropertySymbol(checker, sf, "Config", "theme");

      assertFalse(
        symbolDeclaresCommonFabricDefault(themeSymbol, checker),
        "Optional property with user-defined Default must NOT be treated as Common Fabric Default",
      );
    });

    it("returns false for a cycle of referenced types", () => {
      const { program, checker } = createProgram({
        "/test.ts": `
          type First = Second;
          type Second = First;

          interface Config {
            theme: First;
          }
        `,
      });

      const sf = program.getSourceFile("/test.ts")!;
      const themeSymbol = getPropertySymbol(checker, sf, "Config", "theme");

      assertFalse(symbolDeclaresCommonFabricDefault(themeSymbol, checker));
    });
  });

  describe("Common Fabric Default from commonfabric.d.ts (should return true)", () => {
    it("returns true when the property type references Default declared in commonfabric.d.ts", () => {
      const { program, checker } = createProgram({
        "commonfabric.d.ts": `
          declare const DEFAULT_MARKER: unique symbol;
          declare type Default<T, V = T> = T | (T & { readonly [DEFAULT_MARKER]: T });
        `,
        "/test.ts": `
          interface MyArgs {
            title: Default<string, "Untitled">;
          }
        `,
      });

      const sf = program.getSourceFile("/test.ts")!;
      const titleSymbol = getPropertySymbol(checker, sf, "MyArgs", "title");

      assert(
        symbolDeclaresCommonFabricDefault(titleSymbol, checker),
        "Property typed with Common Fabric Default (from commonfabric.d.ts) must return true",
      );
    });

    it("returns true for an optional property typed with Common Fabric Default", () => {
      const { program, checker } = createProgram({
        "commonfabric.d.ts": `
          declare const DEFAULT_MARKER: unique symbol;
          declare type Default<T, V = T> = T | (T & { readonly [DEFAULT_MARKER]: T });
        `,
        "/test.ts": `
          interface Config {
            theme?: Default<string, "dark">;
          }
        `,
      });

      const sf = program.getSourceFile("/test.ts")!;
      const themeSymbol = getPropertySymbol(checker, sf, "Config", "theme");

      assert(
        symbolDeclaresCommonFabricDefault(themeSymbol, checker),
        "Optional property typed with Common Fabric Default must return true",
      );
    });
  });
});
