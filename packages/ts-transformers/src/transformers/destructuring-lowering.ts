import ts from "typescript";
import { createRegisteredTypeLiteral } from "../ast/type-building.ts";
import { unwrapExpression } from "../utils/expression.ts";
import {
  cloneKeyExpression,
  getCommonFabricKeyName,
  getKnownComputedKeyExpression,
  isCommonFabricKeyExpression,
} from "../utils/reactive-keys.ts";
import type { TransformationContext } from "../core/mod.ts";

export type PathSegment = string | ts.Expression;

export interface DestructureBinding {
  readonly localName: string;
  readonly path: readonly PathSegment[];
  readonly directKeyExpression?: ts.Expression;

  /** Binding syntax represented by the lowered declaration. */
  readonly bindingNode: ts.Identifier | ts.BindingElement;
}

export interface DefaultDestructureBinding {
  readonly path: readonly string[];
  readonly defaultType: ts.TypeNode;
}

export function toStringPath(
  path: readonly PathSegment[],
): readonly string[] | undefined {
  const out: string[] = [];
  for (const segment of path) {
    if (typeof segment !== "string") {
      return undefined;
    }
    out.push(segment);
  }
  return out;
}

export function getStaticDefaultTypeNode(
  expression: ts.Expression,
  context: TransformationContext,
): ts.TypeNode | undefined {
  const factory = context.factory;
  const current = unwrapExpression(expression);

  if (
    ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return factory.createLiteralTypeNode(
      factory.createStringLiteral(current.text),
    );
  }
  if (ts.isNumericLiteral(current)) {
    return factory.createLiteralTypeNode(
      factory.createNumericLiteral(current.text),
    );
  }
  if (ts.isBigIntLiteral(current)) {
    return factory.createLiteralTypeNode(
      factory.createBigIntLiteral(current.text),
    );
  }
  if (
    current.kind === ts.SyntaxKind.TrueKeyword ||
    current.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return factory.createLiteralTypeNode(
      current.kind === ts.SyntaxKind.TrueKeyword
        ? factory.createTrue()
        : factory.createFalse(),
    );
  }
  if (current.kind === ts.SyntaxKind.NullKeyword) {
    return factory.createLiteralTypeNode(factory.createNull());
  }
  if (ts.isIdentifier(current) && current.text === "undefined") {
    return factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
  }

  if (
    ts.isPrefixUnaryExpression(current) &&
    (current.operator === ts.SyntaxKind.MinusToken ||
      current.operator === ts.SyntaxKind.PlusToken)
  ) {
    const operand = unwrapExpression(current.operand);
    if (ts.isNumericLiteral(operand) || ts.isBigIntLiteral(operand)) {
      return factory.createLiteralTypeNode(
        factory.createPrefixUnaryExpression(
          current.operator,
          ts.isNumericLiteral(operand)
            ? factory.createNumericLiteral(operand.text)
            : factory.createBigIntLiteral(operand.text),
        ),
      );
    }
  }

  if (ts.isArrayLiteralExpression(current)) {
    const elements: ts.TypeNode[] = [];
    for (const element of current.elements) {
      if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) {
        return undefined;
      }
      const elementType = getStaticDefaultTypeNode(element, context);
      if (!elementType) return undefined;
      elements.push(elementType);
    }
    return factory.createTupleTypeNode(elements);
  }

  if (ts.isObjectLiteralExpression(current)) {
    const members: ts.TypeElement[] = [];
    for (const property of current.properties) {
      if (!ts.isPropertyAssignment(property)) {
        return undefined;
      }

      let name: ts.PropertyName;
      if (ts.isIdentifier(property.name)) {
        name = factory.createIdentifier(property.name.text);
      } else if (ts.isStringLiteral(property.name)) {
        name = factory.createStringLiteral(property.name.text);
      } else if (ts.isNumericLiteral(property.name)) {
        name = factory.createNumericLiteral(property.name.text);
      } else if (ts.isNoSubstitutionTemplateLiteral(property.name)) {
        name = factory.createStringLiteral(property.name.text);
      } else {
        return undefined;
      }

      const valueType = getStaticDefaultTypeNode(property.initializer, context);
      if (!valueType) return undefined;

      members.push(
        factory.createPropertySignature(
          undefined,
          name,
          undefined,
          valueType,
        ),
      );
    }
    return createRegisteredTypeLiteral(
      members,
      {
        factory,
        checker: context.checker,
        typeRegistry: context.state.typeRegistry,
      },
    );
  }

  return undefined;
}

function getEmitSafeComputedKeyText(
  expression: ts.Expression,
  context: TransformationContext,
): string | undefined {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }

  const commonFabricKeyName = getCommonFabricKeyName(
    expression,
    context.checker,
  );
  return commonFabricKeyName ? `$${commonFabricKeyName}` : undefined;
}

export function collectDestructureBindings(
  name: ts.BindingName,
  path: readonly PathSegment[],
  bindings: DestructureBinding[],
  defaults: DefaultDestructureBinding[],
  unsupported: string[],
  context: TransformationContext,
): void {
  if (ts.isIdentifier(name)) {
    bindings.push({
      localName: name.text,
      path,
      bindingNode: name,
    });
    return;
  }

  if (ts.isArrayBindingPattern(name)) {
    for (let index = 0; index < name.elements.length; index++) {
      const element = name.elements[index];
      if (!element || ts.isOmittedExpression(element)) {
        continue;
      }

      if (element.dotDotDotToken) {
        unsupported.push(
          "Rest destructuring is not lowerable in pattern context; avoid ...rest in pattern parameters.",
        );
        continue;
      }

      if (element.initializer) {
        const defaultType = getStaticDefaultTypeNode(
          element.initializer,
          context,
        );
        if (!defaultType) {
          unsupported.push(
            "Non-static destructuring initializers are not lowerable in pattern context; use a static literal default or move defaulting into computed().",
          );
          continue;
        }

        const defaultPath = toStringPath([...path, String(index)]);
        if (!defaultPath) {
          unsupported.push(
            "Defaults on dynamic destructuring keys are not lowerable in pattern context; move defaulting into computed().",
          );
          continue;
        }
        defaults.push({
          path: defaultPath,
          defaultType,
        });
      }

      const nextPath = [...path, String(index)];
      if (ts.isIdentifier(element.name)) {
        bindings.push({
          localName: element.name.text,
          path: nextPath,
          bindingNode: element,
        });
        continue;
      }

      collectDestructureBindings(
        element.name,
        nextPath,
        bindings,
        defaults,
        unsupported,
        context,
      );
    }
    return;
  }

  for (const element of name.elements) {
    if (element.dotDotDotToken) {
      unsupported.push(
        "Rest destructuring is not lowerable in pattern context; avoid ...rest in pattern parameters.",
      );
      continue;
    }

    let key: PathSegment | undefined;
    let directKeyExpression: ts.Expression | undefined;
    if (!element.propertyName) {
      if (ts.isIdentifier(element.name)) {
        key = element.name.text;
      } else {
        unsupported.push(
          "Nested binding without explicit property key is not lowerable in pattern context.",
        );
        continue;
      }
    } else if (ts.isIdentifier(element.propertyName)) {
      key = element.propertyName.text;
    } else if (ts.isStringLiteral(element.propertyName)) {
      key = element.propertyName.text;
    } else if (ts.isNumericLiteral(element.propertyName)) {
      key = element.propertyName.text;
    } else if (ts.isComputedPropertyName(element.propertyName)) {
      const computedKey = element.propertyName.expression;
      if (isCommonFabricKeyExpression(computedKey, context, "SELF")) {
        directKeyExpression = context.cfHelpers.getHelperExpr("SELF");
      } else {
        const staticKey = getEmitSafeComputedKeyText(computedKey, context);
        if (staticKey !== undefined) {
          key = staticKey;
        } else {
          key = getKnownComputedKeyExpression(computedKey, context) ??
            computedKey;
        }
      }
    } else {
      unsupported.push(
        "Unsupported destructuring key in pattern context; use explicit input.key(...).",
      );
      continue;
    }

    const nextPath = key === undefined ? path : [...path, key];
    if (element.initializer) {
      const defaultType = getStaticDefaultTypeNode(
        element.initializer,
        context,
      );
      if (!defaultType) {
        unsupported.push(
          "Non-static destructuring initializers are not lowerable in pattern context; use a static literal default or move defaulting into computed().",
        );
        continue;
      }

      const defaultPath = toStringPath(nextPath);
      if (!defaultPath) {
        unsupported.push(
          "Defaults on dynamic destructuring keys are not lowerable in pattern context; move defaulting into computed().",
        );
        continue;
      }
      defaults.push({
        path: defaultPath,
        defaultType,
      });
    }

    if (ts.isIdentifier(element.name)) {
      bindings.push({
        localName: element.name.text,
        path: nextPath,
        directKeyExpression,
        bindingNode: element,
      });
      continue;
    }

    if (directKeyExpression) {
      unsupported.push(
        "Nested SELF destructuring is not lowerable in pattern context.",
      );
      continue;
    }

    collectDestructureBindings(
      element.name,
      nextPath,
      bindings,
      defaults,
      unsupported,
      context,
    );
  }
}

export function createKeyCall(
  receiver: ts.Expression,
  path: readonly PathSegment[],
  factory: ts.NodeFactory,
): ts.Expression {
  const keyCall = factory.createCallExpression(
    factory.createPropertyAccessExpression(
      receiver,
      factory.createIdentifier("key"),
    ),
    undefined,
    path.map((segment) =>
      typeof segment === "string"
        ? factory.createStringLiteral(segment)
        : cloneKeyExpression(segment, factory)
    ),
  );
  return keyCall;
}
