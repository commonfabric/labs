import ts from "typescript";
import {
  detectTrustedFactoryType,
  type FactoryTypeInfo,
} from "@commonfabric/schema-generator";

import { TransformationContext, Transformer } from "../core/mod.ts";
import {
  isCommonFabricModuleName,
  resolvesToCommonFabricSymbol,
  symbolDeclaresCommonFabricDefault,
} from "@commonfabric/schema-generator/common-fabric-symbols";

const FACTORY_GUIDE = "docs/common/concepts/factories.md";

/** Focused migration diagnostics for common first-class factory mistakes. */
export class FactoryAuthoringValidationTransformer extends Transformer {
  transform(context: TransformationContext): ts.SourceFile {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isImportDeclaration(node)) {
        this.validateLegacyPatternToolImport(node, context);
      } else if (ts.isCallExpression(node)) {
        this.validateLegacyExtraParams(node, context);
      }

      if (ts.isExpression(node)) {
        this.validateFactorySlot(node, context);
      }

      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }

  private validateLegacyPatternToolImport(
    declaration: ts.ImportDeclaration,
    context: TransformationContext,
  ): void {
    if (
      !ts.isStringLiteral(declaration.moduleSpecifier) ||
      !isCommonFabricModuleName(declaration.moduleSpecifier.text)
    ) return;

    const bindings = declaration.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const specifier of bindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (importedName !== "patternTool") continue;
      context.reportDiagnosticOnce({
        severity: "error",
        type: "factory-authoring:legacy-pattern-tool",
        message:
          `patternTool was removed. Create an inline pattern(...) that captures ` +
          `its closure state and pass that factory directly. See ${FACTORY_GUIDE}.`,
        node: specifier,
      });
    }
  }

  private validateLegacyExtraParams(
    call: ts.CallExpression,
    context: TransformationContext,
  ): void {
    if (
      !isCommonFabricCall(call, context, ["generateText", "generateObject"])
    ) {
      return;
    }
    const options = call.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) return;
    const tools = objectPropertyInitializer(options, "tools");
    if (!tools || !ts.isObjectLiteralExpression(tools)) return;
    const extraParams = objectProperty(tools, "extraParams");
    if (!extraParams) return;

    context.reportDiagnosticOnce({
      severity: "error",
      type: "factory-authoring:legacy-extra-params",
      message:
        `extraParams was removed. Capture that state in an inline pattern(...) ` +
        `closure and pass the factory directly. See ${FACTORY_GUIDE}.`,
      node: extraParams.name ?? extraParams,
    });
  }

  private validateFactorySlot(
    expression: ts.Expression,
    context: TransformationContext,
  ): void {
    const annotatedVariableInitializer =
      ts.isVariableDeclaration(expression.parent) &&
      expression.parent.initializer === expression &&
      expression.parent.type !== undefined;
    if (!annotatedVariableInitializer) return;

    const checker = context.checker;
    const expectedType = checker.getContextualType(expression);
    if (!expectedType) return;
    const expected = factoryMembers(expectedType, checker);
    if (expected.length === 0) return;

    const actualType = checker.getTypeAtLocation(expression);
    const actual = factoryMembers(actualType, checker);
    if (
      (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) &&
      actual.length === 0
    ) {
      const kinds = namedKinds(expected);
      context.reportDiagnosticOnce({
        severity: "error",
        type: "factory-authoring:plain-function",
        message: `A plain function is not a ${kinds}. Wrap the callback in ${
          builderGuidance(expected)
        } to construct a serializable factory. See ${FACTORY_GUIDE}.`,
        node: expression,
      });
      return;
    }
    if (actual.length === 0) return;

    const expectedKinds = new Set(expected.map((factory) => factory.kind));
    const actualKinds = new Set(actual.map((factory) => factory.kind));
    if (![...actualKinds].some((kind) => expectedKinds.has(kind))) {
      context.reportDiagnosticOnce({
        severity: "error",
        type: "factory-authoring:wrong-kind",
        message:
          `A ${lowerKinds(actual)} was used where a ${lowerKinds(expected)} ` +
          `is required. Factory kinds are not interchangeable.`,
        node: expression,
      });
      return;
    }

    if (
      !checker.isTypeAssignableTo(actualType, expectedType) &&
      actual.some((factory) => typeContainsDefault(factory.inputType, checker))
    ) {
      context.reportDiagnosticOnce({
        severity: "error",
        type: "factory-authoring:default-input-slot",
        message:
          `This factory input contains Default<>, which narrows its public ` +
          `input contract and makes it incompatible with the factory slot. ` +
          `Make the factory and slot input types match exactly; keep authored ` +
          `defaults outside a widened factory contract. See ${FACTORY_GUIDE}.`,
        node: expression,
      });
    }
  }
}

function isCommonFabricCall(
  call: ts.CallExpression,
  context: TransformationContext,
  names: readonly string[],
): boolean {
  const symbol = context.checker.getSymbolAtLocation(call.expression);
  return names.some((name) =>
    resolvesToCommonFabricSymbol(symbol, context.checker, name)
  );
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) =>
    property.name && propertyName(property.name) === name
  );
}

function objectPropertyInitializer(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  const property = objectProperty(object, name);
  return property && ts.isPropertyAssignment(property)
    ? property.initializer
    : undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ||
      ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function factoryMembers(
  type: ts.Type,
  checker: ts.TypeChecker,
): FactoryTypeInfo[] {
  const members = type.isUnion() ? type.types : [type];
  return members.flatMap((member) => {
    const factory = detectTrustedFactoryType(member, checker);
    return factory ? [factory] : [];
  });
}

function namedKinds(factories: readonly FactoryTypeInfo[]): string {
  return [
    ...new Set(
      factories.map((factory) =>
        `${factory.kind[0]!.toUpperCase()}${factory.kind.slice(1)}Factory`
      ),
    ),
  ].join(" or ");
}

function lowerKinds(factories: readonly FactoryTypeInfo[]): string {
  return [...new Set(factories.map((factory) => `${factory.kind} factory`))]
    .join(" or ");
}

function builderGuidance(factories: readonly FactoryTypeInfo[]): string {
  return [...new Set(factories.map((factory) => `${factory.kind}(...)`))]
    .join(" or ");
}

function typeContainsDefault(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type> = new Set(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (
    symbolDeclaresCommonFabricDefault(type.aliasSymbol, checker) ||
    symbolDeclaresCommonFabricDefault(type.symbol, checker)
  ) return true;
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) =>
      typeContainsDefault(member, checker, seen)
    );
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  return checker.getPropertiesOfType(type).some((property) =>
    symbolDeclaresCommonFabricDefault(property, checker) ||
    typeContainsDefault(checker.getTypeOfSymbol(property), checker, seen)
  );
}
