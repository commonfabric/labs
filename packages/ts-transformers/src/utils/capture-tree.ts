import ts from "typescript";

import { unwrapExpression } from "./expression.ts";
import { isSafeIdentifierText } from "./identifiers.ts";

export interface CapturePathInfo {
  readonly root: string;
  readonly path: readonly string[];
  readonly expression: ts.Expression;
}

export interface CaptureTreeNode {
  readonly properties: Map<string, CaptureTreeNode>;
  readonly path: readonly string[];
  expression?: ts.Expression;
}

export function parseCaptureExpression(
  expr: ts.Expression,
): CapturePathInfo | undefined {
  // Unwrap non-semantic wrappers (parens, `as`, type assertions, `satisfies`,
  // `!`, partially-emitted) so wrapped reads like `(entry).name` and
  // `entry!.name` parse the same way as the bare form. Without this, the
  // capture would fall into the unstructured "fallback" bucket downstream
  // and lose its partial-key dataflow shape.
  const unwrapped = unwrapExpression(expr);

  if (ts.isIdentifier(unwrapped)) {
    return { root: unwrapped.text, path: [], expression: expr };
  }

  if (ts.isCallExpression(unwrapped)) {
    const callee = unwrapped.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "key"
    ) {
      const receiver = parseCaptureExpression(callee.expression);
      if (!receiver) {
        return undefined;
      }

      const keySegments: string[] = [];
      for (const arg of unwrapped.arguments) {
        if (
          ts.isStringLiteralLike(arg) ||
          ts.isNumericLiteral(arg) ||
          ts.isNoSubstitutionTemplateLiteral(arg)
        ) {
          keySegments.push(arg.text);
          continue;
        }
        return undefined;
      }

      return {
        root: receiver.root,
        path: [...receiver.path, ...keySegments],
        expression: expr,
      };
    }
  }

  if (
    ts.isPropertyAccessExpression(unwrapped) ||
    ts.isElementAccessExpression(unwrapped)
  ) {
    const segments: string[] = [];
    let current: ts.Expression = unwrapped;

    while (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      // If we encounter optional chaining (e.g., foo?.bar), stop here and
      // capture just the expression before the optional chain.
      // This preserves nullability in the schema - the root object might be
      // null/undefined, so we shouldn't descend into its properties.
      if (
        ts.isPropertyAccessChain(current) ||
        ts.isElementAccessChain(current)
      ) {
        return parseCaptureExpression(current.expression);
      }
      if (ts.isPropertyAccessExpression(current)) {
        segments.unshift(current.name.text);
        // Unwrap at every descent step so wrappers anywhere in the chain
        // (e.g. `((entry).name).x`) don't break the walk.
        current = unwrapExpression(current.expression);
        continue;
      }

      const argument = unwrapExpression(current.argumentExpression);
      if (
        !ts.isStringLiteralLike(argument) &&
        !ts.isNumericLiteral(argument) &&
        !ts.isNoSubstitutionTemplateLiteral(argument)
      ) {
        return undefined;
      }
      segments.unshift(argument.text);
      current = unwrapExpression(current.expression);
    }

    if (ts.isIdentifier(current)) {
      return { root: current.text, path: segments, expression: expr };
    }
  }

  return undefined;
}

export function createCaptureTreeNode(
  path: readonly string[],
): CaptureTreeNode {
  return { properties: new Map(), path };
}

function ensureChildNode(
  parent: CaptureTreeNode,
  key: string,
): CaptureTreeNode {
  let child = parent.properties.get(key);
  if (!child) {
    child = createCaptureTreeNode([...parent.path, key]);
    parent.properties.set(key, child);
  }
  return child;
}

export function groupCapturesByRoot(
  captureExpressions: Iterable<ts.Expression>,
): Map<string, CaptureTreeNode> {
  const rootMap = new Map<string, CaptureTreeNode>();

  for (const expr of captureExpressions) {
    const pathInfo = parseCaptureExpression(expr);
    if (!pathInfo) continue;

    const { root, path, expression } = pathInfo;
    let rootNode = rootMap.get(root);
    if (!rootNode) {
      rootNode = createCaptureTreeNode([]);
      rootMap.set(root, rootNode);
    }

    let currentNode = rootNode;

    if (path.length === 0) {
      currentNode.expression = expression;
      currentNode.properties.clear();
      continue;
    }

    if (currentNode.expression) {
      continue;
    }

    for (const segment of path) {
      currentNode = ensureChildNode(currentNode, segment);
      if (currentNode.expression) {
        break;
      }
    }

    if (!currentNode.expression) {
      currentNode.expression = expression;
      currentNode.properties.clear();
    }
  }

  return rootMap;
}

export function createCaptureAccessExpression(
  rootName: string,
  path: readonly string[],
  factory: ts.NodeFactory,
  template?: ts.Expression,
): ts.Expression {
  if (template) {
    // Unwrap non-semantic wrappers up front so wrapped templates take the
    // same paths as bare ones. Without this, `(entry.key("piece"))` would
    // miss the key-call fast path (the call sits behind parens) and
    // `(entry).piece` would fall out of the rebuild walk because parens
    // aren't a recognized rebuild node. Both should land on the same
    // structural output as their bare-form equivalents.
    const unwrapped = unwrapExpression(template);

    if (
      ts.isCallExpression(unwrapped) &&
      ts.isPropertyAccessExpression(unwrapped.expression) &&
      unwrapped.expression.name.text === "key"
    ) {
      return unwrapped;
    }

    const rebuild = (expr: ts.Expression): ts.Expression | undefined => {
      const target = unwrapExpression(expr);
      if (ts.isIdentifier(target)) {
        return factory.createIdentifier(rootName);
      }
      if (ts.isPropertyAccessExpression(target)) {
        const inner = rebuild(target.expression);
        if (!inner) return undefined;
        if (ts.isPropertyAccessChain(target)) {
          return factory.createPropertyAccessChain(
            inner,
            factory.createToken(ts.SyntaxKind.QuestionDotToken),
            target.name,
          );
        }
        return factory.createPropertyAccessExpression(inner, target.name);
      }
      if (ts.isElementAccessExpression(target)) {
        const inner = rebuild(target.expression);
        if (!inner) return undefined;
        if (ts.isElementAccessChain(target)) {
          return factory.createElementAccessChain(
            inner,
            factory.createToken(ts.SyntaxKind.QuestionDotToken),
            target.argumentExpression,
          );
        }
        return factory.createElementAccessExpression(
          inner,
          target.argumentExpression,
        );
      }
      return undefined;
    };

    const rebuilt = rebuild(unwrapped);
    if (rebuilt) {
      return rebuilt;
    }
  }

  let expr: ts.Expression = factory.createIdentifier(rootName);
  for (const segment of path) {
    expr = factory.createPropertyAccessExpression(
      expr,
      factory.createIdentifier(segment),
    );
  }
  return expr;
}

export function buildHierarchicalParamsValue(
  node: CaptureTreeNode,
  rootName: string,
  factory: ts.NodeFactory,
): ts.Expression {
  if (node.expression && node.properties.size === 0) {
    return createCaptureAccessExpression(
      rootName,
      node.path,
      factory,
      node.expression,
    );
  }

  const assignments: ts.PropertyAssignment[] = [];
  for (const [propName, childNode] of node.properties) {
    assignments.push(
      factory.createPropertyAssignment(
        isSafeIdentifierText(propName)
          ? factory.createIdentifier(propName)
          : factory.createStringLiteral(propName),
        buildHierarchicalParamsValue(childNode, rootName, factory),
      ),
    );
  }

  if (assignments.length === 0 && node.expression) {
    return createCaptureAccessExpression(
      rootName,
      node.path,
      factory,
      node.expression,
    );
  }

  return factory.createObjectLiteralExpression(
    assignments,
    assignments.length > 0,
  );
}

export function buildCapturePropertyAssignments(
  captureTree: Iterable<[string, CaptureTreeNode]>,
  factory: ts.NodeFactory,
  renameMap?: ReadonlyMap<string, string>,
): ts.PropertyAssignment[] {
  const properties: ts.PropertyAssignment[] = [];
  for (const [rootName, node] of captureTree) {
    const propertyName = renameMap?.get(rootName) ?? rootName;
    properties.push(
      factory.createPropertyAssignment(
        isSafeIdentifierText(propertyName)
          ? factory.createIdentifier(propertyName)
          : factory.createStringLiteral(propertyName),
        buildHierarchicalParamsValue(node, rootName, factory),
      ),
    );
  }
  return properties;
}
