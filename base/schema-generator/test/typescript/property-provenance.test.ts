import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { registerCommonFabricDeclarationSources } from "../../src/typescript/common-fabric-symbols.ts";
import {
  getCommonFabricComputedKeyName,
  getComputedPropertyKeyInfo,
} from "../../src/typescript/property-name.ts";
import {
  isDefaultAliasSymbol,
  isDefaultNodeWithUndefined,
} from "../../src/typescript/property-optionality.ts";
import { createTestProgramFromFiles } from "../utils.ts";

const KEY_NAMES = ["NAME", "UI", "SELF", "FS"] as const;

function getTypeAlias(
  sourceFile: ts.SourceFile,
  name: string,
): ts.TypeAliasDeclaration {
  const declaration = sourceFile.statements.find((statement) =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === name
  );
  if (!declaration || !ts.isTypeAliasDeclaration(declaration)) {
    throw new Error(`Expected type alias ${name}`);
  }
  return declaration;
}

function getComputedKeyExpressions(
  sourceFile: ts.SourceFile,
  typeName: string,
): ts.Expression[] {
  const declaration = getTypeAlias(sourceFile, typeName);
  if (!ts.isTypeLiteralNode(declaration.type)) {
    throw new Error(`Expected ${typeName} to be a type literal`);
  }
  return declaration.type.members.map((member) => {
    if (
      !ts.isPropertySignature(member) ||
      !member.name ||
      !ts.isComputedPropertyName(member.name)
    ) {
      throw new Error(`Expected a computed property in ${typeName}`);
    }
    return member.name.expression;
  });
}

function getDefaultTypeReference(
  sourceFile: ts.SourceFile,
  typeName: string,
): ts.TypeReferenceNode {
  const node = getTypeAlias(sourceFile, typeName).type;
  if (!ts.isTypeReferenceNode(node)) {
    throw new Error(`Expected ${typeName} to be a type reference`);
  }
  return node;
}

function getTypeReferenceSymbol(
  node: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): ts.Symbol {
  const symbol = checker.getSymbolAtLocation(node.typeName);
  if (!symbol) throw new Error("Expected a type-reference symbol");
  return symbol;
}

describe("Common Fabric property metadata provenance", () => {
  it("does not trust arbitrary unique symbols with reserved key names", async () => {
    const source = `
      declare const NAME: unique symbol;
      declare const UI: unique symbol;
      declare const SELF: unique symbol;
      declare const FS: unique symbol;
      type Output = {
        [NAME]: string;
        [UI]: string;
        [SELF]: string;
        [FS]: string;
      };
    `;
    const { checker, sourceFile } = await createTestProgramFromFiles(
      { "/test.ts": source },
      "/test.ts",
    );

    const expressions = getComputedKeyExpressions(sourceFile, "Output");
    expect(expressions).toHaveLength(KEY_NAMES.length);
    for (const expression of expressions) {
      expect(getComputedPropertyKeyInfo(expression, checker)).toBeUndefined();
    }
  });

  for (
    const fakePath of [
      "/commonfabric.d.ts",
      "/vendor/@commonfabric/api/index.d.ts",
    ]
  ) {
    it(`does not grant property or Default authority from ${fakePath}`, async () => {
      const source = `
        declare const UI: unique symbol;
        type Default<T, V = T> = T;
        type Output = { [UI]: string };
        type Defaulted = Default<string | undefined, undefined>;
      `;
      const { checker, sourceFile } = await createTestProgramFromFiles(
        { [fakePath]: source },
        fakePath,
      );
      const [uiExpression] = getComputedKeyExpressions(sourceFile, "Output");
      const defaultNode = getDefaultTypeReference(sourceFile, "Defaulted");

      expect(
        getCommonFabricComputedKeyName(uiExpression!, checker),
      ).toBeUndefined();
      expect(
        isDefaultAliasSymbol(
          getTypeReferenceSymbol(defaultNode, checker),
          checker,
        ),
      ).toBe(false);
      expect(isDefaultNodeWithUndefined(defaultNode, checker)).toBe(false);
    });
  }

  it("does not let an authored Default<T> alter property optionality", async () => {
    const source = `
      type Default<T, V = T> = T;
      type Defaulted = Default<string | undefined, undefined>;
    `;
    const { checker, sourceFile } = await createTestProgramFromFiles(
      { "/test.ts": source },
      "/test.ts",
    );
    const defaultNode = getDefaultTypeReference(sourceFile, "Defaulted");

    expect(isDefaultNodeWithUndefined(defaultNode, checker)).toBe(false);
  });

  it("accepts imported aliases only from an explicitly registered source", async () => {
    const declarationsPath = "/compiler/commonfabric.d.ts";
    const { program, checker, sourceFile } = await createTestProgramFromFiles(
      {
        [declarationsPath]: `
          export declare const UI: unique symbol;
          export type Default<T, V = T> = T;
        `,
        "/test.ts": `
          import type { Default as CFDefault } from "./compiler/commonfabric.d.ts";
          import { UI as CFUI } from "./compiler/commonfabric.d.ts";
          type Output = { [CFUI]: string };
          type Defaulted = CFDefault<string | undefined, undefined>;
        `,
      },
      "/test.ts",
    );
    const declarationSource = program.getSourceFile(declarationsPath);
    if (!declarationSource) {
      throw new Error("Expected the compiler-owned declaration source");
    }
    registerCommonFabricDeclarationSources(checker, [declarationSource]);

    const [uiExpression] = getComputedKeyExpressions(sourceFile, "Output");
    const defaultNode = getDefaultTypeReference(sourceFile, "Defaulted");

    expect(getCommonFabricComputedKeyName(uiExpression!, checker)).toBe("UI");
    expect(
      isDefaultAliasSymbol(
        getTypeReferenceSymbol(defaultNode, checker),
        checker,
      ),
    ).toBe(true);
    expect(isDefaultNodeWithUndefined(defaultNode, checker)).toBe(true);
  });

  it("requires explicit compiler authority for synthetic __cfHelpers keys", () => {
    const expression = ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier("__cfHelpers"),
      "UI",
    );

    expect(getCommonFabricComputedKeyName(expression)).toBeUndefined();
    expect(
      getCommonFabricComputedKeyName(expression, undefined, {
        allowCompilerOwnedCommonFabricHelperAccess: true,
      }),
    ).toBe("UI");
  });
});
