import ts from "typescript";

/**
 * The non-finite numbers have no literal form in TypeScript; they are only
 * reachable by name, through these globals.
 */
const NON_FINITE_GLOBALS = new Map<string, number>([
  ["NaN", NaN],
  ["Infinity", Infinity],
]);

/**
 * Resolve an identifier that names a non-finite global, or `undefined` if the
 * identifier is something else or is shadowed at this site.
 *
 * `NaN` and `Infinity` are ordinary `var` declarations in `lib.es5.d.ts`, so a
 * program is free to shadow either one. Ambient declarations are the globals;
 * a declaration in ordinary source means the name is bound to something else
 * here and must not be folded. (`hasNoDefaultLib` does not distinguish these:
 * only the top-level `lib.d.ts` aggregator carries that reference, not the
 * per-target lib files where these two are actually declared.)
 */
function nonFiniteFromIdentifier(
  ident: ts.Identifier,
  checker: ts.TypeChecker,
): number | undefined {
  const value = NON_FINITE_GLOBALS.get(ident.text);
  if (value === undefined) return undefined;

  const declarations = checker.getSymbolAtLocation(ident)?.declarations;
  if (declarations?.some((decl) => !decl.getSourceFile().isDeclarationFile)) {
    return undefined;
  }
  return value;
}

/**
 * Evaluate an expression that denotes a number: a bare numeric literal, a
 * sign-prefixed one, or a non-finite global. Returns `undefined` when the
 * expression denotes something else, so callers can fall through to their own
 * handling.
 *
 * Negative numbers are prefix-unary expressions rather than literals, and the
 * non-finite values are identifiers, so recognizing only `NumericLiteral`
 * leaves `-1` — the canonical sentinel default — and every non-finite value
 * inexpressible. IEEE 754 binary64 values are first-class in the value model
 * (`docs/specs/space-model-formal-spec/1-fabric-values.md` §1.3), so they must
 * survive the trip from source to schema.
 */
export function numberFromExpression(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): number | undefined {
  // Wrappers that change no value: parentheses and the type-only assertion
  // forms. A caller can strip these off the outside of what it hands over, but
  // not out of the middle -- `-(1 as number)` reaches here with the wrapper
  // still nested inside the sign, so the recursion has to know them too.
  if (
    ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) || ts.isTypeAssertionExpression(expr)
  ) {
    return numberFromExpression(expr.expression, checker);
  }

  if (ts.isNumericLiteral(expr)) return Number(expr.text);

  if (ts.isPrefixUnaryExpression(expr)) {
    if (
      expr.operator !== ts.SyntaxKind.MinusToken &&
      expr.operator !== ts.SyntaxKind.PlusToken
    ) {
      return undefined;
    }
    const operand = numberFromExpression(expr.operand, checker);
    if (operand === undefined) return undefined;
    return expr.operator === ts.SyntaxKind.MinusToken ? -operand : operand;
  }

  if (ts.isIdentifier(expr)) return nonFiniteFromIdentifier(expr, checker);

  return undefined;
}
