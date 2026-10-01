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
 * collection callback as the properties it copies, and reports a spread of a
 * capture it cannot rewrite.
 *
 * A callback lowered to `mapWithPattern()` and its siblings reads each capture
 * through its `params`, as an opaque reference. An opaque reference has no own
 * keys, so `{ ...records }` spreads nothing there, even though `records` is a
 * plain object where it is declared. Where that declaration is a `const`
 * whose keys are known when the code is compiled — an object literal whose
 * keys are all static, an alias of one, or a literal that spreads one — those
 * keys are exactly what the spread copies, and `{ log: records.key("log") }`
 * reads each one through the reference instead.
 *
 * This rewrites every spread in `body`, outside any function nested in it,
 * whose operand is a capture of `callback` named in `capturedNames` and
 * declared that way. A spread of any other capture copies nothing when it
 * runs, and nothing else reports it, so it is left as it is with a diagnostic
 * (`reportUnexpandedSpread`). A spread of anything but a capture is left as
 * it is.
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
    const properties = visited.properties.flatMap((
      property,
    ): ts.ObjectLiteralElementLike[] => {
      if (!ts.isSpreadAssignment(property)) {
        return [property];
      }

      const operand = property.expression;
      if (!ts.isIdentifier(operand) || !capturedNames.has(operand.text)) {
        return [property];
      }

      const keys = staticKeysOfCapturedObject(operand, callback, context);
      if (!keys) {
        reportUnexpandedSpread(property, operand, context);
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
type StaticKey = ts.Identifier | ts.StringLiteral | ts.NumericLiteral;

/**
 * Helper for `expandCapturedObjectSpreads()`, which returns the keys of the
 * object `operand` names, or `undefined` if `operand` does not name a `const`
 * declared outside `callback` and outside module scope whose keys
 * `staticKeysOfInitializer()` can read.
 */
function staticKeysOfCapturedObject(
  operand: ts.Identifier,
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
): StaticKey[] | undefined {
  const authored = ts.getOriginalNode(operand);
  // deno-coverage-ignore-start -- no stage before this one stands an
  // identifier in for another kind of node inside a collection callback
  if (!ts.isIdentifier(authored)) {
    return undefined;
  }
  // deno-coverage-ignore-stop

  const declaration = constDeclarationOf(authored, context);
  if (
    !declaration ||
    isModuleScopedDeclaration(declaration) ||
    isDeclaredWithinFunction(declaration, callback)
  ) {
    return undefined;
  }

  return staticKeysOfInitializer(declaration.initializer, context, new Set());
}

/**
 * Helper for `staticKeysOfCapturedObject()`, which returns the keys of the
 * object `initializer` evaluates to, when they are known when the code is
 * compiled: an object literal holding nothing but properties with static keys
 * (identifiers, string literals, or numeric literals) and spreads of such
 * objects, or a `const` that names one, at any depth. A `__proto__:`
 * assignment sets the prototype and contributes no key. Returns `undefined`
 * for anything else, a call or a computed key say, and for a declaration
 * reached twice.
 */
function staticKeysOfInitializer(
  initializer: ts.Expression,
  context: TransformationContext,
  seen: Set<ts.VariableDeclaration>,
): StaticKey[] | undefined {
  const expression = unwrapExpression(initializer);

  if (ts.isIdentifier(expression)) {
    const declaration = constDeclarationOf(expression, context);
    if (!declaration || seen.has(declaration)) {
      return undefined;
    }
    seen.add(declaration);
    return staticKeysOfInitializer(declaration.initializer, context, seen);
  }

  if (!ts.isObjectLiteralExpression(expression)) {
    return undefined;
  }

  const keys: StaticKey[] = [];
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = staticKeysOfInitializer(
        property.expression,
        context,
        seen,
      );
      if (!spread) {
        return undefined;
      }
      keys.push(...spread);
      continue;
    }

    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      return undefined;
    }

    const name = property.name;
    if (
      !ts.isIdentifier(name) && !ts.isStringLiteral(name) &&
      !ts.isNumericLiteral(name)
    ) {
      return undefined;
    }

    // `__proto__: x` sets the prototype rather than making a property, so a
    // spread has nothing of it to copy. The shorthand `{ __proto__ }` does
    // make one, and `copyKey()` keeps it an own property.
    if (ts.isPropertyAssignment(property) && name.text === "__proto__") {
      continue;
    }

    keys.push(name);
  }

  return keys;
}

/**
 * The `const` declaration, with an initializer, that `identifier` names, or
 * `undefined` for any other binding.
 */
function constDeclarationOf(
  identifier: ts.Identifier,
  context: TransformationContext,
): (ts.VariableDeclaration & { initializer: ts.Expression }) | undefined {
  const declaration = context.checker.getSymbolAtLocation(identifier)
    ?.valueDeclaration;
  return declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0
    ? declaration as ts.VariableDeclaration & { initializer: ts.Expression }
    : undefined;
}

/**
 * Helper for `expandCapturedObjectSpreads()`, which copies a static key. A key
 * named `__proto__` is written as a computed name, the one form in which an
 * object literal makes it an own property rather than setting the prototype.
 */
function copyKey(key: StaticKey, factory: ts.NodeFactory): ts.PropertyName {
  if (key.text === "__proto__") {
    return factory.createComputedPropertyName(
      factory.createStringLiteral(key.text),
    );
  }

  if (ts.isNumericLiteral(key)) {
    return factory.createNumericLiteral(key.text);
  }

  return ts.isIdentifier(key)
    ? factory.createIdentifier(key.text)
    : factory.createStringLiteral(key.text);
}

/**
 * Helper for `expandCapturedObjectSpreads()`, which reports a spread of a
 * capture whose keys are not known when the code is compiled. The report goes
 * through `reportDiagnosticOnce()` under the pattern-context computation type,
 * on the authored spread, so that the pattern-context check that runs later
 * (`pattern-body-reactive-root-lowering.ts`), which reports the same spread
 * when the capture is a tracked opaque value, adds nothing to it.
 */
function reportUnexpandedSpread(
  spread: ts.SpreadAssignment,
  operand: ts.Identifier,
  context: TransformationContext,
): void {
  context.reportDiagnosticOnce({
    severity: "error",
    type: "pattern-context:computation",
    message:
      `Spread of the captured value \`${operand.text}\` copies nothing: the callback reads a capture as an opaque reference, which has no keys. Declare \`${operand.text}\` as a \`const\` initialized with an object literal whose keys are static, or build the object outside the callback.`,
    node: ts.getOriginalNode(spread),
  });
}
