import ts from "typescript";
import { isObjectNotArray } from "@commonfabric/utils/types";

// Structural queries over transformer output. Tests parse the printed output
// back into an AST and assert on real nodes instead of matching substrings.
// Parsing drops comments as trivia, so these queries cannot be satisfied by a
// preserved comment, and — unlike a substring that also occurs in the input —
// a structural match only holds when the transformer actually produced the
// node.

/**
 * Parses printed transformer output into a source file. Defaults to TSX;
 * callers exercising angle-bracket assertions pass {@link ts.ScriptKind.TS}.
 */
export function parseModule(
  source: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TSX,
): ts.SourceFile {
  return ts.createSourceFile(
    "/transformed.tsx",
    source,
    ts.ScriptTarget.ESNext,
    /*setParentNodes*/ true,
    scriptKind,
  );
}

/** Collect every descendant node (inclusive) matching a type guard. */
export function collect<T extends ts.Node>(
  root: ts.Node,
  guard: (node: ts.Node) => node is T,
): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node): void => {
    if (guard(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/**
 * The simple name a call targets: the identifier for `foo(...)` or the member
 * name for `obj.foo(...)`. Returns undefined for other callee shapes.
 */
export function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** Every call whose target name equals `name` (bare or member call). */
export function callsNamed(root: ts.Node, name: string): ts.CallExpression[] {
  return collect(root, ts.isCallExpression).filter((call) =>
    calleeName(call) === name
  );
}

/** Every call whose target name matches `pattern` (e.g. /^__cfLift/). */
export function callsMatching(
  root: ts.Node,
  pattern: RegExp,
): ts.CallExpression[] {
  return collect(root, ts.isCallExpression).filter((call) => {
    const name = calleeName(call);
    return name !== undefined && pattern.test(name);
  });
}

/** True when `call` is an immediately-invoked arrow/function expression. */
export function isImmediatelyInvokedFunction(call: ts.CallExpression): boolean {
  let callee: ts.Expression = call.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  return ts.isArrowFunction(callee) || ts.isFunctionExpression(callee);
}

/** Every immediately-invoked arrow/function call under `root`. */
export function iifeCalls(root: ts.Node): ts.CallExpression[] {
  return collect(root, ts.isCallExpression).filter(
    isImmediatelyInvokedFunction,
  );
}

/**
 * True when `root` contains a `<receiver>.key("<segment>")` reactive path read
 * — the lowered form of an element/property access on a reactive value. Pass
 * `receiver` to also require the immediate receiver identifier (e.g. "item").
 */
export function hasKeyPathRead(
  root: ts.Node,
  segment: string,
  receiver?: string,
): boolean {
  return callsNamed(root, "key").some((call) => {
    const arg = call.arguments[0];
    if (!arg || !ts.isStringLiteralLike(arg) || arg.text !== segment) {
      return false;
    }
    if (receiver === undefined) return true;
    const callee = call.expression as ts.PropertyAccessExpression;
    const base = callee.expression;
    return ts.isIdentifier(base) && base.text === receiver;
  });
}

/**
 * The evaluated first argument of every emitted `<receiver>.for(<cause>, true)`
 * stable-cause call, in source order. A cause is a string (`"foo"`), an array
 * path (`["__patternResult", "foo"]`), or a stream descriptor
 * (`{ stream: "save" }`), so each entry is the JS value that argument denotes.
 * Lets a test assert on the exact cause the transformer attached instead of
 * matching printed `.for(...)` text.
 */
export function forCauses(root: ts.Node): unknown[] {
  return callsNamed(root, "for")
    .filter((call) => call.arguments.length >= 1)
    .map((call) => literalToValue(call.arguments[0]!));
}

/** Unwrap parenthesized / `as` / `satisfies` / non-null wrappers. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Evaluate a pure literal expression (object/array/string/number/boolean/null,
 * through `as const`/`satisfies` wrappers) into the JS value it denotes. Throws
 * on any non-literal node, so callers only use it on emitted literal data such
 * as generated JSON schemas. This lets a test assert on real values
 * (`schema.properties.name.type === "string"`) instead of matching printed text.
 */
export function literalToValue(node: ts.Expression): unknown {
  const expr = unwrap(node);
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return -Number(expr.operand.text);
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.map((element) => literalToValue(element));
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const out: Record<string, unknown> = {};
    for (const property of expr.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(
          `Unsupported property kind in literal: ${
            ts.SyntaxKind[property.kind]
          }`,
        );
      }
      const name = property.name;
      const key = ts.isIdentifier(name) || ts.isStringLiteralLike(name)
        ? name.text
        : undefined;
      if (key === undefined) {
        throw new Error("Unsupported property name in literal");
      }
      out[key] = literalToValue(property.initializer);
    }
    return out;
  }
  throw new Error(`Not a literal expression: ${ts.SyntaxKind[expr.kind]}`);
}

/**
 * Every emitted schema object literal — an object written `... as const
 * satisfies ...JSONSchema` — evaluated to its JS value, in source order. Lets a
 * test assert on the generated schema structure directly.
 */
export function emittedSchemas(root: ts.Node): Record<string, unknown>[] {
  return collect(root, ts.isSatisfiesExpression)
    .filter((node) =>
      /JSONSchema/.test(node.type.getText(root.getSourceFile()))
    )
    .map((node) => literalToValue(node.expression))
    .filter((value): value is Record<string, unknown> =>
      isObjectNotArray(value)
    );
}

/**
 * The `{ input, output }` schemas of the emitted default `pattern(cb, input,
 * output)` call, evaluated to JS values.
 */
export function patternSchemas(
  root: ts.SourceFile,
): { input: Record<string, unknown>; output: Record<string, unknown> } {
  const call = callsNamed(root, "pattern").find((c) => c.arguments.length >= 3);
  if (!call) throw new Error("No emitted `pattern(cb, input, output)` call");
  return {
    input: literalToValue(call.arguments[1]!) as Record<string, unknown>,
    output: literalToValue(call.arguments[2]!) as Record<string, unknown>,
  };
}

/**
 * The schema object-literal arguments of the last emitted call to `name`
 * (e.g. `handler(cb, eventSchema, stateSchema)` or `lift(cb, input, result)`),
 * evaluated to JS values. Only arguments that are `... satisfies ...JSONSchema`
 * literals are returned, in argument order.
 */
export function callSchemas(
  root: ts.SourceFile,
  name: string,
): Record<string, unknown>[] {
  const call = callsNamed(root, name).at(-1);
  if (!call) return [];
  const out: Record<string, unknown>[] = [];
  for (const arg of call.arguments) {
    if (
      ts.isSatisfiesExpression(arg) &&
      /JSONSchema/.test(arg.type.getText(root))
    ) {
      out.push(literalToValue(arg.expression) as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * The initializer arrow/function body of `const <name> = <fn>(cb, ...)` — used
 * to isolate an extracted callback (e.g. the `__cfPattern_1` map callback) for
 * focused structural assertions.
 */
export function extractedCallbackBody(
  root: ts.SourceFile,
  variableName: string,
): ts.Node {
  const decl = collect(root, ts.isVariableDeclaration).find((d) =>
    ts.isIdentifier(d.name) && d.name.text === variableName
  );
  if (!decl?.initializer || !ts.isCallExpression(decl.initializer)) {
    throw new Error(`Expected \`const ${variableName} = call(...)\``);
  }
  const firstArg = decl.initializer.arguments[0];
  if (
    !firstArg ||
    (!ts.isArrowFunction(firstArg) && !ts.isFunctionExpression(firstArg))
  ) {
    throw new Error(
      `Expected a callback as the first argument of ${variableName}`,
    );
  }
  return firstArg.body;
}

/** One operand recorded by an emitted `assertCapture(parts, src, value)`. */
export interface AssertCapture {
  /** The authored source text the operand was labeled with. */
  src: string;

  /** The printed value expression the recording wraps. */
  value: string;
}

/**
 * Every operand recording the assert-diagnostics stage emitted, in source
 * order. `src` is the label argument; `value` is the wrapped expression, so a
 * test can check that the recording returns the operand rather than replacing
 * it.
 *
 * Source order is outermost-first: a recording that wraps another precedes the
 * one inside it. That is the reverse of the order they run in, since the inner
 * recording is an argument of the outer one and so evaluates first.
 */
export function assertCaptures(root: ts.SourceFile): AssertCapture[] {
  return callsNamed(root, "assertCapture").flatMap((call) => {
    const [, src, value] = call.arguments;
    if (!src || !value || !ts.isStringLiteral(src)) return [];
    return [{ src: src.text, value: value.getText(root) }];
  });
}

/** The `src` label of every emitted operand recording, in source order. */
export function assertCaptureLabels(root: ts.SourceFile): string[] {
  return assertCaptures(root).map((capture) => capture.src);
}

/**
 * Every verified-binding identity the hardening stage attached, as the
 * metadata literal's value (`{ sourceFile, bindingPath }`), in source order.
 * The helper is minted with a unique name, so it is matched by prefix.
 */
export function bindingIdentities(
  root: ts.Node,
): { sourceFile: string; bindingPath: string[] }[] {
  return callsMatching(root, /^__cfBindVerifiedBinding/).map((call) =>
    literalToValue(call.arguments[1]!) as {
      sourceFile: string;
      bindingPath: string[];
    }
  );
}

/**
 * Every `__ctWriterIdentityOf` marker an emitted claim carries, evaluated to
 * its value, in source order.
 */
export function writerIdentityMarkers(
  root: ts.Node,
): { file: string; path: string[]; moduleIdentity?: string }[] {
  return collect(root, ts.isPropertyAssignment)
    .filter((property) =>
      ts.isIdentifier(property.name) &&
      property.name.text === "__ctWriterIdentityOf"
    )
    .map((property) =>
      literalToValue(property.initializer) as {
        file: string;
        path: string[];
        moduleIdentity?: string;
      }
    );
}
