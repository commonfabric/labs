import ts from "typescript";
import { getCallArgumentPosition } from "./call-arguments.ts";
import {
  classifyArrayMethodCall,
  detectCallKind,
  isConsumedByTerminalChainCall,
} from "./call-kind.ts";
import { getCallbackBoundarySemantics } from "../policy/callback-boundary.ts";

export type ReactiveContextKind = "pattern" | "compute" | "neutral";

export type ReactiveContextOwner =
  | "pattern"
  | "render"
  | "array-method"
  | "computed"
  | "lift-applied"
  | "action"
  | "lift"
  | "handler"
  | "standalone"
  | "unknown";

export interface ReactiveContextInfo {
  readonly kind: ReactiveContextKind;
  readonly owner: ReactiveContextOwner;
  readonly inJsxExpression: boolean;
}

export interface ReactiveContextLookup {
  isArrayMethodCallback(node: ts.Node): boolean;
  isSourceFileDefaultLibrary?(sourceFile: ts.SourceFile): boolean;
  isSyntheticComputeCallback?(node: ts.Node): boolean;
  isSyntheticComputeOwnedNode?(node: ts.Node): boolean;
}

/**
 * Builder names that establish a pattern context where opaque reading and
 * computation lowering rules apply.
 */
export const RESTRICTED_CONTEXT_BUILDERS = new Set([
  "pattern",
  "render",
]);

/**
 * Builder names that establish compute context.
 *
 * NOTE: this set currently has no consumers in the repo (it is exported from
 * ast/mod.ts but never read). Left in place pending a separate dead-export
 * audit; the former `"derive"` entry was removed here as part of retiring
 * `derive` (CT-1643) — derive is no longer a recognized builder name.
 */
export const SAFE_WRAPPER_BUILDERS = new Set([
  "computed",
  "action",
  "lift",
  "handler",
]);

export interface CallbackContext {
  callback: ts.ArrowFunction | ts.FunctionExpression;
  call: ts.CallExpression;
}

function resolveContextAnchor(node: ts.Node): ts.Node {
  const original = ts.getOriginalNode(node);
  if (original && original !== node && original.parent) {
    return original;
  }
  return node;
}

function getMarkedSyntheticCallbackContext(
  node: ts.Node,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): ReactiveContextInfo | undefined {
  let current: ts.Node | undefined = node.parent;
  let inJsxExpression = false;

  while (current) {
    if (ts.isJsxExpression(current)) {
      inJsxExpression = true;
    }

    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      if (lookup?.isArrayMethodCallback(current)) {
        return { kind: "pattern", owner: "array-method", inJsxExpression };
      }

      // A terminal receiver chain runs its callbacks as values inside its
      // lift, before an enclosing collection callback's pattern boundary.
      const position = getCallArgumentPosition(current);
      if (
        position?.index === 0 && classifyArrayMethodCall(position.call) &&
        isConsumedByTerminalChainCall(position.call)
      ) {
        return { kind: "compute", owner: "unknown", inJsxExpression };
      }

      if (lookup?.isSyntheticComputeCallback?.(current)) {
        const position = getCallArgumentPosition(current);
        if (position) {
          const callKind = detectCallKind(position.call, checker);
          if (callKind?.kind === "lift-applied") {
            return { kind: "compute", owner: "lift-applied", inJsxExpression };
          }
          if (callKind?.kind === "builder") {
            const builderContext = getBuilderContext(callKind.builderName);
            if (builderContext) {
              return { ...builderContext, inJsxExpression };
            }
          }
        }
        return { kind: "compute", owner: "unknown", inJsxExpression };
      }
    }

    current = current.parent;
  }

  return undefined;
}

export function findEnclosingCallbackContext(
  node: ts.Node,
): CallbackContext | undefined {
  let current: ts.Node | undefined = resolveContextAnchor(node).parent;
  while (current) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const position = getCallArgumentPosition(current);
      if (position) {
        return { callback: current, call: position.call };
      }
    }
    current = current.parent;
  }
  return undefined;
}

export function isStandaloneFunctionDefinition(
  func: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
): boolean {
  if (ts.isFunctionDeclaration(func)) {
    return true;
  }

  // Parentheses around the function are spelling: `const f = ((x) => x)`
  // defines the same standalone function as the bare initializer, and must
  // reach the same standalone validation and context classification.
  let parent: ts.Node | undefined = func.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    parent = parent.parent;
  }
  if (!parent) return false;
  if (ts.isVariableDeclaration(parent)) return true;
  if (ts.isPropertyAssignment(parent)) return true;
  // Everything else — call arguments, JSX expressions, operands — is an
  // inline use, owned by whatever consumes it.
  return false;
}

function getBuilderContext(
  builderName: string,
): { kind: ReactiveContextKind; owner: ReactiveContextOwner } | undefined {
  if (builderName === "pattern") {
    return { kind: "pattern", owner: "pattern" };
  }
  if (builderName === "render") {
    return { kind: "pattern", owner: "render" };
  }
  if (builderName === "computed") {
    return { kind: "compute", owner: "computed" };
  }
  if (builderName === "action") {
    return { kind: "compute", owner: "action" };
  }
  if (builderName === "lift") {
    return { kind: "compute", owner: "lift" };
  }
  if (builderName === "handler") {
    return { kind: "compute", owner: "handler" };
  }
  return undefined;
}

/**
 * Classifies the effective context at a node.
 *
 * Rule: nearest known CT callback boundary wins; unknown callbacks inherit the
 * parent context by continuing the ancestor scan.
 */
export function classifyReactiveContext(
  node: ts.Node,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): ReactiveContextInfo {
  const classifyFromAnchor = (anchor: ts.Node): ReactiveContextInfo => {
    const markedSyntheticContext = getMarkedSyntheticCallbackContext(
      anchor,
      checker,
      lookup,
    );
    if (markedSyntheticContext) {
      return markedSyntheticContext;
    }

    let current: ts.Node | undefined = anchor.parent;
    let inJsxExpression = false;

    while (current) {
      if (ts.isJsxExpression(current)) {
        inJsxExpression = true;
      }

      if (ts.isFunctionDeclaration(current)) {
        if (isStandaloneFunctionDefinition(current)) {
          return { kind: "compute", owner: "standalone", inJsxExpression };
        }
      }

      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        if (isStandaloneFunctionDefinition(current)) {
          return { kind: "compute", owner: "standalone", inJsxExpression };
        }

        const boundarySemantics = getCallbackBoundarySemantics(
          current,
          checker,
          {
            isArrayMethodCallback: (node) =>
              lookup?.isArrayMethodCallback(node) ?? false,
            isSourceFileDefaultLibrary: (sourceFile) =>
              lookup?.isSourceFileDefaultLibrary?.(sourceFile) ?? false,
          },
        );
        const bodyContext = boundarySemantics.bodyContext;
        if (bodyContext) {
          if (bodyContext.strategy === "inherit-parent") {
            current = current.parent;
            continue;
          }

          return {
            kind: bodyContext.kind,
            owner: bodyContext.owner,
            inJsxExpression,
          };
        }
      }

      current = current.parent;
    }

    return {
      kind: "neutral",
      owner: "unknown",
      inJsxExpression,
    };
  };

  const currentContext = classifyFromAnchor(node);
  if (
    currentContext.kind === "pattern" &&
    currentContext.owner !== "array-method" &&
    lookup?.isSyntheticComputeOwnedNode?.(node)
  ) {
    return {
      kind: "compute",
      owner: "unknown",
      inJsxExpression: currentContext.inJsxExpression,
    };
  }
  if (currentContext.kind !== "neutral") {
    return currentContext;
  }

  const anchor = resolveContextAnchor(node);
  if (anchor !== node) {
    const anchorContext = classifyFromAnchor(anchor);
    if (
      anchorContext.kind === "pattern" &&
      anchorContext.owner !== "array-method" &&
      lookup?.isSyntheticComputeOwnedNode?.(anchor)
    ) {
      return {
        kind: "compute",
        owner: "unknown",
        inJsxExpression: anchorContext.inJsxExpression,
      };
    }
    return anchorContext;
  }

  return currentContext;
}

export function isInsideSafeCallbackWrapper(
  node: ts.Node,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): boolean {
  const info = classifyReactiveContext(node, checker, lookup);
  return info.kind === "compute";
}

export function isInsideSafeWrapper(
  node: ts.Node,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): boolean {
  const info = classifyReactiveContext(node, checker, lookup);
  return info.kind === "compute" || info.inJsxExpression;
}

export function isInsideRestrictedContext(
  node: ts.Node,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): boolean {
  const info = classifyReactiveContext(node, checker, lookup);
  return info.kind === "pattern";
}

export function isInRestrictedReactiveContext(
  node: ts.Node,
  checker: ts.TypeChecker,
  lookup?: ReactiveContextLookup,
): boolean {
  const info = classifyReactiveContext(node, checker, lookup);
  return info.kind === "pattern" && !info.inJsxExpression;
}
