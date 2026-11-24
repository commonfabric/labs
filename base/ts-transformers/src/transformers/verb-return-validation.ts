/**
 * Verb Return Validation Transformer (verb contract WS-C/C2)
 *
 * Reports a compile-time error when an `action(...)` or `handler(...)` block
 * body contains an explicit `return <expr>` while the verb declares no
 * result.
 *
 * A result is opt-in by explicit type argument — `action<Event, Result>` /
 * `handler<Event, State, Result>` — never inferred (api `ActionFunction` /
 * `HandlerFunction`). The void overloads therefore absorb every callback.
 * That is deliberate for concise arrow bodies: in
 * `action((id) => selected.set(id))` the completion value is the cell
 * (`Cell.set` returns it) and nobody wrote a verb result, so a concise body
 * never errors here. But the same absorption means a deliberate
 * `return { ... }` statement under a void declaration produces a value no
 * caller is ever told about — the verb's contract says nothing — and the
 * type system cannot object — any value is assignable to a void-returning signature.
 * This validator reads the body and raises what the checker cannot.
 *
 * A bare `return;` and `return undefined;` stay legal: they are control
 * flow, not a discarded result.
 *
 * Only DEFINITELY-PLAIN-SHAPED returns are judged: object and array
 * literals, string/number/boolean literals, template strings, and
 * concatenation/arithmetic over them — the shapes a forgotten result
 * declaration actually takes (`return { topic: piece }`). Everything else —
 * calls, identifiers, JSX — is exempt, because it is either an established
 * idiom the runtime consumes without a declaration (returning
 * `navigateTo(piece)`, a freshly created piece, or rendered UI — the launch
 * branch of `handleJavaScriptHandlerResult`) or a value this validator
 * cannot classify without flow analysis. Types cannot help here: the
 * authored surface renders `Reactive<T>` transparently, so `navigateTo(...)`
 * types as plain `boolean` — syntax is the only honest signal. Conservative
 * and documented beats clever and silent.
 */

import ts from "typescript";

import {
  unwrapExpression,
  unwrapTransparentWrapperOnce,
} from "../utils/expression.ts";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import {
  declaredVerbResultTypeNode,
  detectCallKind,
  type VerbBuilderName,
} from "../ast/call-kind.ts";
import { visitEachChildWithJsx } from "../ast/utils.ts";

const DECLARE_HINT: Record<VerbBuilderName, string> = {
  action: "action<Event, Result>(...)",
  handler: "handler<Event, State, Result>(...)",
};

export class VerbReturnValidationTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const checker = context.checker;

    const visit = (node: ts.Node): ts.Node => {
      if (ts.isCallExpression(node)) {
        const callKind = detectCallKind(node, checker);
        if (
          callKind?.kind === "builder" &&
          (callKind.builderName === "action" ||
            callKind.builderName === "handler")
        ) {
          this.#validateVoidDeclaredBody(node, callKind.builderName, context);
        }
      }
      // JSX-aware: the stock visitor skips `JsxExpression.expression`, which
      // would silently exempt verbs authored inline in JSX attributes.
      return visitEachChildWithJsx(node, visit, context.tsContext);
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }

  #validateVoidDeclaredBody(
    call: ts.CallExpression,
    builderName: VerbBuilderName,
    context: TransformationContext,
  ): void {
    if (declaredVerbResultTypeNode(call, builderName)) return;

    const callback = verbCallback(call);
    // Concise (expression) bodies never error: absorbing their completion
    // value is the recorded decision that keeps incidental returns from
    // declaring results nobody wrote.
    if (!callback || !ts.isBlock(callback.body)) return;

    for (const offending of topLevelValueReturns(callback.body)) {
      if (!isDefinitelyPlainShaped(offending.expression!)) continue;
      context.reportDiagnostic({
        severity: "error",
        type: "verb-result:undeclared-return",
        message:
          `This ${builderName} body returns a value, but the verb declares ` +
          `no result — nothing tells a caller this value exists. Declare the ` +
          `result by naming the type arguments — ${
            DECLARE_HINT[builderName]
          } — or use a bare \`return;\` for an early exit.`,
        node: offending,
      });
    }
  }
}

/**
 * The verb body: the call's single function-shaped argument. Every authored
 * form — `action(cb)`, `handler(cb)`, `handler(eventSchema, stateSchema, cb)`
 * — carries exactly one; anything else is a shape this validator does not
 * judge.
 */
function verbCallback(
  call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  // Each argument is resolved through the transparent wrapper set first: a
  // wrapped callback is still the verb body, and leaving it unresolved hides
  // the body from this validator entirely rather than judging it differently.
  const fns = call.arguments
    .map((arg) => unwrapExpression(arg))
    .filter(
      (arg): arg is ts.ArrowFunction | ts.FunctionExpression =>
        ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
    );
  return fns.length === 1 ? fns[0] : undefined;
}

/**
 * The shapes a forgotten result declaration actually takes: expressions that
 * are plain data by construction. Calls, identifiers, property reads, JSX,
 * `new`, and anything else stay unjudged — those are the launch/navigation/
 * render idioms, or values whose provenance this validator does not assert.
 * An `any` assertion anywhere below opts the expression out.
 */
function isDefinitelyPlainShaped(expr: ts.Expression): boolean {
  // An assertion to `any` opts the expression out, whichever form carries it.
  // That rule is stated once, before the wrapper set is stepped through, so a
  // wrapper spelling added later cannot slip past it.
  if (
    (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) ||
      ts.isTypeAssertionExpression(expr)) &&
    expr.type.kind === ts.SyntaxKind.AnyKeyword
  ) {
    return false;
  }
  const unwrappedExpr = unwrapTransparentWrapperOnce(expr);
  if (unwrappedExpr) {
    return isDefinitelyPlainShaped(unwrappedExpr);
  }
  if (ts.isConditionalExpression(expr)) {
    return isDefinitelyPlainShaped(expr.whenTrue) &&
      isDefinitelyPlainShaped(expr.whenFalse);
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    // `return -1` is a numeric literal in spirit; sign (and unary plus) do
    // not change plainness.
    return (expr.operator === ts.SyntaxKind.MinusToken ||
      expr.operator === ts.SyntaxKind.PlusToken) &&
      isDefinitelyPlainShaped(expr.operand);
  }
  if (ts.isBinaryExpression(expr)) {
    // Concatenation / arithmetic over plain operands is plain; comparison,
    // logical, and assignment operators produce values this validator does
    // not judge.
    const arithmetic = new Set<ts.SyntaxKind>([
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.AsteriskToken,
      ts.SyntaxKind.SlashToken,
      ts.SyntaxKind.PercentToken,
    ]);
    if (!arithmetic.has(expr.operatorToken.kind)) return false;
    return isDefinitelyPlainShaped(expr.left) ||
      isDefinitelyPlainShaped(expr.right);
  }
  return ts.isObjectLiteralExpression(expr) ||
    ts.isArrayLiteralExpression(expr) ||
    ts.isStringLiteralLike(expr) ||
    ts.isTemplateExpression(expr) ||
    ts.isNumericLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword;
}

/**
 * `return <expr>` statements that return from the verb body itself — nested
 * function-likes return to their own callers and are not descended into. The
 * literal `undefined` counts as control flow, not a value.
 */
function topLevelValueReturns(body: ts.Block): ts.ReturnStatement[] {
  const found: ts.ReturnStatement[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      const expr = node.expression;
      if (expr && !(ts.isIdentifier(expr) && expr.text === "undefined")) {
        found.push(node);
      }
    }
    node.forEachChild(walk);
  };
  body.forEachChild(walk);
  return found;
}
