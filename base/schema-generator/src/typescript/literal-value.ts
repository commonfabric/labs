import ts from "typescript";
import { getPropertyNameText } from "./property-name.ts";
import { numberFromExpression } from "./numeric-expression.ts";

/**
 * A `Default<T, V>` payload written as `typeof CONST` is recovered by reading
 * the const's initializer off the AST. This is the one reader of such
 * initializers; both formatters call it, so what counts as a literal value
 * cannot differ between the union path and the Common Fabric path.
 *
 * A value is returned wrapped, so a legitimate `null` is distinguishable from
 * "not a literal". The extraction is all-or-nothing: an object or array with
 * one member that is not a literal yields no value at all, never a fragment.
 * A partial default would satisfy every "is there a default?" check while
 * missing a required property, which is worse than the absent default it
 * replaced — the runtime's own `Writable(CONST)` would hold the full value
 * and the schema would disagree with it (2026-08-28).
 *
 * What counts as a literal: string, number (including signed and non-finite
 * spellings), boolean, and null literals; arrays and objects of literals,
 * including computed property names that resolve to a string; a bare
 * identifier or shorthand property naming a `const` whose own initializer is
 * a literal, followed through import aliases and read once per walk; the
 * global `undefined` or
 * `void 0`, which makes an object member absent; and any of those under an `as`,
 * `satisfies`, angle-bracket assertion, or parentheses.
 */
export function extractLiteralValue(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  visiting: Walk = newWalk(),
): { value: unknown } | undefined {
  if (
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isParenthesizedExpression(expr)
  ) {
    return extractLiteralValue(expr.expression, checker, visiting);
  }

  if (ts.isArrayLiteralExpression(expr)) {
    const value: unknown[] = [];
    for (const element of expr.elements) {
      const item = extractLiteralValue(element, checker, visiting);
      if (!item) return undefined;
      value.push(item.value);
    }
    return { value };
  }

  if (ts.isObjectLiteralExpression(expr)) {
    const value: Record<string, unknown> = {};
    for (const property of expr.properties) {
      let name: string | undefined;
      let item: { value: unknown } | undefined;
      if (ts.isPropertyAssignment(property)) {
        // A non-computed `__proto__: x` sets the prototype at runtime and
        // creates no property; the value has nothing a schema can hold.
        // (`["__proto__"]` and shorthand `{ __proto__ }` are own properties.)
        if (
          !ts.isComputedPropertyName(property.name) &&
          getPropertyNameText(property.name, checker) === "__proto__"
        ) {
          return undefined;
        }
        name = getPropertyNameText(property.name, checker);
        item = extractLiteralValue(property.initializer, checker, visiting);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        name = property.name.text;
        const symbol = checker.getShorthandAssignmentValueSymbol(property) ??
          checker.getSymbolAtLocation(property.name);
        item = symbol
          ? extractLiteralValueOfSymbol(symbol, checker, visiting)
          : undefined;
      } else {
        // A spread, method, or accessor is not a literal member.
        return undefined;
      }
      if (name === undefined || !item) return undefined;
      // A member whose value is `undefined` is absent, as it is in the JSON
      // the schema becomes. Defined as an own property: `value[name] =` with
      // a computed `["__proto__"]` key would set the prototype instead.
      if (item.value === undefined) continue;
      Object.defineProperty(value, name, {
        value: item.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { value };
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { value: expr.text };
  }
  // Before the identifier arm: `NaN` and the infinities are identifiers too,
  // and theirs is a value, not a declaration to read.
  const numeric = numberFromExpression(expr, checker);
  if (numeric !== undefined) return { value: numeric };

  if (ts.isIdentifier(expr)) {
    const symbol = checker.getSymbolAtLocation(expr);
    if (!symbol) return undefined;
    if (expr.text === "undefined" && isGlobalDeclaration(symbol)) {
      return { value: undefined };
    }
    return extractLiteralValueOfSymbol(symbol, checker, visiting);
  }
  // `void 0` is the other spelling of `undefined`; no other operand is
  // read, so nothing else hides behind a `void`.
  if (
    ts.isVoidExpression(expr) && ts.isNumericLiteral(expr.expression) &&
    Number(expr.expression.text) === 0
  ) {
    return { value: undefined };
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (expr.kind === ts.SyntaxKind.NullKeyword) return { value: null };

  return undefined;
}

/**
 * The literal value a symbol's declaration holds: a variable declared with
 * an initializer that {@link extractLiteralValue} accepts. Import aliases are
 * followed to the declaring module first — `getSymbolAtLocation` on an
 * imported name returns the alias, whose `valueDeclaration` is the
 * ImportSpecifier, and a reader that stops there sees no initializer and
 * silently drops the default. A declaration that (transitively) names itself
 * yields nothing rather than recursing.
 */
export function extractLiteralValueOfSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  visiting: Walk = newWalk(),
): { value: unknown } | undefined {
  const resolved = resolveAliasedSymbol(symbol, checker);
  if (visiting.read.has(resolved)) return visiting.read.get(resolved);
  if (visiting.open.has(resolved)) return undefined;
  const declaration = resolved.valueDeclaration;
  if (
    !declaration || !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    // Only a `const` holds a value the schema can stand on; a `let` or `var`
    // initializer is what the binding started as, not what it is.
    return undefined;
  }
  visiting.open.add(resolved);
  try {
    const read = extractLiteralValue(
      declaration.initializer,
      checker,
      visiting,
    );
    visiting.read.set(resolved, read);
    return read;
  } finally {
    visiting.open.delete(resolved);
  }
}

/**
 * One walk's state: the consts whose initializers are being read right now
 * (a reference back to one is a cycle and yields nothing), and the consts
 * already read, so a const two members share is walked once. Shared
 * references are materialized by value — the schema default is a plain
 * JSON value, and holds a copy wherever the source held a reference.
 */
interface Walk {
  open: Set<ts.Symbol>;
  read: Map<ts.Symbol, { value: unknown } | undefined>;
}

function newWalk(): Walk {
  return { open: new Set(), read: new Map() };
}

/** Declared only by the ambient library — `undefined`, not a shadowing local. */
function isGlobalDeclaration(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations ?? [];
  return declarations.length === 0 ||
    declarations.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * Follow an import alias to the symbol it names; a symbol that is not an
 * alias is returned as is. Readers of a symbol's declaration — a default's
 * initializer, a type alias's declaration — go through here rather than
 * carrying their own copy of the hop, which is how one path came to have it
 * and another not.
 *
 * Not every alias-resolving site belongs here. A reader that turns the
 * declaring file into an authority claim (see `writeAuthorizedBy` in the
 * Common Fabric formatter) keeps its own resolution, because falling back to
 * the importing file on a failed hop would attribute identity to the wrong
 * module.
 */
export function resolveAliasedSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}
