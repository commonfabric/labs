import ts from "typescript";

import { resolvesToCommonFabricSymbol } from "@commonfabric/schema-generator/common-fabric-symbols";
import { HelpersOnlyTransformer } from "../core/transformers.ts";
import type { TransformationContext } from "../core/mod.ts";
import { getNodeText, preserveSourceMapRange } from "../ast/utils.ts";
import {
  ASSERT_CAPTURE_HELPER_NAME,
  unwrapExpression,
} from "../utils/expression.ts";

/**
 * AssertDiagnosticsTransformer: rewrites the body of an `assert(...)` call so
 * that a failing assertion can report its operands.
 *
 * `assert(() => a + b <= c)` becomes, in outline:
 *
 *     assert((): { ok: boolean; source: string; parts: ... } => {
 *       const __cfAssertParts = [];
 *       const __cfAssertOk: boolean =
 *         __cfHelpers.assertCapture(__cfAssertParts, "a + b", a + b) <=
 *         __cfHelpers.assertCapture(__cfAssertParts, "c", c);
 *       return {
 *         ok: __cfAssertOk,
 *         source: "a + b <= c",
 *         parts: __cfHelpers.assertRenderParts(__cfAssertOk, __cfAssertParts),
 *       };
 *     })
 *
 * `assertCapture` returns its value unchanged, so operand order and semantics
 * are untouched. It stashes each operand's resolved value rather than rendering
 * it; `assertRenderParts` renders them into the record's `parts`, but only when
 * the assertion failed — a passing assertion never pays to render an operand it
 * would not report. Everything after this stage lowers the call as a `computed`
 * (the runtime export registry maps `assert` onto `computed`), which rewrites
 * `a + b` into `a.get() + b.get()` inside the capture arguments as usual.
 *
 * Running before lowering is what makes the operand labels the author's own
 * source text: at this point `a + b` is still the authored node. After
 * lowering it would read `a.get() + b.get()`.
 *
 * The explicit return type annotation is load-bearing. Schema injection uses a
 * callback's annotation directly when it has one, which is what gives the
 * assertion a concrete object schema; an inferred `unknown` would instead read
 * back as `undefined`.
 *
 * The record shape is emitted whether or not operand recording is enabled,
 * because `assert` declares that it returns an `AssertRecord` and the value has
 * to match the declared type. `options.assertDiagnostics === false` drops the
 * capture calls, leaving the shape intact.
 */
export class AssertDiagnosticsTransformer extends HelpersOnlyTransformer {
  override filter(context: TransformationContext): boolean {
    // A declaration file needs no check of its own: it never receives the
    // helpers import, so the base filter has already turned it away.
    if (!super.filter(context)) return false;
    return context.sourceFile.text.includes("assert");
  }

  transform(context: TransformationContext): ts.SourceFile {
    const visitor = createAssertVisitor(context);
    return ts.visitNode(context.sourceFile, visitor) as ts.SourceFile;
  }
}

// Base names for the two locals the rewritten body introduces. They go through
// `createUniqueName`, so a body that already binds one of these names keeps its
// own binding and the emitted local takes a distinct one.
const PARTS_IDENTIFIER = "__cfAssertParts";
const OK_IDENTIFIER = "__cfAssertOk";

/**
 * Operators that combine sub-assertions rather than values. Their operands are
 * recorded *and* looked inside, because an operand of `&&` is usually itself a
 * comparison, and reporting only that it was false is the problem this exists
 * to solve.
 */
const SHORT_CIRCUIT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/** Operators whose operands are worth recording separately. */
const RECORDED_BINARY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword,
]);

function createAssertVisitor(context: TransformationContext): ts.Visitor {
  const { checker, tsContext } = context;

  const visitor: ts.Visitor = (node: ts.Node): ts.Node => {
    if (ts.isCallExpression(node) && isAssertCall(node, checker)) {
      const rewritten = rewriteAssertCall(node, context);
      if (rewritten) return rewritten;
    }
    return ts.visitEachChild(node, visitor, tsContext);
  };

  return visitor;
}

function isAssertCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  if (node.arguments.length !== 1) return false;
  const symbol = checker.getSymbolAtLocation(node.expression);
  return resolvesToCommonFabricSymbol(symbol, checker, "assert");
}

function rewriteAssertCall(
  node: ts.CallExpression,
  context: TransformationContext,
): ts.Node | undefined {
  const callback = node.arguments[0] && unwrapExpression(node.arguments[0]);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
  ) {
    return undefined;
  }
  if (callback.parameters.length !== 0) return undefined;

  const { factory } = context;

  // One node each, reused everywhere they appear: a second `createUniqueName`
  // call would generate a second, different name.
  const partsIdentifier = factory.createUniqueName(PARTS_IDENTIFIER);

  const returned = rewriteResultStatements(
    callback.body,
    partsIdentifier,
    context,
  );
  if (!returned) return undefined;

  const body = preserveSourceMapRange(
    factory.createBlock(
      [createPartsDeclaration(partsIdentifier, context), ...returned],
      true,
    ),
    callback.body,
  );
  const rewrittenCallback = ts.isArrowFunction(callback)
    ? factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      callback.parameters,
      createRecordTypeNode(context),
      callback.equalsGreaterThanToken,
      body,
    )
    : factory.updateFunctionExpression(
      callback,
      callback.modifiers,
      callback.asteriskToken,
      callback.name,
      callback.typeParameters,
      callback.parameters,
      createRecordTypeNode(context),
      body,
    );

  return factory.updateCallExpression(
    node,
    node.expression,
    node.typeArguments,
    [rewrittenCallback],
  );
}

/**
 * The callback's statements, with every `return` that belongs to it rewritten
 * to hand back the record.
 *
 * Every return is rewritten, not just a trailing one, so a body that returns
 * early still produces a record. Anything else would leave the body handing
 * back a bare boolean while `assert` declares an `AssertRecord`, and the
 * output schema and the value would disagree.
 *
 * Returns undefined for a body this cannot be done to — a bare `return;`,
 * which cannot be an assertion's result anyway, or a block with no return at
 * all.
 */
function rewriteResultStatements(
  body: ts.ConciseBody,
  partsIdentifier: ts.Identifier,
  context: TransformationContext,
): ts.Statement[] | undefined {
  if (!ts.isBlock(body)) {
    return [createRecordReturn(body, body, partsIdentifier, context)];
  }

  let rewroteAny = false;
  let bailed = false;

  const visit = (node: ts.Node): ts.Node => {
    if (bailed) return node;
    // A nested function or method owns its own returns.
    if (isOwnReturnScope(node)) return node;
    if (ts.isReturnStatement(node)) {
      if (!node.expression) {
        bailed = true;
        return node;
      }
      rewroteAny = true;
      return createRecordReturn(
        node.expression,
        node,
        partsIdentifier,
        context,
      );
    }
    return ts.visitEachChild(node, visit, context.tsContext);
  };

  const statements = body.statements.map((statement) =>
    ts.visitNode(statement, visit, ts.isStatement) as ts.Statement
  );

  if (bailed || !rewroteAny) return undefined;
  return statements;
}

/**
 * `{ const __cfAssertOk: boolean = <expr>; return { ok, source, parts }; }`
 *
 * A block, so each return scopes its own result binding and several of them
 * can coexist in one body.
 */
function createRecordReturn(
  resultExpression: ts.Expression,
  authoredSite: ts.Node,
  partsIdentifier: ts.Identifier,
  context: TransformationContext,
): ts.Statement {
  const { factory } = context;
  const recordOperands = context.options.assertDiagnostics !== false;
  const okIdentifier = factory.createUniqueName(OK_IDENTIFIER);

  const instrumented = recordOperands
    ? instrumentExpression(resultExpression, partsIdentifier, context)
    : resultExpression;

  const recordReturn = preserveSourceMapRange(
    factory.createReturnStatement(
      factory.createObjectLiteralExpression(
        [
          factory.createPropertyAssignment("ok", okIdentifier),
          factory.createPropertyAssignment(
            "source",
            factory.createStringLiteral(sourceTextOf(resultExpression)),
          ),
          // Rendering the recorded operands is deferred to here, and to only
          // the failing path: `assertRenderParts` returns an empty list when
          // `ok` is true, so a passing assertion never renders an operand.
          factory.createPropertyAssignment(
            "parts",
            context.cfHelpers.createHelperCall(
              "assertRenderParts",
              resultExpression,
              undefined,
              [okIdentifier, partsIdentifier],
            ),
          ),
        ],
        true,
      ),
    ),
    authoredSite,
  );
  return preserveSourceMapRange(
    factory.createBlock([
      createOkDeclaration(okIdentifier, instrumented, context),
      recordReturn,
    ], true),
    authoredSite,
  );
}

/** True for a node that owns any `return` written inside it. */
function isOwnReturnScope(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) || ts.isClassDeclaration(node) ||
    ts.isClassExpression(node);
}

/** `const __cfAssertParts: { src: string; value: unknown }[] = [];` */
function createPartsDeclaration(
  partsIdentifier: ts.Identifier,
  context: TransformationContext,
): ts.Statement {
  const { factory } = context;
  return factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList([
      factory.createVariableDeclaration(
        partsIdentifier,
        undefined,
        factory.createArrayTypeNode(createRawPartTypeNode(context)),
        factory.createArrayLiteralExpression([], false),
      ),
    ], ts.NodeFlags.Const),
  );
}

/**
 * `{ src: string; value: unknown }` — the shape `assertCapture` records into
 * the intermediate array before `assertRenderParts` renders it. The value is
 * held raw so a passing assertion never renders it.
 */
function createRawPartTypeNode(context: TransformationContext): ts.TypeNode {
  const { factory } = context;
  return factory.createTypeLiteralNode([
    factory.createPropertySignature(
      undefined,
      "src",
      undefined,
      factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
    ),
    factory.createPropertySignature(
      undefined,
      "value",
      undefined,
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    ),
  ]);
}

/**
 * `const __cfAssertOk: boolean = <expression>;`
 *
 * The annotation pins the result to `boolean`. `assertCapture` reaches the
 * body through `__cfHelpers`, which is typed `any`, so without it an operand's
 * `any` would widen the record's `ok` and collapse the schema to `unknown`.
 */
function createOkDeclaration(
  okIdentifier: ts.Identifier,
  expression: ts.Expression,
  context: TransformationContext,
): ts.Statement {
  const { factory } = context;
  return factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList([
      factory.createVariableDeclaration(
        okIdentifier,
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword),
        expression,
      ),
    ], ts.NodeFlags.Const),
  );
}

/** `{ src: string; rendered: string }` */
function createPartTypeNode(context: TransformationContext): ts.TypeNode {
  const { factory } = context;
  const property = (name: string) =>
    factory.createPropertySignature(
      undefined,
      name,
      undefined,
      factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
    );
  return factory.createTypeLiteralNode([
    property("src"),
    property("rendered"),
  ]);
}

/** `{ ok: boolean; source: string; parts: { src: string; rendered: string }[] }` */
function createRecordTypeNode(context: TransformationContext): ts.TypeNode {
  const { factory } = context;
  return factory.createTypeLiteralNode([
    factory.createPropertySignature(
      undefined,
      "ok",
      undefined,
      factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword),
    ),
    factory.createPropertySignature(
      undefined,
      "source",
      undefined,
      factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
    ),
    factory.createPropertySignature(
      undefined,
      "parts",
      undefined,
      factory.createArrayTypeNode(createPartTypeNode(context)),
    ),
  ]);
}

/**
 * Wraps the operands worth recording.
 *
 * At a comparison, an arithmetic operator, or a call, the operands are the
 * interesting values and are recorded as they stand: for `a + b <= c` that is
 * `a + b` and `c`, which is what the reader wants rather than every leaf.
 *
 * At `&&`, `||`, `??` and `?:`, the operands are themselves assertions, so
 * each is recorded *and* descended into — `x > 0 && y < 10` reports which
 * conjunct failed and the values that made it fail.
 *
 * Short-circuiting survives untouched: a capture on the right of `&&` only
 * runs if the left let it, so an operand that never evaluated is never
 * recorded. The same holds for the branch of `?:` that is not taken.
 */
function instrumentExpression(
  expression: ts.Expression,
  partsIdentifier: ts.Identifier,
  context: TransformationContext,
): ts.Expression {
  const { factory } = context;
  const target = unwrapExpression(expression);

  if (ts.isBinaryExpression(target)) {
    const operator = target.operatorToken.kind;
    if (SHORT_CIRCUIT_OPERATORS.has(operator)) {
      return factory.updateBinaryExpression(
        target,
        captureSubAssertion(target.left, partsIdentifier, context),
        target.operatorToken,
        captureSubAssertion(target.right, partsIdentifier, context),
      );
    }
    if (RECORDED_BINARY_OPERATORS.has(operator)) {
      return factory.updateBinaryExpression(
        target,
        captureOperand(target.left, partsIdentifier, context),
        target.operatorToken,
        captureOperand(target.right, partsIdentifier, context),
      );
    }
    return expression;
  }

  if (ts.isConditionalExpression(target)) {
    return factory.updateConditionalExpression(
      target,
      captureSubAssertion(target.condition, partsIdentifier, context),
      target.questionToken,
      captureSubAssertion(target.whenTrue, partsIdentifier, context),
      target.colonToken,
      captureSubAssertion(target.whenFalse, partsIdentifier, context),
    );
  }

  if (
    ts.isPrefixUnaryExpression(target) &&
    target.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return factory.updatePrefixUnaryExpression(
      target,
      captureOperand(target.operand, partsIdentifier, context),
    );
  }

  if (ts.isCallExpression(target)) {
    const recordedArguments = target.arguments.map((argument) =>
      captureArgument(argument, partsIdentifier, context)
    );
    const recordedAnyArgument = recordedArguments.some((argument, index) =>
      argument !== target.arguments[index]
    );
    return factory.updateCallExpression(
      target,
      // A call whose arguments say nothing — `items.every((i) => i.ok)` —
      // still has one value worth reporting: what it was called on.
      recordedAnyArgument
        ? target.expression
        : captureCallReceiver(target.expression, partsIdentifier, context),
      target.typeArguments,
      recordedArguments,
    );
  }

  return expression;
}

/**
 * Records a call argument, leaving a spread alone.
 *
 * A spread has to stay in argument position: `assertCapture` takes the operand
 * as one fixed parameter, so recording `f(...xs)` would pass `xs[0]` where the
 * whole of `xs` belongs and silently change the call's arity.
 */
function captureArgument(
  argument: ts.Expression,
  partsIdentifier: ts.Identifier,
  context: TransformationContext,
): ts.Expression {
  if (ts.isSpreadElement(argument)) return argument;
  return captureOperand(argument, partsIdentifier, context);
}

/**
 * Records the receiver of a method call — the `items` of `items.every(...)`.
 *
 * Wrapping the receiver keeps `this`, since the recording hands back the same
 * object the property is read from. A bare identifier receiver is left alone:
 * it is usually a namespace (`Object.is`, `Math.max`), whose value says
 * nothing. `super` cannot be an operand at all.
 */
function captureCallReceiver(
  callee: ts.Expression,
  partsIdentifier: ts.Identifier,
  context: TransformationContext,
): ts.Expression {
  if (!ts.isPropertyAccessExpression(callee)) return callee;
  if (callee.questionDotToken) return callee;
  const receiver = callee.expression;
  if (
    ts.isIdentifier(receiver) || receiver.kind === ts.SyntaxKind.SuperKeyword ||
    receiver.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return callee;
  }
  return context.factory.updatePropertyAccessExpression(
    callee,
    captureOperand(receiver, partsIdentifier, context),
    callee.name,
  );
}

/**
 * Records an operand of a short-circuit operator, having first recorded
 * whatever is worth recording inside it. The inner records land first, so the
 * values read ahead of the sub-assertion they explain.
 */
function captureSubAssertion(
  expression: ts.Expression,
  partsIdentifier: ts.Identifier,
  context: TransformationContext,
): ts.Expression {
  const instrumented = instrumentExpression(
    expression,
    partsIdentifier,
    context,
  );
  return captureValue(instrumented, expression, partsIdentifier, context);
}

function captureOperand(
  expression: ts.Expression,
  partsIdentifier: ts.Identifier,
  context: TransformationContext,
): ts.Expression {
  return captureValue(expression, expression, partsIdentifier, context);
}

/**
 * Emits a recording call around `value`, labeled with the authored text of
 * `labelSource`. The two differ once `value` has itself been instrumented, at
 * which point it no longer has authored text of its own to read.
 */
function captureValue(
  value: ts.Expression,
  labelSource: ts.Expression,
  partsIdentifier: ts.Identifier,
  context: TransformationContext,
): ts.Expression {
  if (isTrivialOperand(labelSource)) return value;
  // Label with the unwrapped node so that `!(a === b)` reads as `a === b`
  // rather than carrying the parentheses the operator needed. The original
  // expression is still what gets evaluated.
  const source = sourceTextOf(unwrapExpression(labelSource));

  return context.cfHelpers.createHelperCall(
    ASSERT_CAPTURE_HELPER_NAME,
    labelSource,
    undefined,
    [
      partsIdentifier,
      context.factory.createStringLiteral(source),
      value,
    ],
  );
}

/**
 * An operand whose value says nothing the source text does not already.
 *
 * A literal renders to the text it was written as. A function renders as
 * `(...) => {...}`, which is worse than nothing: it crowds out the value that
 * would explain the failure — for `items.every((i) => i.ok)` that is `items`,
 * which is recorded as the receiver once the callback is left alone.
 */
function isTrivialOperand(expression: ts.Expression): boolean {
  const target = unwrapExpression(expression);
  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
    return true;
  }
  switch (target.kind) {
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
    default:
      return ts.isIdentifier(target) && target.text === "undefined";
  }
}

/**
 * The authored text of a node, collapsed onto one line so it reads as a label.
 *
 * The pass runs before lowering, so operands are authored nodes and this is
 * the text the author wrote. `getNodeText` prints a node that has no position
 * of its own rather than failing, so an operand always gets a label.
 */
function sourceTextOf(node: ts.Node): string {
  return getNodeText(node).replace(/\s+/g, " ").trim();
}
