import ts from "typescript";

import {
  preserveLineage,
  preserveSourceMapRange,
  visitEachChildWithJsx,
} from "../../ast/mod.ts";
import {
  isDeclaredWithinFunction,
  isModuleScopedDeclaration,
} from "../../ast/scope-analysis.ts";
import type { TransformationContext } from "../../core/mod.ts";
import { unwrapExpression } from "../../utils/expression.ts";

/**
 * Rewrites a spread of a captured object literal in the body of a reactive
 * collection callback as the properties it copies.
 *
 * A callback lowered to `mapWithPattern()` and its siblings reads each capture
 * through its `params`, as an opaque reference. An opaque reference has no own
 * keys, so `{ ...records }` spreads nothing there, even though `records` is a
 * plain object where it is declared. Where that declaration is a `const`
 * initialized with an object literal whose keys are all static, those keys are
 * exactly what the spread copies, and `{ log: records.key("log") }` reads each
 * one through the reference instead.
 *
 * This rewrites every spread in `body`, outside any function nested in it,
 * whose operand is a capture of `callback` named in `capturedNames` and
 * declared that way. A spread of anything else is left as it is.
 */
export function expandCapturedObjectSpreads(
  body: ts.ConciseBody,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  capturedNames: ReadonlySet<string>,
  context: TransformationContext,
): ts.ConciseBody {
  const { factory } = context;

  const visit = (node: ts.Node): ts.Node => {
    if (ts.isFunctionLike(node)) {
      return node;
    }

    const visited = visitEachChildWithJsx(node, visit, context.tsContext);
    if (!ts.isObjectLiteralExpression(visited)) {
      return visited;
    }

    let changed = false;
    const properties = visited.properties.flatMap((property) => {
      if (!ts.isSpreadAssignment(property)) {
        return [property];
      }

      const operand = property.expression;
      const keys = ts.isIdentifier(operand) &&
          capturedNames.has(operand.text)
        ? staticKeysOfCapturedObject(operand, callback, context)
        : undefined;
      if (!keys) {
        return [property];
      }

      changed = true;
      return keys.map((key) => {
        const receiver = preserveLineage(
          factory.createIdentifier(operand.text),
          operand,
        );
        const read = factory.createCallExpression(
          factory.createPropertyAccessExpression(receiver, "key"),
          undefined,
          [factory.createStringLiteral(key.text)],
        );
        return preserveSourceMapRange(
          factory.createPropertyAssignment(copyKey(key, factory), read),
          property,
        );
      });
    });

    return changed
      ? factory.updateObjectLiteralExpression(
        visited,
        factory.createNodeArray(
          properties,
          visited.properties.hasTrailingComma,
        ),
      )
      : visited;
  };

  return ts.visitNode(body, visit) as ts.ConciseBody;
}

/** A property name whose text is known when the code is compiled. */
type StaticKey = ts.Identifier | ts.StringLiteral;

/**
 * Helper for `expandCapturedObjectSpreads()`, which returns the keys of the
 * object literal `operand` names, or `undefined` if `operand` does not name a
 * `const` declared outside `callback` and outside module scope, initialized
 * with an object literal holding nothing but properties with static keys.
 */
function staticKeysOfCapturedObject(
  operand: ts.Identifier,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
): StaticKey[] | undefined {
  const authored = ts.getOriginalNode(operand);
  if (!ts.isIdentifier(authored)) {
    return undefined;
  }

  const declaration = context.checker.getSymbolAtLocation(authored)
    ?.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0 ||
    isModuleScopedDeclaration(declaration) ||
    isDeclaredWithinFunction(declaration, callback)
  ) {
    return undefined;
  }

  const literal = unwrapExpression(declaration.initializer);
  if (!ts.isObjectLiteralExpression(literal)) {
    return undefined;
  }

  const keys: StaticKey[] = [];
  for (const property of literal.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      return undefined;
    }

    const name = property.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) {
      return undefined;
    }

    // `__proto__: x` sets the prototype rather than making a property.
    if (name.text === "__proto__") {
      return undefined;
    }

    keys.push(name);
  }

  return keys;
}

/** Helper for `expandCapturedObjectSpreads()`, which copies a static key. */
function copyKey(key: StaticKey, factory: ts.NodeFactory): StaticKey {
  return ts.isIdentifier(key)
    ? factory.createIdentifier(key.text)
    : factory.createStringLiteral(key.text);
}
