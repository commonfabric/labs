import ts from "typescript";

import { getCallArgumentPosition } from "../ast/call-arguments.ts";
import {
  classifyArrayCallbackContainerCall,
  detectCallKind,
  getPatternBuilderCallbackArgument,
  getPatternToolCallbackArgument,
  isCollectingPlainArrayMethodCallback,
} from "../ast/call-kind.ts";
import { isEventHandlerJsxAttribute } from "../ast/event-handlers.ts";
import { outermostTransparentWrapper } from "../utils/expression.ts";

export interface CallbackBoundaryLookup {
  isArrayMethodCallback(node: ts.Node): boolean;
  isSourceFileDefaultLibrary(sourceFile: ts.SourceFile): boolean;
}

export type SupportedCallbackBoundaryKind =
  | "event-handler"
  | "reactive-array-method"
  | "plain-array-value"
  | "pattern-builder"
  | "render-builder"
  | "lift-applied"
  | "pattern-tool"
  | "computed-builder"
  | "action-builder"
  | "lift-builder"
  | "handler-builder"
  | "sqlite-row-label-rule";

export type UnsupportedCallbackBoundaryKind =
  | "plain-array-void"
  | "unsupported-container";

type CallbackBoundaryBodyContext =
  | { strategy: "inherit-parent" }
  | {
    strategy: "explicit";
    kind: "pattern" | "compute";
    owner:
      | "pattern"
      | "render"
      | "array-method"
      | "computed"
      | "lift-applied"
      | "action"
      | "lift"
      | "handler"
      | "unknown";
  };

export type CallbackBoundaryDecision =
  | { kind: "none" }
  | {
    kind: "supported";
    boundaryKind: SupportedCallbackBoundaryKind;
    bodyContext: CallbackBoundaryBodyContext;
  }
  | {
    kind: "unsupported";
    boundaryKind: UnsupportedCallbackBoundaryKind;
    bodyContext: CallbackBoundaryBodyContext;
    boundaryDiagnostic: "callback-container" | "function-creation";
  };

export interface CallbackBoundarySemantics {
  readonly decision: CallbackBoundaryDecision;
  readonly bodyContext: CallbackBoundaryBodyContext | undefined;
  readonly isReactiveArrayMethodCallback: boolean;
  readonly isPlainArrayValueCallback: boolean;
  readonly isPatternToolCallback: boolean;
  readonly supportsPatternOwnedWrapperCallbackSite: boolean;
  readonly supportsPatternOwnedStatements: boolean;
  readonly allowsRestrictedContextFunctionCallback: boolean;
  readonly establishesLocalReactiveAliasScope: boolean;
}

function isWithinJsxExpression(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isJsxExpression(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/** True when `callee` is the SQLite `table()` builder (the `commonfabric`
 *  export or `cfSqlite.table`) — recognized by name plus the
 *  `SqliteTableFunction` type alias, so local rebinding keeps working and an
 *  unrelated user function named `table` does not match. */
function isSqliteTableCallee(
  callee: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : undefined;
  if (name !== "table") return false;
  const type = checker.getTypeAtLocation(callee);
  const alias = type.aliasSymbol;
  if (!alias || alias.name !== "SqliteTableFunction") return false;
  // The alias must be declared by Common Fabric's own typings (the api
  // package in-repo, the bundled commonfabric d.ts in the pattern compile
  // env) — a user-defined alias of the same name must not steer boundary
  // classification.
  return (alias.getDeclarations() ?? []).some((decl) => {
    const file = decl.getSourceFile().fileName.replace(/\\/g, "/");
    return file.endsWith("/api/index.ts") ||
      file.endsWith("commonfabric.d.ts") ||
      file.includes("/@commonfabric/api/");
  });
}

/**
 * True when `patternCall` (a `pattern(...)` call) is the first argument of an
 * enclosing `patternTool(...)` call — the canonical CT-1655 shape
 * `patternTool(pattern(cb), extraParams?)`. Used to give such a pattern's
 * callback a patternTool boundary (function creation allowed in the
 * surrounding restricted context) rather than the restricted pattern-builder
 * boundary a bare `pattern(...)` gets.
 */
function isPatternToolPatternArgument(
  patternCall: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const position = getCallArgumentPosition(patternCall);
  if (!position || position.index !== 0) {
    return false;
  }
  return detectCallKind(position.call, checker)?.kind === "pattern-tool";
}

export function classifyCallbackBoundary(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  lookup?: CallbackBoundaryLookup,
): CallbackBoundaryDecision {
  // The attribute holds the outermost wrapper around the callback, so the
  // JSX lookup starts from the usage site rather than the callback itself.
  const jsxParent = outermostTransparentWrapper(callback).parent;
  if (
    ts.isJsxExpression(jsxParent) &&
    ts.isJsxAttribute(jsxParent.parent) &&
    isEventHandlerJsxAttribute(jsxParent.parent, checker)
  ) {
    return {
      kind: "supported",
      boundaryKind: "event-handler",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "handler",
      },
    };
  }

  const position = getCallArgumentPosition(callback);
  if (!position) {
    return { kind: "none" };
  }
  const parent = position.call;

  if (lookup?.isArrayMethodCallback(callback)) {
    return {
      kind: "supported",
      boundaryKind: "reactive-array-method",
      bodyContext: {
        strategy: "explicit",
        kind: "pattern",
        owner: "array-method",
      },
    };
  }

  const callKind = detectCallKind(parent, checker);
  if (callKind?.kind === "lift-applied") {
    return {
      kind: "supported",
      boundaryKind: "lift-applied",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "lift-applied",
      },
    };
  }

  if (callKind?.kind === "pattern-tool") {
    return {
      kind: "supported",
      boundaryKind: "pattern-tool",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "unknown",
      },
    };
  }

  // SQLite per-row label rule: `table(columns, (f) => ({…}))` — also reached
  // via `cfSqlite.table`. `table()` evaluates the rule EAGERLY at pattern
  // build time into a serialized plain-JSON AST (CFC Phase 3), so the
  // callback is a compute-owned boundary like lift-applied: legitimate inside
  // a pattern body, never a reactive closure.
  if (
    position.index === 1 &&
    isSqliteTableCallee(parent.expression, checker)
  ) {
    return {
      kind: "supported",
      boundaryKind: "sqlite-row-label-rule",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "unknown",
      },
    };
  }

  if (callKind?.kind === "builder") {
    switch (callKind.builderName) {
      case "pattern":
        // A `pattern(...)` that is itself the first argument of a
        // `patternTool(...)` call is the canonical patternTool shape (CT-1655):
        // authoring it inside a pattern body is legitimate, so its callback
        // gets the same boundary as a directly-passed patternTool callback —
        // allowing function creation in the surrounding restricted context.
        // A bare `pattern(...)` (not a patternTool argument) keeps the
        // restricted `pattern-builder` boundary below.
        if (isPatternToolPatternArgument(parent, checker)) {
          return {
            kind: "supported",
            boundaryKind: "pattern-tool",
            bodyContext: {
              strategy: "explicit",
              kind: "compute",
              owner: "unknown",
            },
          };
        }
        return {
          kind: "supported",
          boundaryKind: "pattern-builder",
          bodyContext: {
            strategy: "explicit",
            kind: "pattern",
            owner: "pattern",
          },
        };
      case "render":
        return {
          kind: "supported",
          boundaryKind: "render-builder",
          bodyContext: {
            strategy: "explicit",
            kind: "pattern",
            owner: "render",
          },
        };
      case "computed":
        return {
          kind: "supported",
          boundaryKind: "computed-builder",
          bodyContext: {
            strategy: "explicit",
            kind: "compute",
            owner: "computed",
          },
        };
      case "action":
        return {
          kind: "supported",
          boundaryKind: "action-builder",
          bodyContext: {
            strategy: "explicit",
            kind: "compute",
            owner: "action",
          },
        };
      case "lift":
        return {
          kind: "supported",
          boundaryKind: "lift-builder",
          bodyContext: {
            strategy: "explicit",
            kind: "compute",
            owner: "lift",
          },
        };
      case "handler":
        return {
          kind: "supported",
          boundaryKind: "handler-builder",
          bodyContext: {
            strategy: "explicit",
            kind: "compute",
            owner: "handler",
          },
        };
    }
  }

  const arrayCallbackContainer = classifyArrayCallbackContainerCall(
    parent,
    checker,
  );
  switch (arrayCallbackContainer) {
    case "reactive-array-method":
      return {
        kind: "supported",
        boundaryKind: "reactive-array-method",
        bodyContext: { strategy: "inherit-parent" },
      };
    case "plain-array-value":
      return {
        kind: "supported",
        boundaryKind: "plain-array-value",
        bodyContext: { strategy: "inherit-parent" },
      };
    case "plain-array-void":
      return isWithinJsxExpression(callback)
        ? {
          kind: "unsupported",
          boundaryKind: "plain-array-void",
          boundaryDiagnostic: "callback-container",
          bodyContext: {
            strategy: "explicit",
            kind: "compute",
            owner: "unknown",
          },
        }
        : {
          kind: "unsupported",
          boundaryKind: "plain-array-void",
          boundaryDiagnostic: "function-creation",
          bodyContext: { strategy: "inherit-parent" },
        };
  }

  if (getPatternBuilderCallbackArgument(parent, checker) === callback) {
    return {
      kind: "supported",
      boundaryKind: "pattern-builder",
      bodyContext: {
        strategy: "explicit",
        kind: "pattern",
        owner: "pattern",
      },
    };
  }

  if (getPatternToolCallbackArgument(parent, checker) === callback) {
    return {
      kind: "supported",
      boundaryKind: "pattern-tool",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "unknown",
      },
    };
  }

  if (isWithinJsxExpression(callback)) {
    return {
      kind: "unsupported",
      boundaryKind: "unsupported-container",
      boundaryDiagnostic: "callback-container",
      bodyContext: {
        strategy: "explicit",
        kind: "compute",
        owner: "unknown",
      },
    };
  }

  return {
    kind: "unsupported",
    boundaryKind: "unsupported-container",
    boundaryDiagnostic: "function-creation",
    bodyContext: { strategy: "inherit-parent" },
  };
}

export function getCallbackBoundarySemantics(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  checker: ts.TypeChecker,
  lookup?: CallbackBoundaryLookup,
): CallbackBoundarySemantics {
  const decision = classifyCallbackBoundary(callback, checker, lookup);
  const bodyContext = decision.kind === "none"
    ? undefined
    : decision.bodyContext;
  const supportedKind = decision.kind === "supported"
    ? decision.boundaryKind
    : undefined;

  return {
    decision,
    bodyContext,
    isReactiveArrayMethodCallback: supportedKind === "reactive-array-method",
    isPlainArrayValueCallback: supportedKind === "plain-array-value",
    isPatternToolCallback: supportedKind === "pattern-tool",
    supportsPatternOwnedWrapperCallbackSite: supportedKind ===
        "reactive-array-method" ||
      (supportedKind === "plain-array-value" &&
        !!lookup &&
        isCollectingPlainArrayMethodCallback(
          callback,
          checker,
          (sourceFile) => lookup.isSourceFileDefaultLibrary(sourceFile),
        )) ||
      supportedKind === "pattern-builder" ||
      supportedKind === "render-builder",
    supportsPatternOwnedStatements: supportedKind === "reactive-array-method" ||
      supportedKind === "pattern-builder" ||
      supportedKind === "render-builder",
    allowsRestrictedContextFunctionCallback: !!supportedKind &&
      supportedKind !== "event-handler" &&
      supportedKind !== "pattern-builder" &&
      supportedKind !== "render-builder",
    establishesLocalReactiveAliasScope: supportedKind === "lift-applied" ||
      supportedKind === "computed-builder",
  };
}
