import {
  MERGEABLE_OP_METHODS,
  type MergeableOpMethodKind,
} from "@commonfabric/api";
import { type CellBrand } from "@commonfabric/schema-generator/cell-brand";
import { unwrapTypeParentheses } from "@commonfabric/schema-generator/type-node";
import ts from "typescript";

import {
  classifyArrayCallbackContainerCall,
  detectCallKind,
  detectNewExpressionKind,
  getNodeText,
  isCellLikeType,
  isWildcardTraversalCall,
} from "../ast/mod.ts";
import {
  type CapabilityParamSummary,
  type FunctionCapabilitySummary,
  type ReactiveCapability,
  resolvesToCommonFabricSymbol,
  type UnreadableCellArgument,
} from "../core/mod.ts";
import { isBrandedCellType } from "../transformers/cell-type.ts";
import {
  isTransparentWrapper,
  outermostTransparentWrapper,
  unwrapAssertCapture,
  unwrapExpression,
} from "../utils/expression.ts";
import { decodePath, encodePath } from "../utils/path-serialization.ts";
import { getKnownComputedKeyPathSegment } from "../utils/reactive-keys.ts";
import {
  createMergeablePushClassifier,
  type MergeableCollectionSite,
  type MergeablePushMisuse,
} from "./mergeable-push-classification.ts";

type CapabilityAnalyzableFunction =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration;

export interface CapabilityAnalysisOptions {
  readonly checker?: ts.TypeChecker;
  readonly interprocedural?: boolean;
  readonly includeNestedCallbacks?: boolean;
  readonly summaryCache?: WeakMap<ts.Node, FunctionCapabilitySummary>;
  readonly inProgress?: WeakSet<ts.Node>;

  /**
   * Transformer-known types for nodes the checker can't resolve. Required for
   * synthetic callbacks (e.g. the destructure-lowered lift-applied param, whose
   * bindings type as `any`): without it, type-based heuristics like
   * `isPrimitiveLikeExpression` answer wrong in a fixed direction and the
   * capability summary mis-shapes or drops inputs. Consulted before the checker.
   */
  readonly typeRegistry?: WeakMap<ts.Node, ts.Type>;

  /**
   * Optional sink for the read-then-mergeable-`push` misuse check. When set,
   * the analysis reports each `Cell.push` whose receiver collection path the
   * same function also reads explicitly (a `.get()` or an iteration), classified
   * by how that read relates to the push (see
   * {@link MergeablePushMisuse.kind}): a push that depends on the read through
   * a guard or its value is the dedup-then-push shape, better expressed as an
   * identity-addressed `addUnique` or a read-modify-write `set`; a read that
   * instead feeds an independent write to the same collection keeps the append
   * conflict-prone and belongs in its own handler. A read unrelated to both is
   * not reported. Left unset (the default), the analysis records no push sites.
   */
  readonly mergeablePushMisuseSink?: (finding: MergeablePushMisuse) => void;
}

interface MutableCapabilityState {
  readonly reads: Set<string>;
  readonly fullShapeReads: Set<string>;
  readonly writes: Set<string>;
  readonly rawIdentityPaths: Set<string>;
  readonly rawIdentityCellPaths: Set<string>;
  readonly rawComparablePaths: Set<string>;
  readonly rawComparableCellPaths: Set<string>;
  readonly rawOpaquePaths: Set<string>;
  passthrough: boolean;
  wildcard: boolean;

  /** Static path prefixes at which unknown (wildcard) accesses occurred.
   * `[]` means the whole root. Lets the identity-path filter erase only
   * identity paths the unknown access can actually cover, instead of
   * blanket-erasing every capture sharing this root state (#4714). */
  readonly wildcardPaths: Set<string>;

  hasIdentityUse: boolean;
  hasNonIdentityUse: boolean;
  hasNonIdentityRootUse: boolean;

  /**
   * Write-exhaustiveness is unverifiable for this parameter. Set by an
   * unrecognized or dynamic (`cell[m]()`) method call on a cell-like
   * receiver (the call could be a mutator this analysis does not know), and
   * by recognized `set`/`send` calls carrying an onCommit callback (whose
   * closure can escape into fresh transactions or external I/O after
   * commit — writes this analysis cannot bound). Consumers asserting
   * write exhaustiveness (`completeSchedulerScopeSummary`) must fail closed
   * on this, like `wildcard`; recognized reads/derivations are unaffected.
   *
   * Syntactic boundary: detection is per method-CALL dispatch. An extracted
   * method reference (`const f = cell.send; f(x)`) bypasses it — marginal
   * in practice (unbound cell methods break at runtime), but consumers
   * treating `!wildcard && !hasUnverifiedCellUse` as a soundness
   * certificate should know the contract's edge.
   */
  hasUnverifiedCellUse: boolean;
}

interface ObservedCapabilityUsage {
  readonly readPaths: readonly (readonly string[])[];
  readonly fullShapePaths: readonly (readonly string[])[];
  readonly writePaths: readonly (readonly string[])[];
  readonly opaquePaths: readonly (readonly string[])[];
  readonly passthrough: boolean;
  readonly wildcard: boolean;
  readonly hasUnverifiedCellUse: boolean;
  readonly identityOnly: boolean;
  readonly identityPaths: readonly (readonly string[])[];
  readonly identityCellPaths: readonly (readonly string[])[];
  readonly comparablePaths: readonly (readonly string[])[];
  readonly comparableCellPaths: readonly (readonly string[])[];
}

interface AccessPathInfo {
  readonly root: string;
  readonly path: readonly string[];
  readonly dynamic: boolean;
  readonly optional: boolean;
}

interface SourceRef {
  readonly root: string;
  readonly path: readonly string[];
  readonly dynamic: boolean;
  readonly arrayElement?: boolean;
  readonly elementResult?: boolean;
}

interface AliasShape {
  readonly properties: ReadonlyMap<string, AliasBinding>;
}

type AliasBinding = SourceRef | AliasShape;

function materializeSourceRef(ref: SourceRef): SourceRef {
  if (!ref.arrayElement) {
    return ref;
  }
  return {
    root: ref.root,
    path: [...ref.path, "0"],
    dynamic: ref.dynamic,
    elementResult: ref.elementResult,
  };
}

function extendSourceRef(
  ref: SourceRef,
  path: readonly string[],
): SourceRef {
  const base = materializeSourceRef(ref);
  return {
    root: base.root,
    path: [...base.path, ...path],
    dynamic: base.dynamic,
    elementResult: base.elementResult && path.length === 0,
  };
}

const PARAMETER_SUMMARY_PREFIX = "__param";

// The mergeable-op writer methods (increment, push, addUnique, removeByValue)
// come from the canonical catalog in @commonfabric/api, so a new mergeable op is
// classified by registering it there — no edit here. The non-mergeable Cell
// writers stay listed explicitly.
const mergeableMethods = (kind: MergeableOpMethodKind): string[] =>
  MERGEABLE_OP_METHODS.filter((op) => op.kind === kind).map((op) => op.method);

// `send` is a write: it delegates to set() on every receiver, but set()
// forks on the receiver's kind. On a raw cell that is an ordinary
// transactional write; on a stream the same set() call enqueues the event
// instead of revising the stream cell, and the dispatched handler's writes
// commit in their own transaction — effects this analysis cannot see or
// bound. Either way a callback that sends must never summarize as
// write-free.
// Classifying it here also keeps writePaths an exhaustive record of capture
// writes, which the computed-cell classifier relies on
// (docs/specs/computed-cell-identity.md).
const WRITER_METHODS = new Set([
  "set",
  "update",
  "send",
  ...mergeableMethods("scalar-writer"),
]);
const ARRAY_IDENTITY_WRITER_METHODS = new Set([
  "unshift",
  "splice",
  "remove",
  "removeAll",
  ...mergeableMethods("array-identity-writer"),
]);
const ARRAY_IDENTITY_PRESERVING_CHAIN_METHODS = new Set(["slice"]);
// The mergeable tail-append op. Only `push` commits as a mergeable `append`
// that drops the op's own array read from conflict detection; a handler that
// also reads the same collection then has a fragile read-then-push shape. The
// other identity writers either dedup/remove by value (the recommended
// replacements) or are ordinary read-modify-writes, so they are not flagged.
const MERGEABLE_APPEND_METHODS = new Set(["push"]);
const READER_METHODS = new Set(["get"]);
const OPAQUE_DERIVATION_METHODS = new Set([
  "map",
  "mapWithPattern",
  "count",
  "countWithPattern",
  "sum",
  "min",
  "max",
  "minBy",
  "minByWithPattern",
  "maxBy",
  "maxByWithPattern",
  "groupBy",
  "groupByWithPattern",
  "keyBy",
  "keyByWithPattern",

  "flatMap",
  "flatMapWithPattern",
  "filter",
  "filterWithPattern",
]);
const FALLBACK_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
]);
const PRECISE_CHAIN_METHODS = new Set([
  "map",
  "mapWithPattern",
  "count",
  "countWithPattern",
  "sum",
  "min",
  "max",
  "minBy",
  "minByWithPattern",
  "maxBy",
  "maxByWithPattern",
  "groupBy",
  "groupByWithPattern",
  "keyBy",
  "keyByWithPattern",

  "filter",
  "filterWithPattern",
  "flatMap",
  "flatMapWithPattern",
  "sort",
  "toSorted",
  "find",
  "findLast",
  "at",
]);
const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
]);

function isCapabilityAnalyzableFunction(
  node: ts.Node | undefined,
): node is CapabilityAnalyzableFunction {
  return !!node &&
    (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node)
    ) &&
    !!node.body;
}

function isInterproceduralSummaryTarget(
  declaration: ts.Node | undefined,
  sourceFile: ts.SourceFile,
): declaration is CapabilityAnalyzableFunction {
  return isCapabilityAnalyzableFunction(declaration) &&
    declaration.getSourceFile() === sourceFile;
}

// Body analysis cannot see writes performed inside a callee whose body lives in
// another file. The callee's declared parameter type is the only available
// description of what it does with the cell, so it is treated as a contract for
// the one capability the body cannot reveal: a hidden write.
function isSignatureDeclaredOutsideSourceFile(
  signature: ts.Signature,
  sourceFile: ts.SourceFile,
): boolean {
  const declaration = signature.declaration;
  return !!declaration && declaration.getSourceFile() !== sourceFile;
}

function getParameterAtArgument(
  signature: ts.Signature,
  argumentIndex: number,
): ts.Symbol | undefined {
  const parameters = signature.getParameters();
  if (argumentIndex < parameters.length) {
    return parameters[argumentIndex];
  }
  const lastParameter = parameters[parameters.length - 1];
  const declaration = lastParameter?.valueDeclaration;
  return declaration && ts.isParameter(declaration) &&
      declaration.dotDotDotToken
    ? lastParameter
    : undefined;
}

// Read the capability an imported callee declares for a parameter from its
// Common Fabric cell wrapper type. `Writable<T>` is a structural alias of
// `Cell<T>` (an identical type), so the two are distinguished only by the
// spelling on the declared type node; the wrapper is matched nominally, by name,
// rather than by the resolved type. The other wrappers (`ReadonlyCell`,
// `WriteonlyCell`, etc.) carry distinct brands and are genuinely different
// types. A type that is not a recognized Common Fabric wrapper returns undefined
// and leaves the conservative default in place.
// In a union type node, `undefined` parses as a keyword type node but `null`
// parses as a LiteralTypeNode wrapping a null literal, so a bare NullKeyword
// check never matches. Skip both so a nullable wrapper such as
// `Writable<T> | null` is still recognized by its non-null member.
function isNullOrUndefinedTypeNode(typeNode: ts.TypeNode): boolean {
  if (typeNode.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  return ts.isLiteralTypeNode(typeNode) &&
    typeNode.literal.kind === ts.SyntaxKind.NullKeyword;
}

// A bounded generic parameter (`<C extends Writable<T>>`) carries the capability
// of its constraint, so read the constraint node. Unbounded generics have no
// constraint and stay unreadable.
function getTypeParameterConstraintTypeNode(
  symbol: ts.Symbol | undefined,
): ts.TypeNode | undefined {
  for (const declaration of symbol?.getDeclarations() ?? []) {
    if (ts.isTypeParameterDeclaration(declaration) && declaration.constraint) {
      return declaration.constraint;
    }
  }
  return undefined;
}

function getExplicitCellKindFromTypeNode(
  typeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  depth = 0,
): CellBrand | undefined {
  // The depth guard bounds the type-parameter-constraint recursion below
  // against a circular constraint on ill-typed input.
  if (!typeNode || depth > 16) return undefined;
  typeNode = unwrapTypeParentheses(typeNode);

  if (ts.isUnionTypeNode(typeNode)) {
    const kinds = new Set<CellBrand>();
    for (const member of typeNode.types) {
      if (isNullOrUndefinedTypeNode(member)) {
        continue;
      }
      const kind = getExplicitCellKindFromTypeNode(member, checker, depth + 1);
      if (!kind) {
        return undefined;
      }
      kinds.add(kind);
    }
    return kinds.size === 1 ? kinds.values().next().value : undefined;
  }

  if (!ts.isTypeReferenceNode(typeNode)) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(typeNode.typeName);
  // `Writable<T>` is the spelling that declares write intent. Bare `Cell<T>` is
  // the neutral base alias and is intentionally not matched here: a callee that
  // writes a cell argument must declare `Writable<T>` (or `WriteonlyCell<T>`),
  // so an ambiguous `Cell<T>` parameter stays conservative and does not grant
  // the caller write authority it has not demonstrated.
  if (resolvesToCommonFabricSymbol(symbol, checker, "Writable")) {
    return "cell";
  }
  if (resolvesToCommonFabricSymbol(symbol, checker, "ReadonlyCell")) {
    return "readonly";
  }
  if (resolvesToCommonFabricSymbol(symbol, checker, "WriteonlyCell")) {
    return "writeonly";
  }
  if (resolvesToCommonFabricSymbol(symbol, checker, "Stream")) {
    return "stream";
  }
  if (resolvesToCommonFabricSymbol(symbol, checker, "ComparableCell")) {
    return "comparable";
  }
  if (
    resolvesToCommonFabricSymbol(symbol, checker, "OpaqueCell") ||
    resolvesToCommonFabricSymbol(symbol, checker, "OpaqueRef")
  ) {
    return "opaque";
  }
  if (resolvesToCommonFabricSymbol(symbol, checker, "SqliteDb")) {
    return "sqlite";
  }
  const constraint = getTypeParameterConstraintTypeNode(symbol);
  if (constraint) {
    return getExplicitCellKindFromTypeNode(constraint, checker, depth + 1);
  }
  return undefined;
}

// The declared type node that governs a single argument at this parameter: the
// element type for a rest parameter, otherwise the parameter's own type.
function getEffectiveParameterTypeNode(
  parameter: ts.Symbol | undefined,
): ts.TypeNode | undefined {
  const declaration = parameter?.valueDeclaration;
  if (!declaration || !ts.isParameter(declaration)) {
    return undefined;
  }
  if (declaration.dotDotDotToken) {
    return getRestParameterElementTypeNode(declaration.type);
  }
  return declaration.type;
}

function getParameterDeclaredCellKind(
  parameter: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): CellBrand | undefined {
  return getExplicitCellKindFromTypeNode(
    getEffectiveParameterTypeNode(parameter),
    checker,
  );
}

// A missing annotation (implicit any) or an explicit `any`/`unknown` parameter
// A union parameter that mixes a recognized cell wrapper with a member the
// contract cannot collapse to the same capability — for example
// `AuthCell | Writable<Auth>`, or `Writable<Auth> | ReadonlyCell<Auth>`. Such a
// union defeats classification: overload resolution can't pick the intended
// capability, so a cell argument silently degrades. This is deliberately narrow
// — it does not fire for value-or-cell framework types (`FactoryInput<T>`,
// `U | AnyBrandedCell<U>`), which are unions with no recognized-wrapper member
// (or not unions at all), nor for bare `Cell<T>`, generics, or `any`/`unknown`.
function isAmbiguousCellWrapperUnion(
  typeNode: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
): boolean {
  const node = typeNode && unwrapTypeParentheses(typeNode);
  if (!node || !ts.isUnionTypeNode(node)) return false;
  // If the union collapses to a single capability it is readable; only flag when
  // it does not, yet at least one member is a recognized cell wrapper.
  if (getExplicitCellKindFromTypeNode(node, checker)) return false;
  return node.types.some((member) =>
    !isNullOrUndefinedTypeNode(member) &&
    getExplicitCellKindFromTypeNode(member, checker) !== undefined
  );
}

function buildUnreadableCellArgumentMessage(
  typeNode: ts.TypeNode | undefined,
): string {
  const typeText = typeNode ? getNodeText(typeNode) : "unknown";
  return `Cell argument flows to an imported parameter typed \`${typeText}\`, ` +
    `a union that mixes cell capabilities the analysis cannot resolve to one ` +
    `kind. Split the callee into overloads (one per cell wrapper, such as ` +
    `\`Writable<T>\` and the other type) so overload resolution selects the ` +
    `intended capability; otherwise the argument silently degrades to a ` +
    `read-only cell and a needed write is denied at runtime.`;
}

// A rest parameter declares an array, but each variadic argument has the
// element type. Unwrap `T[]`, `readonly T[]`, `Array<T>`, and `ReadonlyArray<T>`
// to the element.
function getRestParameterElementTypeNode(
  typeNode: ts.TypeNode | undefined,
): ts.TypeNode | undefined {
  if (!typeNode) return undefined;
  typeNode = unwrapTypeParentheses(typeNode);
  if (
    ts.isTypeOperatorNode(typeNode) &&
    typeNode.operator === ts.SyntaxKind.ReadonlyKeyword
  ) {
    return getRestParameterElementTypeNode(typeNode.type);
  }
  if (ts.isArrayTypeNode(typeNode)) {
    return typeNode.elementType;
  }
  if (
    ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    (typeNode.typeName.text === "Array" ||
      typeNode.typeName.text === "ReadonlyArray") &&
    typeNode.typeArguments?.length === 1
  ) {
    return typeNode.typeArguments[0];
  }
  return undefined;
}

function isRestParameter(parameter: ts.Symbol | undefined): boolean {
  const declaration = parameter?.valueDeclaration;
  return !!declaration && ts.isParameter(declaration) &&
    !!declaration.dotDotDotToken;
}

// A spread of a fixed-length tuple fills a statically known set of parameter
// positions, so it can be expanded and matched positionally. Return the element
// count for such a tuple, or undefined for anything whose length is not fixed at
// compile time (a plain array, or a tuple with an optional, rest, or variadic
// element such as `[A, ...B[]]`). Every element flag must be exactly
// `Required`; any other flag admits a variable runtime length.
function getFixedTupleElementCount(
  type: ts.Type,
  checker: ts.TypeChecker,
): number | undefined {
  if (!checker.isTupleType(type)) return undefined;
  const target = (type as ts.TypeReference).target as ts.TupleType;
  const elementFlags = target.elementFlags;
  for (const flag of elementFlags) {
    if (flag !== ts.ElementFlags.Required) return undefined;
  }
  return elementFlags.length;
}

function isLiteralElement(
  expr: ts.Expression | undefined,
): expr is
  | ts.StringLiteral
  | ts.NumericLiteral
  | ts.NoSubstitutionTemplateLiteral {
  return !!expr &&
    (ts.isStringLiteral(expr) ||
      ts.isNumericLiteral(expr) ||
      ts.isNoSubstitutionTemplateLiteral(expr));
}

function getLiteralElementText(
  expr: ts.StringLiteral | ts.NumericLiteral | ts.NoSubstitutionTemplateLiteral,
): string {
  return expr.text;
}

function extractLiteralPathArguments(
  args: readonly ts.Expression[],
  checker?: ts.TypeChecker,
): { path: readonly string[]; dynamic: boolean } {
  const path: string[] = [];
  for (const arg of args) {
    if (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg)) {
      path.push(arg.text);
      continue;
    }
    if (ts.isNoSubstitutionTemplateLiteral(arg)) {
      path.push(arg.text);
      continue;
    }
    const knownKey = getKnownComputedKeyPathSegment(arg, checker);
    if (knownKey) {
      path.push(knownKey);
      continue;
    }
    return { path, dynamic: true };
  }
  return { path, dynamic: false };
}

function getStaticPropertyKeyText(
  name: ts.PropertyName,
  checker?: ts.TypeChecker,
): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }

  if (ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    return getKnownComputedKeyPathSegment(name.expression, checker) ??
      (isLiteralElement(name.expression)
        ? getLiteralElementText(name.expression)
        : undefined);
  }

  return undefined;
}

function extractAccessPath(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): AccessPathInfo | undefined {
  const path: string[] = [];
  let dynamic = false;
  let optional = false;
  let current: ts.Expression = unwrapExpression(expr);

  while (true) {
    if (ts.isPropertyAccessExpression(current)) {
      path.unshift(current.name.text);
      optional ||= !!current.questionDotToken;
      current = unwrapExpression(current.expression);
      continue;
    }

    if (ts.isElementAccessExpression(current)) {
      optional ||= !!current.questionDotToken;
      if (isLiteralElement(current.argumentExpression)) {
        path.unshift(getLiteralElementText(current.argumentExpression));
      } else {
        const knownKey = current.argumentExpression &&
          getKnownComputedKeyPathSegment(current.argumentExpression, checker);
        if (knownKey) {
          path.unshift(knownKey);
        } else {
          dynamic = true;
        }
      }
      current = unwrapExpression(current.expression);
      continue;
    }

    break;
  }

  if (!ts.isIdentifier(current)) {
    return undefined;
  }

  return {
    root: current.text,
    path,
    dynamic,
    optional,
  };
}

function isMemberRootIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

function isTopmostMemberNode(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return true;
  return !(
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

/**
 * True when the member/call spine `resolveSourceRef` walks to reach a root
 * passes through a call — `table.find(matches)?.mentionedBy`, say, but not
 * `table.rows.first`.
 *
 * Ref resolution consumes that spine without descending into it, so a caller
 * that resolves a ref in place of visiting the expression leaves whatever
 * hangs off a call on it — an array method's callback above all — unanalyzed.
 */
function memberSpineContainsCall(expression: ts.Expression): boolean {
  let current = unwrapExpression(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = unwrapExpression(current.expression);
  }
  return ts.isCallExpression(current);
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isFunctionExpression(parent) && parent.name === node) return true;
  if (ts.isClassDeclaration(parent) && parent.name === node) return true;
  return false;
}

function isNonValueIdentifierUsage(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;

  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;

  return false;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return ASSIGNMENT_OPERATORS.has(kind);
}

function isBooleanConditionUsage(expression: ts.Expression): boolean {
  const parent = expression.parent;
  if (!parent) return false;

  if (isTransparentWrapper(parent) && parent.expression === expression) {
    return isBooleanConditionUsage(parent);
  }

  if (
    ts.isPrefixUnaryExpression(parent) &&
    parent.operator === ts.SyntaxKind.ExclamationToken &&
    parent.operand === expression
  ) {
    return isBooleanConditionUsage(parent);
  }

  if (
    (ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent)) &&
    parent.expression === expression
  ) {
    return true;
  }

  if (ts.isConditionalExpression(parent) && parent.condition === expression) {
    return true;
  }

  if (ts.isForStatement(parent) && parent.condition === expression) {
    return true;
  }

  if (
    ts.isBinaryExpression(parent) &&
    parent.left === expression &&
    (
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    )
  ) {
    return true;
  }

  return false;
}

function isPassThroughIdentifierUsage(node: ts.Identifier): boolean {
  const usage = outermostTransparentWrapper(node);
  const parent = usage.parent;
  if (!parent) return false;

  if (ts.isArrowFunction(parent) && parent.body === usage) return true;
  if (ts.isReturnStatement(parent) && parent.expression === usage) return true;
  if (ts.isVariableDeclaration(parent) && parent.initializer === usage) {
    return true;
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === usage) {
    return true;
  }
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === usage) {
    return true;
  }
  if (ts.isArrayLiteralExpression(parent) && parent.elements.includes(usage)) {
    return true;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === usage &&
    isAssignmentOperator(parent.operatorToken.kind)
  ) {
    return true;
  }

  return false;
}

/**
 * The outermost expression whose value is `node`'s own, reached by climbing
 * every parent that forwards an operand's value unchanged: a transparent
 * wrapper, either branch of a conditional, either operand of `??` and `||`,
 * and the right operand of `&&` or a comma. The left operand of `??` and `||`
 * is the value the expression takes whenever it is there at all, so it
 * travels as far as the expression does. The left operand of `&&` is not
 * climbed: the expression takes it only when it is falsy, and a falsy value
 * has no members to lose.
 */
function outermostValueForwarder(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  while (true) {
    const parent = current.parent;
    if (!parent) return current;
    if (isTransparentWrapper(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    if (
      ts.isConditionalExpression(parent) &&
      (parent.whenTrue === current || parent.whenFalse === current)
    ) {
      current = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent)) {
      const kind = parent.operatorToken.kind;
      const fallback = kind === ts.SyntaxKind.QuestionQuestionToken ||
        kind === ts.SyntaxKind.BarBarToken;
      const forwardsRight = fallback ||
        kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        kind === ts.SyntaxKind.CommaToken;
      if (
        (parent.right === current && forwardsRight) ||
        (parent.left === current && fallback)
      ) {
        current = parent;
        continue;
      }
    }
    return current;
  }
}

/**
 * Whether an object literal is one alias resolution can model: static keys
 * and no spread, which is what `buildAliasBindingFromExpression` requires
 * before it records the literal's properties as an alias shape.
 */
function isAliasableObjectLiteral(
  literal: ts.ObjectLiteralExpression,
): boolean {
  return literal.properties.every((property) =>
    !ts.isSpreadAssignment(property) &&
    !(
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
      ts.isComputedPropertyName(property.name)
    )
  );
}

/**
 * Whether the function directly enclosing `from` declares `name`, as one of
 * its parameters or as a variable in its body outside any nested function.
 *
 * An alias set by an assignment lives as long as the scope that made it, and
 * a nested callback's aliases are dropped when the callback ends. So an
 * assignment follows a value only into a variable its own function declares;
 * assigned to a variable of an enclosing function, the value outlives the
 * alias that tracked it. A node with no function above it — synthesized, with
 * parent links that stop short — returns `true`: what cannot be placed is not
 * widened.
 */
function isDeclaredByEnclosingFunction(name: string, from: ts.Node): boolean {
  let enclosing: ts.Node | undefined = from.parent;
  while (enclosing && !ts.isFunctionLike(enclosing)) {
    enclosing = enclosing.parent;
  }
  if (!enclosing || !ts.isFunctionLike(enclosing)) return true;

  const declares = (binding: ts.BindingName): boolean =>
    ts.isIdentifier(binding)
      ? binding.text === name
      : binding.elements.some((element) =>
        !ts.isOmittedExpression(element) && declares(element.name)
      );

  if (enclosing.parameters.some((parameter) => declares(parameter.name))) {
    return true;
  }
  const body = (enclosing as { body?: ts.Node }).body;
  if (!body) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || (node !== body && ts.isFunctionLike(node))) return;
    if (ts.isVariableDeclaration(node) && declares(node.name)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/**
 * Whether every target an assignment pattern writes is a local the function
 * directly enclosing `from` declares. A target that is a member
 * (`holder.row`), or a variable of an enclosing function, takes the value
 * somewhere alias resolution stops following it.
 */
function assignmentTargetsAreOwnLocals(
  pattern: ts.Expression,
  from: ts.Node,
): boolean {
  const target = unwrapExpression(pattern);
  if (ts.isIdentifier(target)) {
    return isDeclaredByEnclosingFunction(target.text, from);
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.every((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return isDeclaredByEnclosingFunction(property.name.text, from);
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetsAreOwnLocals(property.initializer, from);
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetsAreOwnLocals(property.expression, from);
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.every((element) =>
      ts.isOmittedExpression(element) ||
      assignmentTargetsAreOwnLocals(
        ts.isSpreadElement(element) ? element.expression : element,
        from,
      )
    );
  }
  // A target with a default, `{ row: last = fallback }`, is written as an
  // assignment whose left side is the target.
  if (
    ts.isBinaryExpression(target) &&
    target.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return assignmentTargetsAreOwnLocals(target.left, from);
  }
  return false;
}

/**
 * Where a value used whole ends up, once every value-forwarding parent and
 * every enclosing object literal that alias resolution models has been
 * climbed. A parent link that stops short — a synthesized node — answers
 * `consumed` wherever it is met: what cannot be placed is not widened.
 *
 * `tracked` is a local binding, reached directly or through such literals:
 * reads through the alias go on resolving to the paths they touch, so the
 * value has not left the analysis. `argument` is a call or `new` argument,
 * which the caller decides by whether the callee charged it. `result` is the
 * value a function returns, from a `return` or an arrow's expression body,
 * which the caller decides by which function: the analyzed builder's own
 * result hands the value on by reference, since the runner writes a proxy in
 * a result as a link, while an inline callback's result is a value the body
 * goes on to read. `escaped` is a position the analysis stops following the
 * value at, where every member it declares may be read: an array literal, an
 * object literal alias resolution cannot model, an assignment to anything but
 * a local its own function declares. `consumed` is every other position — a
 * member access, an operand, a condition — which reads through the value
 * where it stands and is charged by the handler for that position.
 */
function wholeValueDestination(
  node: ts.Expression,
):
  | { kind: "tracked" }
  | { kind: "consumed" }
  | {
    kind: "argument";
    call: ts.CallExpression | ts.NewExpression;
    argument: ts.Expression;
  }
  | { kind: "result"; of: ts.Node }
  | { kind: "escaped" } {
  let current: ts.Expression = outermostValueForwarder(node);
  while (true) {
    const parent = current.parent;
    if (!parent) return { kind: "consumed" };
    if (
      (ts.isPropertyAssignment(parent) && parent.initializer === current) ||
      (ts.isShorthandPropertyAssignment(parent) && parent.name === current)
    ) {
      const literal = parent.parent;
      if (
        !literal || !ts.isObjectLiteralExpression(literal) ||
        !isAliasableObjectLiteral(literal)
      ) {
        return { kind: "escaped" };
      }
      current = outermostValueForwarder(literal);
      continue;
    }
    if (ts.isArrayLiteralExpression(parent)) return { kind: "escaped" };
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      return { kind: "tracked" };
    }
    if (
      ts.isBinaryExpression(parent) && parent.right === current &&
      isAssignmentOperator(parent.operatorToken.kind)
    ) {
      const local = parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        assignmentTargetsAreOwnLocals(parent.left, parent);
      return { kind: local ? "tracked" : "escaped" };
    }
    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.arguments?.includes(current)
    ) {
      return { kind: "argument", call: parent, argument: current };
    }
    if (ts.isReturnStatement(parent) && parent.expression === current) {
      let enclosing: ts.Node | undefined = parent.parent;
      while (enclosing && !ts.isFunctionLike(enclosing)) {
        enclosing = enclosing.parent;
      }
      // A return with no function above it is inside a synthesized callback
      // whose parent links stop short — a lowered builder callback — and a
      // builder's result is handed on by reference.
      return enclosing
        ? { kind: "result", of: enclosing }
        : { kind: "consumed" };
    }
    if (ts.isArrowFunction(parent) && parent.body === current) {
      return { kind: "result", of: parent };
    }
    return { kind: "consumed" };
  }
}

/**
 * Whether a call is `Array.isArray`, which decides its answer off the value's
 * shape and reads nothing below it. Recognized the way
 * `classifyWildcardTraversalCall` recognizes `JSON.stringify`: with a checker
 * by the member's declaration sitting on the `ArrayConstructor` interface,
 * whichever library file declares it; without one, or where the callee is
 * synthesized and has no symbol, by its spelling.
 */
function isArrayIsArrayCall(
  call: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker | undefined,
): boolean {
  if (!ts.isCallExpression(call)) return false;
  const target = unwrapExpression(call.expression);
  if (
    !ts.isPropertyAccessExpression(target) || target.name.text !== "isArray"
  ) {
    return false;
  }
  const spelledArray = ts.isIdentifier(target.expression) &&
    target.expression.text === "Array";
  const symbol = checker?.getSymbolAtLocation(target.name);
  if (symbol === undefined) return spelledArray;
  return (symbol.getDeclarations() ?? []).some((declaration) => {
    let owner: ts.Node | undefined = declaration.parent;
    while (
      owner && !ts.isInterfaceDeclaration(owner) &&
      !ts.isClassDeclaration(owner)
    ) {
      owner = owner.parent;
    }
    return owner !== undefined &&
      (ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner)) &&
      owner.name?.text === "ArrayConstructor";
  });
}

/**
 * Whether a function hands what it returns straight back to a caller's body:
 * a function declaration or method, or a function bound to a variable or a
 * property. A builder's callback is none of these. It is an argument of the
 * builder call, and the runtime writes its result, storing a proxy in it as a
 * link. A synthesized function with no parent is not taken to be a helper
 * either: only positive evidence makes one.
 *
 * The test is the function's own shape, so a function bound to a name and
 * handed to a builder by that name (`lift(bump)`) reads as a helper too. That
 * costs such a builder nothing: schema injection does not shrink a callback it
 * is handed by name, whose schema comes from the builder's type arguments or
 * is not emitted at all, so this summary never reaches its schema.
 */
function returnsToACaller(fn: ts.Node): boolean {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) return true;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  const holder = outermostTransparentWrapper(fn).parent;
  return holder !== undefined &&
    (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) ||
      ts.isPropertyDeclaration(holder));
}

/** Calls `visit` on every source reference an alias binding reaches. */
function forEachSourceRefLeaf(
  binding: AliasBinding,
  visit: (ref: SourceRef) => void,
): void {
  if (isSourceRefBinding(binding)) {
    visit(binding);
    return;
  }
  for (const child of binding.properties.values()) {
    forEachSourceRefLeaf(child, visit);
  }
}

function isCallOrNewArgumentUsage(
  usage: ts.Expression,
): boolean {
  const parent = usage.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent)) {
    return parent.arguments.includes(usage);
  }
  if (ts.isNewExpression(parent) && parent.arguments) {
    return parent.arguments.includes(usage);
  }
  return false;
}

function isArrayIdentityWriterArgumentUsage(
  usage: ts.Expression,
): boolean {
  const parent = usage.parent;
  if (!parent || !ts.isCallExpression(parent)) {
    return false;
  }
  if (!parent.arguments.includes(usage)) {
    return false;
  }
  const target = unwrapExpression(parent.expression);
  const methodName = ts.isPropertyAccessExpression(target)
    ? target.name.text
    : ts.isElementAccessExpression(target) && target.argumentExpression &&
        isLiteralElement(target.argumentExpression)
    ? getLiteralElementText(target.argumentExpression)
    : undefined;
  return isArrayIdentityWriterValueArgument(methodName, parent, usage);
}

function isArrayIdentityWriterValueArgument(
  methodName: string | undefined,
  call: ts.CallExpression,
  usage: ts.Expression,
): boolean {
  if (!methodName || !ARRAY_IDENTITY_WRITER_METHODS.has(methodName)) {
    return false;
  }
  const index = call.arguments.findIndex((argument) => argument === usage);
  if (index < 0) {
    return false;
  }
  return methodName === "splice" ? index >= 2 : true;
}

function isOptionalAliasInitializerMemberUsage(usage: ts.Expression): boolean {
  let current: ts.Expression = usage;
  let sawOptionalMemberAccess = (ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)) && !!current.questionDotToken;
  while (current.parent) {
    const parent = current.parent;
    if (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)) &&
      parent.expression === current
    ) {
      sawOptionalMemberAccess ||= !!parent.questionDotToken;
      current = parent;
      continue;
    }
    if (isTransparentWrapper(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    return sawOptionalMemberAccess && ts.isVariableDeclaration(parent) &&
      parent.initializer === current;
  }
  return false;
}

function getIdentityArrayLocalNameForElementUsage(
  usage: ts.Node,
): string | undefined {
  const parent = usage.parent;
  if (!parent || !ts.isArrayLiteralExpression(parent)) {
    return undefined;
  }

  let current: ts.Expression = parent;
  while (current.parent) {
    const parentNode = current.parent;
    if (
      isTransparentWrapper(parentNode) && parentNode.expression === current
    ) {
      current = parentNode;
      continue;
    }

    if (
      (ts.isPropertyAccessExpression(parentNode) ||
        ts.isElementAccessExpression(parentNode)) &&
      parentNode.expression === current
    ) {
      current = parentNode;
      continue;
    }

    if (
      ts.isCallExpression(parentNode) &&
      parentNode.expression === current
    ) {
      current = parentNode;
      continue;
    }

    if (
      ts.isVariableDeclaration(parentNode) &&
      parentNode.initializer === current &&
      ts.isIdentifier(parentNode.name)
    ) {
      return parentNode.name.text;
    }

    return undefined;
  }

  return undefined;
}

function getIdentityArrayLocalNameForWriterArgumentUsage(
  usage: ts.Expression,
): string | undefined {
  const parent = usage.parent;
  if (!parent || !ts.isCallExpression(parent)) {
    return undefined;
  }
  const target = unwrapExpression(parent.expression);
  const receiver = ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target)
    ? unwrapExpression(target.expression)
    : undefined;
  const methodName = getCallMethodNameFromExpression(parent.expression);
  if (!receiver || !ts.isIdentifier(receiver)) {
    return undefined;
  }
  if (!isArrayIdentityWriterValueArgument(methodName, parent, usage)) {
    return undefined;
  }
  return receiver.text;
}

function collectArrayLocalsPassedToSet(
  body: ts.ConciseBody,
  checker?: ts.TypeChecker,
): ReadonlySet<string> {
  const arrayInitializerLocals = new Set<string>();
  const setArgumentLocals = new Set<string>();
  const structurallyAccessedArrayLocals = new Set<string>();

  const expressionIsIdentityArrayInitializer = (
    expression: ts.Expression,
  ): boolean => {
    const current = unwrapExpression(expression);
    if (ts.isArrayLiteralExpression(current)) {
      return true;
    }
    if (ts.isCallExpression(current)) {
      const target = unwrapExpression(current.expression);
      if (
        ts.isPropertyAccessExpression(target) ||
        ts.isElementAccessExpression(target)
      ) {
        const methodName = getCallMethodNameFromExpression(current.expression);
        return !!methodName &&
          ARRAY_IDENTITY_PRESERVING_CHAIN_METHODS.has(methodName) &&
          expressionIsIdentityArrayInitializer(target.expression);
      }
    }
    return false;
  };

  const isCallReceiverForMethod = (
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    methods: ReadonlySet<string>,
  ): boolean => {
    const methodName = getCallMethodNameFromExpression(node);
    return !!methodName &&
      methods.has(methodName) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isExpression(node.initializer) &&
      expressionIsIdentityArrayInitializer(node.initializer)
    ) {
      arrayInitializerLocals.add(node.name.text);
    }

    if (ts.isCallExpression(node)) {
      const methodName = getCallMethodNameFromExpression(node.expression);
      const receiver = getCallReceiverFromExpression(node.expression);
      const receiverIsCellLike = !checker ||
        (receiver &&
          isCellLikeType(checker.getTypeAtLocation(receiver), checker));
      if (methodName === "set" && receiverIsCellLike) {
        for (const argument of node.arguments) {
          const current = unwrapExpression(argument);
          if (ts.isIdentifier(current)) {
            setArgumentLocals.add(current.text);
          }
        }
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const current = unwrapExpression(node.expression);
      const isSetCallReceiver = node.name.text === "set" &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node;
      const isIdentityWriterReceiver = isCallReceiverForMethod(
        node,
        ARRAY_IDENTITY_WRITER_METHODS,
      );
      if (
        ts.isIdentifier(current) && !isSetCallReceiver &&
        !isIdentityWriterReceiver
      ) {
        structurallyAccessedArrayLocals.add(current.text);
      }
    }

    if (ts.isElementAccessExpression(node)) {
      const current = unwrapExpression(node.expression);
      const isSetCallReceiver = node.argumentExpression &&
        isLiteralElement(node.argumentExpression) &&
        getLiteralElementText(node.argumentExpression) === "set" &&
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node;
      const isIdentityWriterReceiver = isCallReceiverForMethod(
        node,
        ARRAY_IDENTITY_WRITER_METHODS,
      );
      if (
        ts.isIdentifier(current) && !isSetCallReceiver &&
        !isIdentityWriterReceiver
      ) {
        structurallyAccessedArrayLocals.add(current.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
  return new Set(
    [...arrayInitializerLocals].filter((name) =>
      setArgumentLocals.has(name) && !structurallyAccessedArrayLocals.has(name)
    ),
  );
}

function getCallReceiverFromExpression(
  expression: ts.Expression,
): ts.Expression | undefined {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return current.expression;
  }
  if (ts.isElementAccessExpression(current)) {
    return current.expression;
  }
  return undefined;
}

function getCallMethodNameFromExpression(
  expression: ts.Expression,
): string | undefined {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return current.name.text;
  }
  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression &&
    isLiteralElement(current.argumentExpression)
  ) {
    return getLiteralElementText(current.argumentExpression);
  }
  return undefined;
}

function isKnownIdentityEqualsCallee(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): boolean {
  const current = unwrapExpression(expr);

  if (ts.isIdentifier(current)) {
    if (current.text !== "equals" && current.text !== "equalLinks") {
      return false;
    }
    if (!checker) {
      return true;
    }
    const symbol = checker.getSymbolAtLocation(current);
    return resolvesToCommonFabricSymbol(symbol, checker, current.text);
  }

  if (ts.isPropertyAccessExpression(current)) {
    if (current.name.text !== "equals" && current.name.text !== "equalLinks") {
      return false;
    }
    return !checker ||
      isCellLikeType(checker.getTypeAtLocation(current.expression), checker);
  }

  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression &&
    isLiteralElement(current.argumentExpression)
  ) {
    const methodName = getLiteralElementText(current.argumentExpression);
    if (methodName !== "equals" && methodName !== "equalLinks") {
      return false;
    }
    return !checker ||
      isCellLikeType(checker.getTypeAtLocation(current.expression), checker);
  }

  return false;
}

function isKnownIdentityEqualsCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): boolean {
  return isKnownIdentityEqualsCallee(call.expression, checker);
}

function isKnownIdentityNavigationCallee(
  expr: ts.Expression,
  checker?: ts.TypeChecker,
): boolean {
  const current = unwrapExpression(expr);
  if (!ts.isIdentifier(current) || current.text !== "navigateTo") {
    return false;
  }
  if (!checker) {
    return true;
  }
  const symbol = checker.getSymbolAtLocation(current);
  return resolvesToCommonFabricSymbol(symbol, checker, "navigateTo");
}

function isKnownIdentityArgumentCall(
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): boolean {
  return isKnownIdentityEqualsCall(call, checker) ||
    isKnownIdentityNavigationCallee(call.expression, checker);
}

function isAliasShape(binding: AliasBinding): binding is AliasShape {
  return "properties" in binding;
}

function isSourceRefBinding(binding: AliasBinding): binding is SourceRef {
  return "root" in binding;
}

function aliasBindingEquals(
  left: AliasBinding,
  right: AliasBinding,
): boolean {
  if (isSourceRefBinding(left) && isSourceRefBinding(right)) {
    return left.root === right.root &&
      left.dynamic === right.dynamic &&
      !!left.arrayElement === !!right.arrayElement &&
      !!left.elementResult === !!right.elementResult &&
      left.path.length === right.path.length &&
      left.path.every((segment, index) => segment === right.path[index]);
  }

  if (isAliasShape(left) && isAliasShape(right)) {
    if (left.properties.size !== right.properties.size) {
      return false;
    }
    for (const [key, leftValue] of left.properties.entries()) {
      const rightValue = right.properties.get(key);
      if (!rightValue || !aliasBindingEquals(leftValue, rightValue)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function clearBindingAliases(
  name: ts.BindingName,
  aliases: Map<string, SourceRef>,
  aliasShapes: Map<string, AliasShape>,
): void {
  if (ts.isIdentifier(name)) {
    aliases.delete(name.text);
    aliasShapes.delete(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    clearBindingAliases(element.name, aliases, aliasShapes);
  }
}

function assignParameterBindingAlias(
  name: ts.BindingName,
  source: AliasBinding | undefined,
  aliases: Map<string, SourceRef>,
  aliasShapes: Map<string, AliasShape>,
  markWildcard: (name: string, path?: readonly string[]) => void,
  checker?: ts.TypeChecker,
): void {
  if (ts.isIdentifier(name)) {
    if (!source) {
      aliases.delete(name.text);
      aliasShapes.delete(name.text);
    } else if (isSourceRefBinding(source)) {
      aliases.set(name.text, source);
      aliasShapes.delete(name.text);
    } else {
      aliases.delete(name.text);
      aliasShapes.set(name.text, source);
    }
    return;
  }

  if (!source) {
    clearBindingAliases(name, aliases, aliasShapes);
    return;
  }

  if (ts.isArrayBindingPattern(name)) {
    if (isSourceRefBinding(source)) {
      markWildcard(source.root, source.path);
    }
    clearBindingAliases(name, aliases, aliasShapes);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;

    if (element.dotDotDotToken || element.initializer) {
      if (isSourceRefBinding(source)) {
        markWildcard(source.root, source.path);
      }
      clearBindingAliases(element.name, aliases, aliasShapes);
      continue;
    }

    let key: string | undefined;
    if (!element.propertyName) {
      if (ts.isIdentifier(element.name)) {
        key = element.name.text;
      }
    } else {
      key = getStaticPropertyKeyText(element.propertyName, checker);
      if (!key && isSourceRefBinding(source)) {
        markWildcard(source.root, source.path);
      }
    }

    if (!key) {
      clearBindingAliases(element.name, aliases, aliasShapes);
      continue;
    }

    assignParameterBindingAlias(
      element.name,
      isSourceRefBinding(source)
        ? extendSourceRef(source, [key])
        : source.properties.get(key),
      aliases,
      aliasShapes,
      markWildcard,
      checker,
    );
  }
}

function toCapability(state: MutableCapabilityState): ReactiveCapability {
  const hasReads = state.reads.size > 0;
  const hasWrites = state.writes.size > 0;

  if (hasReads && hasWrites) return "writable";
  if (hasReads) return "readonly";
  if (hasWrites) return "writeonly";
  if (state.rawComparablePaths.size > 0 && !state.hasNonIdentityUse) {
    return "comparable";
  }
  return "opaque";
}

function normalizeObservedCapabilityUsage(
  state: MutableCapabilityState,
): ObservedCapabilityUsage {
  const readPaths = Array.from(state.reads).map(decodePath);
  const fullShapePaths = Array.from(state.fullShapeReads).map(decodePath);
  const writePaths = Array.from(state.writes).map(decodePath);
  const opaquePaths = Array.from(state.rawOpaquePaths)
    .map(decodePath)
    .filter((opaquePath) =>
      ![
        ...readPaths,
        ...fullShapePaths,
        ...writePaths,
      ].some((path) =>
        path.length >= opaquePath.length &&
        opaquePath.every((segment, index) => path[index] === segment)
      )
    );
  const wildcardPrefixes = Array.from(state.wildcardPaths).map(decodePath);
  const identityPaths = Array.from(state.rawIdentityPaths)
    .map(decodePath)
    .filter((identityPath) => {
      // A wildcard records that unknown reads/writes exist under some
      // static prefix of this root. It must keep suppressing identityOnly
      // (and the scope proofs gated on it), and it must erase identity
      // markings the unknown access can cover — but NOT the markings of
      // disjoint paths. Closure captures share one synthetic root state, so
      // blanket erasure here degraded an equals()-only [SELF] capture to a
      // full-value self-demand that can never satisfy — the consuming node
      // then silently never ran (#4714). Overlap is checked in both
      // directions: a wildcard above the identity path can value-read the
      // compared node; a wildcard below it reaches inside the compared
      // subtree. Markers with no path information use the root prefix and
      // keep the old blanket behavior.
      const overlapsWildcard = wildcardPrefixes.some((wp) =>
        wp.length <= identityPath.length
          ? wp.every((segment, index) => identityPath[index] === segment)
          : identityPath.every((segment, index) => wp[index] === segment)
      );
      if (overlapsWildcard) {
        return false;
      }
      if (identityPath.length === 0 && state.hasNonIdentityRootUse) {
        return false;
      }
      const overlapsNonIdentity = [
        ...readPaths,
        ...fullShapePaths,
        ...writePaths,
        ...opaquePaths,
      ].some((path) =>
        path.length >= identityPath.length &&
        identityPath.every((segment, index) => path[index] === segment)
      );
      return !overlapsNonIdentity;
    });
  const keptIdentityPaths = new Set(identityPaths.map(encodePath));
  const identityCellPaths = Array.from(state.rawIdentityCellPaths)
    .filter((path) => keptIdentityPaths.has(path))
    .map(decodePath);
  const comparablePaths = Array.from(state.rawComparablePaths)
    .filter((path) => keptIdentityPaths.has(path))
    .map(decodePath);
  const keptComparablePaths = new Set(comparablePaths.map(encodePath));
  const comparableCellPaths = Array.from(state.rawComparableCellPaths)
    .filter((path) => keptComparablePaths.has(path))
    .map(decodePath);

  return {
    readPaths,
    fullShapePaths,
    writePaths,
    opaquePaths,
    passthrough: state.passthrough,
    wildcard: state.wildcard,
    hasUnverifiedCellUse: state.hasUnverifiedCellUse,
    identityOnly: identityPaths.some((path) => path.length === 0) &&
      !state.hasNonIdentityUse &&
      state.reads.size === 0 &&
      state.writes.size === 0 &&
      !state.wildcard,
    identityPaths,
    identityCellPaths,
    comparablePaths,
    comparableCellPaths,
  };
}

function buildCapabilityParamSummary(
  name: string,
  state: MutableCapabilityState,
): CapabilityParamSummary {
  const observed = normalizeObservedCapabilityUsage(state);
  return {
    name,
    capability: toCapability(state),
    ...observed,
  };
}

export function analyzeFunctionCapabilities(
  fn: CapabilityAnalyzableFunction,
  options?: CapabilityAnalysisOptions,
): FunctionCapabilitySummary {
  const summaryCache = options?.summaryCache ?? new WeakMap();
  const inProgress = options?.inProgress ?? new WeakSet();
  const cached = summaryCache.get(fn);
  if (cached) {
    return cached;
  }
  if (inProgress.has(fn)) {
    // Recursion detected — return an empty summary so callers skip shrinking
    // for this function. The `recursive` flag lets callers emit a diagnostic
    // if they choose to.
    return { params: [], recursive: true };
  }
  inProgress.add(fn);
  try {
    const checker = options?.checker;
    const typeRegistry = options?.typeRegistry;
    const interprocedural = !!options?.interprocedural && !!checker;
    const includeNestedCallbacks = !!options?.includeNestedCallbacks;
    const summarySourceFile = fn.getSourceFile();

    // Mergeable `push` call sites, explicit read sites (`.get()` and `for..of`
    // iterables), and non-append same-collection write paths, collected only
    // when a misuse sink is given. After the walk, a push site whose receiver
    // path the function also reads is classified by how that read relates to
    // the push and reported through the sink.
    const mergeablePushMisuseSink = options?.mergeablePushMisuseSink;
    const mergeablePushSites: MergeableCollectionSite[] = [];
    const mergeableReadSites: MergeableCollectionSite[] = [];
    const mergeableNonAppendWriteKeys = new Set<string>();
    const mergeableWriteKey = (root: string, encodedPath: string): string =>
      JSON.stringify([root, encodedPath]);
    const recordMergeableReadSite = (ref: SourceRef, node: ts.Node): void => {
      if (!mergeablePushMisuseSink || ref.dynamic) return;
      mergeableReadSites.push({
        root: ref.root,
        encodedPath: encodePath(ref.path),
        node,
      });
    };
    const recordMergeableNonAppendWrite = (ref: SourceRef): void => {
      if (!mergeablePushMisuseSink || ref.dynamic) return;
      mergeableNonAppendWriteKeys.add(
        mergeableWriteKey(ref.root, encodePath(ref.path)),
      );
    };

    if (!fn.body) {
      const empty = { params: [] };
      summaryCache.set(fn, empty);
      return empty;
    }

    const states = new Map<string, MutableCapabilityState>();
    const aliases = new Map<string, SourceRef>();
    const aliasShapes = new Map<string, AliasShape>();
    const optionalPresenceAliases = new Set<string>();
    const localArrayElementBindings = new Map<string, AliasBinding>();
    const localMapValueBindings = new Map<string, AliasBinding>();
    const parameterStateKeys: string[] = [];

    const ensureState = (name: string): MutableCapabilityState => {
      let state = states.get(name);
      if (!state) {
        state = {
          reads: new Set<string>(),
          fullShapeReads: new Set<string>(),
          writes: new Set<string>(),
          rawIdentityPaths: new Set<string>(),
          rawIdentityCellPaths: new Set<string>(),
          rawComparablePaths: new Set<string>(),
          rawComparableCellPaths: new Set<string>(),
          rawOpaquePaths: new Set<string>(),
          passthrough: false,
          wildcard: false,
          wildcardPaths: new Set<string>(),
          hasIdentityUse: false,
          hasNonIdentityUse: false,
          hasNonIdentityRootUse: false,
          hasUnverifiedCellUse: false,
        };
        states.set(name, state);
      }
      return state;
    };

    const trackRead = (
      name: string,
      path: readonly string[],
      options?: { identityOnly?: boolean },
    ): void => {
      const state = ensureState(name);
      state.reads.add(encodePath(path));
      if (options?.identityOnly) {
        state.hasIdentityUse = true;
      } else {
        state.hasNonIdentityUse = true;
      }
    };

    const trackWrite = (name: string, path: readonly string[]): void => {
      const state = ensureState(name);
      state.writes.add(encodePath(path));
      state.hasNonIdentityUse = true;
    };

    const trackFullShapeRead = (
      name: string,
      path: readonly string[],
    ): void => {
      const state = ensureState(name);
      state.fullShapeReads.add(encodePath(path));
      state.hasNonIdentityUse = true;
    };

    const markWildcard = (
      name: string,
      path: readonly string[] = [],
    ): void => {
      const state = ensureState(name);
      state.wildcard = true;
      state.wildcardPaths.add(encodePath(path));
      state.hasNonIdentityUse = true;
    };

    // Unlike markWildcard this does NOT change shrinking or identity
    // classification — it only poisons write-exhaustiveness for consumers
    // that need `writes` to be a closed-world record
    // (`completeSchedulerScopeSummary` is withheld), while everything else
    // behaves as before.
    const markUnverifiedCellUse = (name: string): void => {
      const state = ensureState(name);
      state.hasUnverifiedCellUse = true;
    };

    const markPassthrough = (
      name: string,
      options?: { identityOnly?: boolean },
    ): void => {
      const state = ensureState(name);
      state.passthrough = true;
      if (options?.identityOnly) {
        state.hasIdentityUse = true;
      } else {
        state.hasNonIdentityUse = true;
        state.hasNonIdentityRootUse = true;
      }
    };

    const markOpaqueUse = (name: string, path: readonly string[]): void => {
      const state = ensureState(name);
      state.hasNonIdentityUse = true;
      if (path.length === 0) {
        state.hasNonIdentityRootUse = true;
      }
    };

    const recordOpaquePath = (
      name: string,
      path: readonly string[],
    ): void => {
      const state = ensureState(name);
      state.rawOpaquePaths.add(encodePath(path));
      state.hasNonIdentityUse = true;
      if (path.length === 0) {
        state.hasNonIdentityRootUse = true;
      }
    };

    const recordIdentityPath = (
      name: string,
      path: readonly string[],
      options?: { cellLike?: boolean },
    ): void => {
      const state = ensureState(name);
      const encoded = encodePath(path);
      state.rawIdentityPaths.add(encoded);
      if (options?.cellLike) {
        state.rawIdentityCellPaths.add(encoded);
      }
      state.hasIdentityUse = true;
    };

    const recordComparablePath = (
      name: string,
      path: readonly string[],
      options?: { cellLike?: boolean },
    ): void => {
      recordIdentityPath(name, path, options);
      const state = ensureState(name);
      const encoded = encodePath(path);
      state.rawComparablePaths.add(encoded);
      if (options?.cellLike) {
        state.rawComparableCellPaths.add(encoded);
      }
    };

    const hasRecordedIdentityPath = (
      name: string,
      path: readonly string[],
    ): boolean => {
      return ensureState(name).rawIdentityPaths.has(encodePath(path));
    };

    const hasRecordedIdentityUseRef = (ref: SourceRef): boolean => {
      const materialized = materializeSourceRef(ref);
      if (materialized.dynamic) {
        return false;
      }
      return hasRecordedIdentityPath(materialized.root, materialized.path);
    };

    const isCellLikeExpression = (expr: ts.Expression): boolean => {
      if (!checker) {
        return false;
      }
      return isCellLikeType(checker.getTypeAtLocation(expr), checker);
    };

    const isPrimitiveLikeExpression = (expr: ts.Expression): boolean => {
      // Prefer the transformer-known type: on synthetic callbacks (e.g. the
      // destructure-lowered lift-applied param) the checker resolves bindings
      // to `any`, whose flags match none of the primitive families below — so
      // relying on the checker alone would mis-classify a real primitive as
      // non-primitive and let the presence-only skip drop it from the schema.
      const type = typeRegistry?.get(expr) ??
        (checker ? checker.getTypeAtLocation(expr) : undefined);
      if (!type) {
        return false;
      }
      const flags = type.flags;
      return !!(
        flags &
        (ts.TypeFlags.BooleanLike |
          ts.TypeFlags.NumberLike |
          ts.TypeFlags.StringLike |
          ts.TypeFlags.BigIntLike |
          ts.TypeFlags.ESSymbolLike |
          ts.TypeFlags.EnumLike)
      );
    };

    for (let index = 0; index < fn.parameters.length; index++) {
      const parameter = fn.parameters[index]!;
      const stateKey = ts.isIdentifier(parameter.name)
        ? parameter.name.text
        : `${PARAMETER_SUMMARY_PREFIX}${index}`;
      parameterStateKeys[index] = stateKey;
      ensureState(stateKey);

      if (ts.isIdentifier(parameter.name)) {
        aliases.set(parameter.name.text, {
          root: stateKey,
          path: [],
          dynamic: false,
        });
        continue;
      }

      assignParameterBindingAlias(
        parameter.name,
        {
          root: stateKey,
          path: [],
          dynamic: false,
        },
        aliases,
        aliasShapes,
        markWildcard,
        checker,
      );
    }

    if (parameterStateKeys.length === 0) {
      const empty = { params: [] };
      summaryCache.set(fn, empty);
      return empty;
    }

    // Track .get() CallExpression nodes whose result was resolved with a more
    // specific path (e.g. notes.get().length → ["length"]).  When the
    // READER_METHODS handler encounters these, it skips the blanket [] read.
    const resolvedGetCalls = new Set<ts.Node>();

    // Track alias names (e.g. "notes") that were resolved with specific
    // property paths through a .get() chain.  When the identifier handler
    // encounters a synthetic identifier with no parent pointer, it can skip
    // the blanket read if the alias already has a more specific path.
    const aliasesWithSpecificPaths = new Set<string>();
    const identityArrayLocals = collectArrayLocalsPassedToSet(fn.body, checker);
    const signatureCapabilityArgumentUses = new WeakSet<ts.Expression>();
    // Arguments a callee's own summary charged, so the identifier handler
    // does not also treat them as values that left the analysis.
    const summaryHandledArgumentUses = new WeakSet<ts.Expression>();
    const unreadableCellArguments: UnreadableCellArgument[] = [];

    // Whether a call writes its argument into a local collection — a `push`,
    // `unshift` or `splice` payload on a local array, or the value of a `set`
    // on a local map — which the local collection bindings below follow, so
    // a read through the collection resolves to the value's own paths.
    const isLocalCollectionWrite = (
      call: ts.CallExpression | ts.NewExpression,
      argument: ts.Expression,
    ): boolean => {
      if (!ts.isCallExpression(call)) return false;
      const target = unwrapExpression(call.expression);
      if (
        !ts.isPropertyAccessExpression(target) &&
        !ts.isElementAccessExpression(target)
      ) {
        return false;
      }
      const receiverName = getIdentifierName(target.expression);
      if (
        !receiverName || aliases.has(receiverName) ||
        aliasShapes.has(receiverName)
      ) {
        return false;
      }
      const methodName = getCallMethodName(call.expression);
      if (!methodName) return false;
      if (ARRAY_IDENTITY_WRITER_METHODS.has(methodName)) {
        return isArrayIdentityWriterValueArgument(methodName, call, argument);
      }
      return methodName === "set" && call.arguments[1] === argument;
    };

    // Whether a call is one the runtime answers — a builder, a lift applied
    // to inputs, `ifElse`, a cell factory. Such a call binds its arguments by
    // reference: what reaches it is a link to the value, and whatever reads
    // through that link does so under a schema of its own. Undecidable
    // without a checker, in which case no call is taken to be one.
    const isRuntimeCall = (
      call: ts.CallExpression | ts.NewExpression,
    ): boolean =>
      checker !== undefined &&
      (ts.isCallExpression(call)
          ? detectCallKind(call, checker)
          : detectNewExpressionKind(call, checker)) !== undefined;

    // Whether a call is a write through a cell — `set`, `update`, `send`,
    // `push` and the rest of the writer methods on a cell-like receiver. A
    // write stores a proxy in its payload as a link, the way a result does,
    // so the payload is handed on by reference. Undecidable without a
    // checker, in which case no call is taken to be one.
    const isCellWrite = (
      call: ts.CallExpression | ts.NewExpression,
    ): boolean => {
      if (!ts.isCallExpression(call)) return false;
      const target = unwrapExpression(call.expression);
      if (
        !ts.isPropertyAccessExpression(target) &&
        !ts.isElementAccessExpression(target)
      ) {
        return false;
      }
      const methodName = getCallMethodName(call.expression);
      return methodName !== undefined &&
        (WRITER_METHODS.has(methodName) ||
          ARRAY_IDENTITY_WRITER_METHODS.has(methodName)) &&
        isCellLikeExpression(unwrapAssertCapture(target.expression));
    };

    // Whether a function is the callback of a builder call — `lift(cb)`,
    // `pattern(cb)`, `handler(cb)` — whose result the runtime writes the way
    // it writes this function's own: a proxy in it becomes a link.
    const isBuilderCallback = (node: ts.Node): boolean => {
      const call = node.parent;
      return checker !== undefined && call !== undefined &&
        ts.isCallExpression(call) &&
        call.arguments.some((argument) =>
          unwrapExpression(argument) === node
        ) &&
        detectCallKind(call, checker)?.kind === "builder";
    };

    // Whether what this function returns goes straight back into a caller's
    // body, where the caller reads it as a value, and not into the runtime,
    // which would store a proxy in it as a link.
    const helperReturnsToCaller = returnsToACaller(fn);

    // Whether an identifier's value leaves the analysis whole. A value bound
    // to a local, or written into a local collection, stays tracked. An
    // argument stays tracked when the callee's summary or declared signature
    // charged it, when the callee binds it by reference — a runtime call, a
    // write through a cell — or when the callee only asks its shape. A value
    // a builder's callback returns is handed on by reference, this function's
    // own included when it is one; a helper's return is a value its caller
    // goes on to read. A value read where it stands is charged there.
    const escapesWhole = (node: ts.Expression): boolean => {
      const destination = wholeValueDestination(node);
      switch (destination.kind) {
        case "tracked":
        case "consumed":
          return false;
        case "escaped":
          return true;
        case "result":
          return destination.of === fn
            ? helperReturnsToCaller
            : !isBuilderCallback(destination.of);
        case "argument":
          return !summaryHandledArgumentUses.has(destination.argument) &&
            !signatureCapabilityArgumentUses.has(destination.argument) &&
            !isLocalCollectionWrite(destination.call, destination.argument) &&
            !isRuntimeCall(destination.call) &&
            !isCellWrite(destination.call) &&
            !isArrayIsArrayCall(destination.call, checker);
      }
    };

    const getIdentifierName = (
      expression: ts.Expression,
    ): string | undefined => {
      const current = unwrapExpression(expression);
      return ts.isIdentifier(current) ? current.text : undefined;
    };

    const getCallMethodName = (
      expression: ts.Expression,
    ): string | undefined => {
      const current = unwrapExpression(expression);
      if (ts.isPropertyAccessExpression(current)) {
        return current.name.text;
      }
      if (
        ts.isElementAccessExpression(current) &&
        current.argumentExpression &&
        isLiteralElement(current.argumentExpression)
      ) {
        return getLiteralElementText(current.argumentExpression);
      }
      return undefined;
    };

    const resolveShapePath = (
      binding: AliasBinding | undefined,
      path: readonly string[],
    ): AliasBinding | undefined => {
      if (!binding) return undefined;
      if (path.length === 0) {
        return binding;
      }
      if (isSourceRefBinding(binding)) {
        return extendSourceRef(binding, path);
      }

      const [head, ...tail] = path;
      const child = binding.properties.get(head!);
      return resolveShapePath(child, tail);
    };

    const resolveBinding = (
      expression: ts.Expression,
    ): AliasBinding | undefined => {
      const current = unwrapExpression(expression);
      if (
        ts.isBinaryExpression(current) &&
        FALLBACK_OPERATORS.has(current.operatorToken.kind)
      ) {
        const left = resolveBinding(current.left);
        const right = resolveBinding(current.right);
        if (left && right) {
          return aliasBindingEquals(left, right) ? left : undefined;
        }
        return left ?? right;
      }

      const info = extractAccessPath(current, checker);
      if (info) {
        const alias = aliases.get(info.root);
        if (alias) {
          const resolved = extendSourceRef(alias, info.path);
          return {
            root: resolved.root,
            path: resolved.path,
            dynamic: resolved.dynamic || info.dynamic,
            elementResult: resolved.elementResult,
          };
        }

        if (!info.dynamic) {
          const shape = aliasShapes.get(info.root);
          const resolved = resolveShapePath(shape, info.path);
          if (resolved) {
            return resolved;
          }
        }
      }

      if (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
      ) {
        const innerBinding = resolveBinding(current.expression) ??
          (ts.isCallExpression(current.expression)
            ? buildAliasBindingFromExpression(current.expression)
            : undefined);
        if (innerBinding) {
          if (ts.isPropertyAccessExpression(current)) {
            if (ts.isCallExpression(current.expression)) {
              resolvedGetCalls.add(current.expression);
            }
            return resolveShapePath(innerBinding, [current.name.text]);
          }
          if (
            ts.isElementAccessExpression(current) &&
            isLiteralElement(current.argumentExpression)
          ) {
            if (ts.isCallExpression(current.expression)) {
              resolvedGetCalls.add(current.expression);
            }
            return resolveShapePath(innerBinding, [
              getLiteralElementText(current.argumentExpression),
            ]);
          }
        }
      }

      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression)
      ) {
        const methodName = current.expression.name.text;
        const localMapName = getIdentifierName(current.expression.expression);
        if (methodName === "get" && localMapName) {
          const localBinding = localMapValueBindings.get(localMapName);
          if (localBinding) {
            return localBinding;
          }
        }

        const receiverBinding = resolveBinding(current.expression.expression);
        if (receiverBinding && isSourceRefBinding(receiverBinding)) {
          if (methodName === "get" && current.arguments.length === 0) {
            return receiverBinding;
          }
          if (methodName === "key") {
            const argPath = extractLiteralPathArguments(
              current.arguments,
              checker,
            );
            if (argPath.dynamic) {
              return {
                ...receiverBinding,
                dynamic: true,
              };
            }
            return {
              root: receiverBinding.root,
              path: [...receiverBinding.path, ...argPath.path],
              dynamic: receiverBinding.dynamic,
            };
          }
          // elementById addresses a separate, deterministically derived entity,
          // not a static path into the array. Resolve it to a dynamic binding on
          // the array root so reads and writes through it are attributed
          // conservatively to the array the handler already touches.
          if (methodName === "elementById") {
            return {
              ...receiverBinding,
              dynamic: true,
            };
          }
        }
      }

      return undefined;
    };

    const resolveSourceRef = (
      expression: ts.Expression,
    ): SourceRef | undefined => {
      const binding = resolveBinding(expression);
      return binding && isSourceRefBinding(binding) ? binding : undefined;
    };

    const resolveConservativeCallReceiverRef = (
      call: ts.CallExpression,
    ): SourceRef | undefined => {
      const target = unwrapExpression(call.expression);
      if (
        !ts.isPropertyAccessExpression(target) &&
        !ts.isElementAccessExpression(target)
      ) {
        return undefined;
      }

      const direct = resolveSourceRef(target.expression);
      if (direct) {
        return direct;
      }

      return ts.isCallExpression(target.expression)
        ? resolveConservativeCallReceiverRef(target.expression)
        : undefined;
    };

    const buildAliasBindingFromExpression = (
      expression: ts.Expression,
    ): AliasBinding | undefined => {
      const direct = resolveBinding(expression);
      if (direct) {
        return direct;
      }

      const current = unwrapExpression(expression);
      if (
        ts.isCallExpression(current) &&
        (
          ts.isPropertyAccessExpression(current.expression) ||
          ts.isElementAccessExpression(current.expression)
        )
      ) {
        const receiverExpr = current.expression.expression;
        const methodName = getCallMethodName(current.expression);
        if (
          receiverExpr &&
          (methodName === "filter" || methodName === "sort" ||
            methodName === "toSorted")
        ) {
          return resolveBinding(receiverExpr);
        }

        if (
          receiverExpr &&
          (methodName === "find" || methodName === "findLast" ||
            methodName === "at")
        ) {
          const binding = resolveArrayElementBinding(receiverExpr);
          if (binding && isSourceRefBinding(binding)) {
            return {
              root: binding.root,
              path: binding.path,
              dynamic: binding.dynamic,
              arrayElement: true,
              elementResult: true,
            };
          }
        }
      }

      if (!ts.isObjectLiteralExpression(current)) {
        return undefined;
      }

      const properties = new Map<string, AliasBinding>();
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) {
          return undefined;
        }

        if (ts.isShorthandPropertyAssignment(property)) {
          const binding = resolveBinding(property.name);
          if (binding) {
            properties.set(property.name.text, binding);
          }
          continue;
        }

        if (!ts.isPropertyAssignment(property)) {
          continue;
        }

        const key = getStaticPropertyKeyText(property.name, checker);
        if (!key) {
          return undefined;
        }

        const binding = buildAliasBindingFromExpression(property.initializer);
        if (binding) {
          properties.set(key, binding);
        }
      }

      return properties.size > 0 ? { properties } : undefined;
    };

    const mergeAliasBinding = (
      current: AliasBinding | undefined,
      next: AliasBinding | undefined,
    ): AliasBinding | undefined => {
      if (!next) return current;
      if (!current) return next;
      return aliasBindingEquals(current, next) ? current : undefined;
    };

    const updateLocalCollectionBinding = (
      bindings: Map<string, AliasBinding>,
      name: string,
      next: AliasBinding | undefined,
    ): void => {
      if (!next) {
        bindings.delete(name);
        return;
      }

      const merged = mergeAliasBinding(bindings.get(name), next);
      if (merged) {
        bindings.set(name, merged);
      } else {
        bindings.delete(name);
      }
    };

    const resolveArrayElementBinding = (
      expression: ts.Expression,
    ): AliasBinding | undefined => {
      const current = unwrapExpression(expression);
      if (ts.isCallExpression(current)) {
        const target = unwrapExpression(current.expression);
        const receiverExpr = ts.isPropertyAccessExpression(target) ||
            ts.isElementAccessExpression(target)
          ? target.expression
          : undefined;
        const methodName = getCallMethodName(current.expression);
        if (
          receiverExpr &&
          (methodName === "filter" || methodName === "sort" ||
            methodName === "toSorted")
        ) {
          return resolveArrayElementBinding(receiverExpr);
        }
      }

      const localName = getIdentifierName(expression);
      if (localName) {
        const localBinding = localArrayElementBindings.get(localName);
        if (localBinding) {
          return localBinding;
        }
      }

      const source = resolveSourceRef(expression);
      if (!source) {
        return undefined;
      }
      return {
        root: source.root,
        path: source.path,
        dynamic: source.dynamic,
        arrayElement: true,
      };
    };

    const clearLocalCollectionBindings = (name: string): void => {
      localArrayElementBindings.delete(name);
      localMapValueBindings.delete(name);
    };

    const scopedLocalCollectionNamesStack: Array<Set<string>> = [];

    const markScopedLocalCollectionName = (name: string): void => {
      const currentScope = scopedLocalCollectionNamesStack[
        scopedLocalCollectionNamesStack.length - 1
      ];
      currentScope?.add(name);
    };

    const clearScopedLocalCollectionBindingNames = (
      name: ts.BindingName,
    ): void => {
      if (ts.isIdentifier(name)) {
        markScopedLocalCollectionName(name.text);
        clearLocalCollectionBindings(name.text);
        return;
      }

      for (const element of name.elements) {
        if (ts.isOmittedExpression(element)) continue;
        clearScopedLocalCollectionBindingNames(element.name);
      }
    };

    const restoreScopedLocalCollectionBindings = (
      names: ReadonlySet<string>,
      savedArrayElementBindings: ReadonlyMap<string, AliasBinding>,
      savedMapValueBindings: ReadonlyMap<string, AliasBinding>,
    ): void => {
      for (const name of names) {
        const arrayBinding = savedArrayElementBindings.get(name);
        if (arrayBinding) {
          localArrayElementBindings.set(name, arrayBinding);
        } else {
          localArrayElementBindings.delete(name);
        }

        const mapBinding = savedMapValueBindings.get(name);
        if (mapBinding) {
          localMapValueBindings.set(name, mapBinding);
        } else {
          localMapValueBindings.delete(name);
        }
      }
    };

    const visitScopedLocalCollectionBindings = (visitor: () => void): void => {
      const savedLocalArrayElementBindings = new Map(
        localArrayElementBindings,
      );
      const savedLocalMapValueBindings = new Map(localMapValueBindings);
      const scopedLocalCollectionNames = new Set<string>();
      scopedLocalCollectionNamesStack.push(scopedLocalCollectionNames);

      try {
        visitor();
      } finally {
        scopedLocalCollectionNamesStack.pop();
        restoreScopedLocalCollectionBindings(
          scopedLocalCollectionNames,
          savedLocalArrayElementBindings,
          savedLocalMapValueBindings,
        );
      }
    };

    const recordLocalArrayIdentityWrite = (
      arrayName: string,
      args: readonly ts.Expression[],
    ): void => {
      let next = localArrayElementBindings.get(arrayName);
      for (const arg of args) {
        next = mergeAliasBinding(next, buildAliasBindingFromExpression(arg));
        if (!next) {
          break;
        }
      }
      if (next) {
        localArrayElementBindings.set(arrayName, next);
      } else {
        localArrayElementBindings.delete(arrayName);
      }
    };

    const recordLocalMapSet = (
      mapName: string,
      valueExpr: ts.Expression | undefined,
    ): void => {
      updateLocalCollectionBinding(
        localMapValueBindings,
        mapName,
        valueExpr ? buildAliasBindingFromExpression(valueExpr) : undefined,
      );
    };

    const trackReadRef = (
      ref: SourceRef,
      options?: { identityOnly?: boolean },
    ): void => {
      if (ref.dynamic) {
        markWildcard(ref.root, ref.path);
        return;
      }
      trackRead(ref.root, ref.path, options);
    };

    const trackWriteRef = (ref: SourceRef): void => {
      if (ref.dynamic) {
        markWildcard(ref.root, ref.path);
        return;
      }
      trackWrite(ref.root, ref.path);
    };

    const trackFullShapeReadRef = (ref: SourceRef): void => {
      if (ref.dynamic) {
        markWildcard(ref.root, ref.path);
        return;
      }
      trackFullShapeRead(ref.root, ref.path);
    };

    const assignBindingAlias = (
      name: ts.BindingName,
      source: AliasBinding | undefined,
    ): void => {
      assignParameterBindingAlias(
        name,
        source,
        aliases,
        aliasShapes,
        markWildcard,
        checker,
      );
    };

    const assignExpressionPatternAlias = (
      pattern: ts.Expression,
      source: AliasBinding | undefined,
    ): void => {
      if (ts.isParenthesizedExpression(pattern)) {
        assignExpressionPatternAlias(pattern.expression, source);
        return;
      }

      if (ts.isIdentifier(pattern)) {
        assignBindingAlias(pattern, source);
        return;
      }

      if (ts.isObjectLiteralExpression(pattern)) {
        if (!source) {
          for (const property of pattern.properties) {
            if (ts.isShorthandPropertyAssignment(property)) {
              aliases.delete(property.name.text);
              aliasShapes.delete(property.name.text);
            } else if (ts.isPropertyAssignment(property)) {
              assignExpressionPatternAlias(property.initializer, undefined);
            }
          }
          return;
        }

        for (const property of pattern.properties) {
          if (ts.isSpreadAssignment(property)) {
            if (isSourceRefBinding(source)) {
              markWildcard(source.root, source.path);
            }
            continue;
          }

          if (ts.isShorthandPropertyAssignment(property)) {
            const binding = isSourceRefBinding(source)
              ? extendSourceRef(source, [property.name.text])
              : source.properties.get(property.name.text);
            if (binding && isSourceRefBinding(binding)) {
              trackRead(binding.root, binding.path);
            }
            assignBindingAlias(property.name, binding);
            continue;
          }

          if (!ts.isPropertyAssignment(property)) {
            continue;
          }

          const key = getStaticPropertyKeyText(property.name, checker);
          if (!key && isSourceRefBinding(source)) {
            markWildcard(source.root, source.path);
          }

          if (!key) {
            assignExpressionPatternAlias(property.initializer, undefined);
            continue;
          }

          const binding = isSourceRefBinding(source)
            ? extendSourceRef(source, [key])
            : source.properties.get(key);
          if (binding && isSourceRefBinding(binding)) {
            trackRead(binding.root, binding.path);
          }
          assignExpressionPatternAlias(property.initializer, binding);
        }
        return;
      }

      if (ts.isArrayLiteralExpression(pattern)) {
        if (source && isSourceRefBinding(source)) {
          markWildcard(source.root, source.path);
        }
        for (const element of pattern.elements) {
          if (ts.isSpreadElement(element)) {
            continue;
          }
          assignExpressionPatternAlias(element, undefined);
        }
      }
    };

    const markWildcardFromExpression = (expression: ts.Expression): void => {
      const ref = resolveSourceRef(expression);
      if (!ref) return;
      markWildcard(ref.root, ref.path);
    };

    const markFromExpression = (
      expression: ts.Expression,
      marker: (name: string, path: readonly string[]) => void,
    ): void => {
      const ref = resolveSourceRef(expression);
      if (!ref) return;
      if (ref.dynamic) {
        markWildcard(ref.root, ref.path);
        return;
      }
      marker(ref.root, ref.path);
    };

    const markIdentityUseRef = (
      ref: SourceRef,
      expr?: ts.Expression,
      options?: { comparable?: boolean },
    ): void => {
      const cellLike = expr
        ? isCellLikeExpression(expr) || !isPrimitiveLikeExpression(expr)
        : false;
      const record = options?.comparable
        ? recordComparablePath
        : recordIdentityPath;
      if (ref.dynamic) {
        markWildcard(ref.root, ref.path);
      } else if (ref.path.length === 0) {
        record(ref.root, [], { cellLike });
        markPassthrough(ref.root, { identityOnly: true });
      } else {
        record(ref.root, ref.path, { cellLike });
      }
    };

    const markArrayItemIdentityUseRef = (ref: SourceRef): void => {
      const materialized = materializeSourceRef(ref);
      if (materialized.dynamic) {
        markWildcard(materialized.root, materialized.path);
        return;
      }
      recordIdentityPath(materialized.root, [...materialized.path, "0"]);
    };

    const resolveInterproceduralSummary = (
      call: ts.CallExpression,
    ): FunctionCapabilitySummary | undefined => {
      if (!interprocedural || !checker) return undefined;
      const signature = checker.getResolvedSignature(call);
      if (!signature) return undefined;
      const declaration = signature.declaration;
      if (!isInterproceduralSummaryTarget(declaration, summarySourceFile)) {
        return undefined;
      }

      return analyzeFunctionCapabilities(declaration, {
        checker,
        typeRegistry,
        interprocedural: true,
        summaryCache,
        inProgress,
      });
    };

    // Apply the capability an out-of-file callee declares for a cell argument
    // through its Common Fabric wrapper parameter type. Body analysis cannot see
    // what the callee does with the cell, so the declared wrapper type is the
    // contract: it accounts for that argument at that call and replaces the
    // conservative default. Returns the handled argument indices so the
    // whole-cell root fallback skips them; the argument's usage site is recorded
    // so ordinary identifier handling does not add a second, broader read.
    const applySignatureCellCapabilities = (
      call: ts.CallExpression | ts.NewExpression,
    ): Set<number> => {
      const handled = new Set<number>();
      if (!checker) return handled;

      const signature = checker.getResolvedSignature(call);
      if (!signature) return handled;
      if (!isSignatureDeclaredOutsideSourceFile(signature, summarySourceFile)) {
        return handled;
      }

      const args = call.arguments;
      if (!args) return handled;

      // `index` walks the argument list; `paramIndex` walks parameter
      // positions. The two diverge only when a fixed-length tuple spread expands
      // into several positions, so the loop update advances `paramIndex` by one
      // per argument and the tuple branch adds the remaining positions.
      for (
        let index = 0, paramIndex = 0;
        index < args.length;
        index++, paramIndex++
      ) {
        const argument = args[index];
        if (!argument) continue;

        const parameter = getParameterAtArgument(signature, paramIndex);
        const isSpreadArgument = ts.isSpreadElement(argument);
        // An array spread into a fixed parameter has unknown runtime length, so
        // it cannot be matched to later fixed parameters. A spread of a
        // fixed-length tuple is the exception: its positions are statically
        // known, so expand each tuple element to its corresponding parameter. A
        // spread into a rest parameter is a collection of rest elements,
        // recorded below at the representative array-item path.
        if (isSpreadArgument && !isRestParameter(parameter)) {
          const tupleLength = getFixedTupleElementCount(
            checker.getTypeAtLocation(argument.expression),
            checker,
          );
          if (tupleLength === undefined) break;

          const spreadSource = resolveSourceRef(argument.expression);
          // Suppress the ordinary read of the spread source only when the
          // contract accounts for every tuple position: a dynamic source is
          // wholly wildcarded, and a static source qualifies only if every
          // element maps to a recognized cell wrapper. A tuple with a non-cell
          // position leaves that position to conservative read tracking.
          const suppressOrdinaryRead = () => {
            handled.add(index);
            signatureCapabilityArgumentUses.add(
              outermostTransparentWrapper(argument.expression),
            );
          };
          if (spreadSource) {
            if (spreadSource.dynamic) {
              markWildcard(spreadSource.root);
              suppressOrdinaryRead();
            } else {
              let mappedCount = 0;
              for (let element = 0; element < tupleLength; element++) {
                const elementParameter = getParameterAtArgument(
                  signature,
                  paramIndex + element,
                );
                const elementCellKind = getParameterDeclaredCellKind(
                  elementParameter,
                  checker,
                );
                if (!elementCellKind) continue;
                mappedCount++;
                const elementPath = [...spreadSource.path, String(element)];
                switch (elementCellKind) {
                  case "cell":
                    trackRead(spreadSource.root, elementPath);
                    trackWrite(spreadSource.root, elementPath);
                    break;
                  case "readonly":
                    trackRead(spreadSource.root, elementPath);
                    break;
                  case "writeonly":
                    trackWrite(spreadSource.root, elementPath);
                    break;
                  case "comparable":
                    recordComparablePath(spreadSource.root, elementPath, {
                      cellLike: true,
                    });
                    break;
                  case "opaque":
                  case "stream":
                  case "sqlite":
                    recordOpaquePath(spreadSource.root, elementPath);
                    break;
                }
              }
              if (mappedCount === tupleLength) suppressOrdinaryRead();
            }
          }
          // The loop update advances `paramIndex` by one; the tuple fills
          // `tupleLength` positions, so add the rest here.
          paramIndex += tupleLength - 1;
          continue;
        }

        const capabilityArgument = isSpreadArgument
          ? argument.expression
          : argument;
        const source = resolveSourceRef(capabilityArgument);
        if (!source) continue;

        const cellKind = getParameterDeclaredCellKind(parameter, checker);
        if (!cellKind) {
          // The parameter type is not a recognized wrapper. Flag only the
          // genuinely ambiguous shape: a union that mixes a cell wrapper with an
          // unresolvable member (the overload-split case), and only when an
          // actual cell argument flows there. Value-or-cell framework types and
          // bare `Cell<T>`/generics/`any` are intentionally not flagged.
          const effectiveTypeNode = getEffectiveParameterTypeNode(parameter);
          if (
            isAmbiguousCellWrapperUnion(effectiveTypeNode, checker) &&
            isBrandedCellType(
              checker.getTypeAtLocation(capabilityArgument),
              checker,
            )
          ) {
            unreadableCellArguments.push({
              node: capabilityArgument,
              message: buildUnreadableCellArgumentMessage(effectiveTypeNode),
            });
          }
          continue;
        }

        handled.add(index);
        signatureCapabilityArgumentUses.add(
          outermostTransparentWrapper(capabilityArgument),
        );

        if (source.dynamic) {
          markWildcard(source.root, source.path);
          continue;
        }

        const sourcePath = isSpreadArgument
          ? [...source.path, "0"]
          : source.path;

        switch (cellKind) {
          case "cell":
            trackRead(source.root, sourcePath);
            trackWrite(source.root, sourcePath);
            break;
          case "readonly":
            trackRead(source.root, sourcePath);
            break;
          case "writeonly":
            trackWrite(source.root, sourcePath);
            break;
          case "comparable":
            recordComparablePath(source.root, sourcePath, {
              cellLike: true,
            });
            break;
          case "opaque":
          case "stream":
          case "sqlite":
            recordOpaquePath(source.root, sourcePath);
            break;
        }
      }

      return handled;
    };

    const visitScopedFunctionBody = (
      callback: CapabilityAnalyzableFunction,
      paramBindings?: ReadonlyMap<number, AliasBinding>,
    ): void => {
      const savedAliases = new Map(aliases);
      const savedAliasShapes = new Map(aliasShapes);
      const savedOptionalPresenceAliases = new Set(optionalPresenceAliases);
      const savedSpecificPaths = new Set(aliasesWithSpecificPaths);
      const savedLocalArrayElementBindings = new Map(
        localArrayElementBindings,
      );
      const savedLocalMapValueBindings = new Map(localMapValueBindings);
      const scopedLocalCollectionNames = new Set<string>();
      scopedLocalCollectionNamesStack.push(scopedLocalCollectionNames);

      try {
        if (callback.name && ts.isIdentifier(callback.name)) {
          aliases.delete(callback.name.text);
          aliasShapes.delete(callback.name.text);
        }
        for (const [index, parameter] of callback.parameters.entries()) {
          clearScopedLocalCollectionBindingNames(parameter.name);
          clearBindingAliases(parameter.name, aliases, aliasShapes);
          const binding = paramBindings?.get(index);
          if (binding) {
            assignBindingAlias(parameter.name, binding);
          }
        }

        const body = callback.body;
        if (!body) return;

        if (ts.isBlock(body)) {
          for (const statement of body.statements) {
            visit(statement);
          }
        } else {
          visit(body);
        }
      } finally {
        scopedLocalCollectionNamesStack.pop();
        aliases.clear();
        for (const [name, source] of savedAliases) {
          aliases.set(name, source);
        }
        aliasShapes.clear();
        for (const [name, shape] of savedAliasShapes) {
          aliasShapes.set(name, shape);
        }
        optionalPresenceAliases.clear();
        for (const name of savedOptionalPresenceAliases) {
          optionalPresenceAliases.add(name);
        }
        aliasesWithSpecificPaths.clear();
        for (const name of savedSpecificPaths) {
          aliasesWithSpecificPaths.add(name);
        }
        restoreScopedLocalCollectionBindings(
          scopedLocalCollectionNames,
          savedLocalArrayElementBindings,
          savedLocalMapValueBindings,
        );
      }
    };

    const visitInlineEagerCallbackArguments = (
      call: ts.CallExpression,
    ): void => {
      if (!checker) return;

      const callbackContainerKind = classifyArrayCallbackContainerCall(
        call,
        checker,
      );
      if (!callbackContainerKind) {
        return;
      }

      const callbackArg = call.arguments[0] &&
        unwrapExpression(call.arguments[0]);
      if (!callbackArg || !isCapabilityAnalyzableFunction(callbackArg)) {
        return;
      }

      const paramBindings = new Map<number, AliasBinding>();
      const target = unwrapExpression(call.expression);
      const receiverExpr = ts.isPropertyAccessExpression(target) ||
          ts.isElementAccessExpression(target)
        ? target.expression
        : undefined;
      const itemBinding = receiverExpr
        ? resolveArrayElementBinding(receiverExpr)
        : undefined;
      const methodName = getCallMethodName(call.expression);
      if (itemBinding) {
        if (callbackArg.parameters[0]) {
          paramBindings.set(0, itemBinding);
        }
        if (
          callbackArg.parameters[1] &&
          (methodName === "sort" || methodName === "toSorted")
        ) {
          paramBindings.set(1, itemBinding);
        }
      }

      visitScopedFunctionBody(
        callbackArg,
        paramBindings.size > 0 ? paramBindings : undefined,
      );
    };

    const visit = (node: ts.Node): void => {
      if (node !== fn && isCapabilityAnalyzableFunction(node)) {
        if (includeNestedCallbacks) {
          visitScopedFunctionBody(node);
        }
        return;
      }

      if (
        ts.isBinaryExpression(node) &&
        FALLBACK_OPERATORS.has(node.operatorToken.kind)
      ) {
        const leftExpr = unwrapExpression(node.left);
        const shouldVisitNestedFallbackLeft = ts.isBinaryExpression(leftExpr) &&
          FALLBACK_OPERATORS.has(leftExpr.operatorToken.kind);

        if (shouldVisitNestedFallbackLeft) {
          visit(node.left);
        } else {
          const leftRef = resolveSourceRef(node.left);
          if (leftRef) {
            if (leftRef.dynamic) {
              markWildcard(leftRef.root);
            } else if (leftRef.path.length === 0) {
              markPassthrough(leftRef.root);
              if (helperReturnsToCaller && escapesWhole(node.left)) {
                trackFullShapeRead(leftRef.root, []);
              }
            } else {
              trackReadRef(leftRef);
              // The identifier or member on the left is never visited, so
              // this is where it is asked whether its value, which is the
              // fallback expression's whenever it is there, leaves whole.
              if (
                !isPrimitiveLikeExpression(node.left) &&
                escapesWhole(node.left)
              ) {
                trackFullShapeReadRef(leftRef);
              }
            }
            // Resolving the ref stood in for walking the operand, so a call on
            // its spine has gone unvisited and the reads inside that call's
            // arguments are still unrecorded — the ref for
            // `table.find((row) => equals(self, row.topic))?.mentionedBy ?? []`
            // records `mentionedBy` and drops both `self` and each row's
            // `topic`, shrinking them out of the schema. Walk it, as the for..of
            // iterable below does for the same reason; the read tracked above is
            // a set entry, so recording it twice costs nothing.
            if (memberSpineContainsCall(node.left)) {
              visit(node.left);
            }
          } else {
            visit(node.left);
          }
        }
        visit(node.right);
        return;
      }

      if (
        ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind)
      ) {
        // Process RHS first so alias rebinding happens after reads in the assignment expression.
        visit(node.right);
        if (!ts.isIdentifier(node.left)) {
          visit(node.left);
        }

        const operator = node.operatorToken.kind;
        if (operator === ts.SyntaxKind.EqualsToken) {
          if (ts.isIdentifier(node.left)) {
            clearLocalCollectionBindings(node.left.text);
            assignBindingAlias(
              node.left,
              buildAliasBindingFromExpression(node.right),
            );
          } else if (
            ts.isObjectLiteralExpression(node.left) ||
            ts.isArrayLiteralExpression(node.left)
          ) {
            const nextRef = buildAliasBindingFromExpression(node.right);
            assignExpressionPatternAlias(node.left, nextRef);
          } else {
            markFromExpression(node.left, trackWrite);
          }
        } else {
          if (ts.isIdentifier(node.left)) {
            aliases.delete(node.left.text);
            aliasShapes.delete(node.left.text);
            clearLocalCollectionBindings(node.left.text);
          } else {
            markFromExpression(node.left, trackWrite);
            markFromExpression(node.left, trackRead);
          }
        }

        return;
      }

      if (ts.isIdentifier(node)) {
        if (isDeclarationIdentifier(node)) {
          // Ignore declaration sites.
        } else if (isNonValueIdentifierUsage(node)) {
          // Ignore key names and non-value positions.
        } else {
          const source = aliases.get(node.text);
          const held = source === undefined
            ? aliasShapes.get(node.text) ??
              localArrayElementBindings.get(node.text) ??
              localMapValueBindings.get(node.text)
            : undefined;
          if (
            held !== undefined && !isMemberRootIdentifier(node) &&
            // An array the body fills and hands to `.set()` is written by
            // identity, which the identity accounting above records.
            !identityArrayLocals.has(node.text) &&
            escapesWhole(node)
          ) {
            // A local built from tracked values — an object literal, an
            // array or map the body filled — leaves whole: returned, put in
            // an array, handed to a callee with no summary. Each value it
            // holds may be read in full where it lands. A member read
            // through the local resolves to its own path instead and is
            // charged where it occurs.
            forEachSourceRefLeaf(held, (leaf) => {
              const ref = materializeSourceRef(leaf);
              if (ref.path.length === 0 && !ref.dynamic) {
                markPassthrough(ref.root);
                if (helperReturnsToCaller) trackFullShapeRead(ref.root, []);
              } else {
                trackReadRef(ref);
                trackFullShapeReadRef(ref);
              }
            });
          }
          if (source && !isMemberRootIdentifier(node)) {
            const resolvedSource = materializeSourceRef(source);
            const usage = outermostTransparentWrapper(node);
            const parent = usage.parent;
            // A value below the root that leaves the analysis whole is read
            // in full wherever it lands, so it is charged as a full-shape
            // read rather than a plain one: a plain read at a path keeps the
            // whole value only while nothing below that path is read, and
            // a member the body did read would otherwise narrow the escaped
            // value to that member. A builder's root is left to the
            // passthrough accounting below. A helper's root is charged as
            // well, so that its summary tells a caller the argument left
            // whole, at whatever path the caller passed it from.
            const wholeValueEscape = !resolvedSource.dynamic &&
              (resolvedSource.path.length > 0 || helperReturnsToCaller) &&
              escapesWhole(node);
            if (!parent) {
              // Synthetic identifiers can temporarily be detached from parent links.
              // Preserve narrowed-path reads while avoiding false root-read expansion.
              if (!resolvedSource.dynamic && resolvedSource.path.length === 0) {
                markPassthrough(resolvedSource.root);
              } else if (aliasesWithSpecificPaths.has(node.text)) {
                // This alias was already resolved with specific property paths
                // (e.g. notes.get().length → ["notes", "length"]).  The blanket
                // read from the detached identifier is redundant.
                markPassthrough(resolvedSource.root);
              } else {
                trackReadRef(resolvedSource);
              }
            } else if (
              source.elementResult &&
              isBooleanConditionUsage(usage)
            ) {
              // Truthiness checks on array-element aliases (e.g. find() results)
              // don't require loading the element payload.
            } else if (
              source.path.length > 0 &&
              !source.dynamic &&
              (optionalPresenceAliases.has(node.text) ||
                !isPrimitiveLikeExpression(usage)) &&
              isBooleanConditionUsage(usage)
            ) {
              // Truthiness checks on a non-primitive source property only
              // require presence, not the aliased payload shape. Recording
              // nothing keeps such a (typically nullable, possibly
              // transiently-undefined) reactive value out of the required input
              // set, so an action/lift gated on it still runs when it is absent.
              //
              // Primitives are handled differently: their value *is* their
              // presence and a required primitive is never legitimately
              // `undefined`, so dropping it would be a real bug (lunch-poll
              // `isAdmin`). `isPrimitiveLikeExpression` — now type-registry
              // aware so it sees through synthetic `any` params — routes
              // primitives to the full read above instead of into this skip.
            } else if (
              signatureCapabilityArgumentUses.has(usage)
            ) {
              // Explicit Common Fabric cell parameter types account for this
              // argument.
            } else if (
              !(
                parent &&
                ts.isPropertyAccessExpression(parent) &&
                parent.name === usage
              ) && !(
                parent &&
                ts.isBinaryExpression(parent) &&
                parent.left === usage &&
                isAssignmentOperator(parent.operatorToken.kind)
              ) && !(
                parent &&
                (ts.isPrefixUnaryExpression(parent) ||
                  ts.isPostfixUnaryExpression(parent)) &&
                parent.operand === usage &&
                (
                  parent.operator === ts.SyntaxKind.PlusPlusToken ||
                  parent.operator === ts.SyntaxKind.MinusMinusToken
                )
              )
            ) {
              const identityOnlyArgumentUse = !!(
                parent &&
                ts.isCallExpression(parent) &&
                parent.arguments.includes(usage) &&
                isKnownIdentityArgumentCall(parent, checker)
              );
              const identityArrayLocal =
                getIdentityArrayLocalNameForElementUsage(usage);
              const identityOnlyArrayElementUse = !!identityArrayLocal &&
                identityArrayLocals.has(identityArrayLocal);
              const identityArrayWriterLocal =
                getIdentityArrayLocalNameForWriterArgumentUsage(usage);
              const identityOnlyArrayWriterArgumentUse =
                !!identityArrayWriterLocal &&
                identityArrayLocals.has(identityArrayWriterLocal);
              const arrayIdentityWriterArgumentUse =
                isArrayIdentityWriterArgumentUsage(usage);
              if (
                arrayIdentityWriterArgumentUse &&
                !identityOnlyArrayWriterArgumentUse
              ) {
                if (
                  source.arrayElement &&
                  !resolvedSource.dynamic
                ) {
                  trackReadRef(resolvedSource);
                }
                if (
                  hasRecordedIdentityUseRef(source) &&
                  !resolvedSource.dynamic
                ) {
                  recordIdentityPath(resolvedSource.root, resolvedSource.path, {
                    cellLike: isCellLikeExpression(usage),
                  });
                } else {
                  trackReadRef(resolvedSource);
                }
              } else if (
                isCallOrNewArgumentUsage(usage) ||
                isPassThroughIdentifierUsage(node) ||
                wholeValueEscape ||
                identityOnlyArrayElementUse ||
                identityOnlyArrayWriterArgumentUse
              ) {
                if (
                  resolvedSource.path.length === 0 && !resolvedSource.dynamic
                ) {
                  if (identityOnlyArgumentUse) {
                    recordIdentityPath(resolvedSource.root, [], {
                      cellLike: isCellLikeExpression(usage),
                    });
                  }
                  markPassthrough(
                    resolvedSource.root,
                    identityOnlyArgumentUse
                      ? { identityOnly: true }
                      : undefined,
                  );
                  if (wholeValueEscape && !identityOnlyArgumentUse) {
                    trackFullShapeRead(resolvedSource.root, []);
                  }
                } else if (
                  identityOnlyArgumentUse && !resolvedSource.dynamic
                ) {
                  recordIdentityPath(resolvedSource.root, resolvedSource.path, {
                    cellLike: isCellLikeExpression(usage),
                  });
                } else if (
                  (identityOnlyArrayElementUse ||
                    identityOnlyArrayWriterArgumentUse) &&
                  !resolvedSource.dynamic
                ) {
                  recordIdentityPath(resolvedSource.root, resolvedSource.path, {
                    cellLike: isCellLikeExpression(usage) ||
                      !isPrimitiveLikeExpression(usage),
                  });
                } else if (wholeValueEscape) {
                  // Both: the plain read is what the value's capability and
                  // every consumer of `readPaths` see; the full-shape read is
                  // what keeps the value whole through shrinking.
                  trackReadRef(resolvedSource);
                  trackFullShapeReadRef(resolvedSource);
                } else {
                  trackReadRef(
                    resolvedSource,
                    identityOnlyArgumentUse
                      ? { identityOnly: true }
                      : undefined,
                  );
                }
              } else {
                trackReadRef(resolvedSource);
              }
            }
          }
        }
      }

      if (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        if (isTopmostMemberNode(node)) {
          const parent = node.parent;
          if (
            !(parent && ts.isCallExpression(parent) &&
              parent.expression === node) &&
            !isOptionalAliasInitializerMemberUsage(node) &&
            // A member-access argument (e.g. `state.auth`) whose callee parameter
            // type already supplied the capability is accounted for, same as a
            // destructured identifier; don't add a second read here.
            !signatureCapabilityArgumentUses.has(
              outermostTransparentWrapper(node),
            )
          ) {
            const ref = resolveSourceRef(node);
            if (ref) {
              trackReadRef(ref);
              // A member that leaves the analysis whole is read in full
              // wherever it lands, exactly as an identifier is; the identifier
              // handler above states the reason. A primitive has nothing
              // below it to keep whole.
              if (
                !ref.dynamic && !isPrimitiveLikeExpression(node) &&
                escapesWhole(node)
              ) {
                trackFullShapeReadRef(ref);
              }
              // If this resolution went through a .get() call, record the
              // alias name so the identifier handler can skip redundant
              // blanket reads.  Only suppress for actual .get() bases —
              // ordinary member reads (e.g. state.foo) must not be tagged.
              // Walk through intermediate member accesses to find the .get()
              // call (handles chains like notes.get().meta.length).
              let getBaseExpr: ts.Expression = node.expression;
              while (
                ts.isPropertyAccessExpression(getBaseExpr) ||
                ts.isElementAccessExpression(getBaseExpr)
              ) {
                getBaseExpr = getBaseExpr.expression;
              }
              if (
                ts.isCallExpression(getBaseExpr) &&
                resolvedGetCalls.has(getBaseExpr)
              ) {
                // Unwrap the .get() call to find the root identifier:
                // notes.get() → notes.get (PropertyAccess) → notes (Identifier)
                const calleeExpr = getBaseExpr.expression;
                let rootExpr: ts.Expression = ts.isPropertyAccessExpression(
                    calleeExpr,
                  )
                  ? calleeExpr.expression
                  : calleeExpr;
                while (ts.isPropertyAccessExpression(rootExpr)) {
                  rootExpr = rootExpr.expression;
                }
                if (ts.isIdentifier(rootExpr) && aliases.has(rootExpr.text)) {
                  aliasesWithSpecificPaths.add(rootExpr.text);
                }
              }
            }
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const localReceiverName =
          ts.isPropertyAccessExpression(node.expression) ||
            ts.isElementAccessExpression(node.expression)
            ? getIdentifierName(node.expression.expression)
            : undefined;
        const localMethodName = getCallMethodName(node.expression);
        if (
          localReceiverName &&
          localMethodName &&
          ARRAY_IDENTITY_WRITER_METHODS.has(localMethodName) &&
          node.arguments.length > 0
        ) {
          recordLocalArrayIdentityWrite(
            localReceiverName,
            localMethodName === "splice"
              ? node.arguments.slice(2)
              : node.arguments,
          );
        } else if (localReceiverName && localMethodName === "set") {
          recordLocalMapSet(localReceiverName, node.arguments[1]);
        }

        const identityEqualsCall = isKnownIdentityEqualsCall(node, checker);
        const identityArgumentCall = isKnownIdentityArgumentCall(node, checker);
        const capabilityHandledArgs = new Set<number>();
        const calleeSummary = resolveInterproceduralSummary(node);
        if (calleeSummary) {
          const count = Math.min(
            calleeSummary.params.length,
            node.arguments.length,
          );
          for (let index = 0; index < count; index++) {
            const paramSummary = calleeSummary.params[index];
            const argument = node.arguments[index];
            if (!paramSummary || !argument) continue;

            const source = resolveSourceRef(argument);
            if (!source) continue;
            capabilityHandledArgs.add(index);
            summaryHandledArgumentUses.add(argument);

            if (source.dynamic || paramSummary.wildcard) {
              markWildcard(source.root, source.path);
              continue;
            }
            if (paramSummary.hasUnverifiedCellUse) {
              markUnverifiedCellUse(source.root);
            }

            for (const readPath of paramSummary.readPaths) {
              trackRead(source.root, [...source.path, ...readPath]);
            }
            // What the callee let leave whole leaves the caller's value whole
            // too: its own members the caller never sees are read wherever
            // the callee sent them.
            for (const fullShapePath of paramSummary.fullShapePaths ?? []) {
              trackFullShapeRead(source.root, [
                ...source.path,
                ...fullShapePath,
              ]);
            }
            for (const writePath of paramSummary.writePaths) {
              trackWrite(source.root, [...source.path, ...writePath]);
            }
            for (const opaquePath of paramSummary.opaquePaths ?? []) {
              recordOpaquePath(source.root, [
                ...source.path,
                ...opaquePath,
              ]);
            }
            if (
              paramSummary.capability === "opaque" &&
              !paramSummary.passthrough &&
              paramSummary.readPaths.length === 0 &&
              paramSummary.writePaths.length === 0 &&
              (paramSummary.opaquePaths?.length ?? 0) === 0
            ) {
              markOpaqueUse(source.root, source.path);
            }

            for (const identityPath of paramSummary.identityPaths ?? []) {
              if (source.dynamic) {
                markWildcard(source.root, source.path);
              } else {
                const isComparablePath = (paramSummary.comparablePaths ?? [])
                  .some((path) =>
                    path.length === identityPath.length &&
                    path.every((segment, index) =>
                      segment === identityPath[index]
                    )
                  );
                const recordPath = isComparablePath
                  ? recordComparablePath
                  : recordIdentityPath;
                recordPath(
                  source.root,
                  [...source.path, ...identityPath],
                  {
                    cellLike: (paramSummary.identityCellPaths ?? []).some(
                      (path) =>
                        path.length === identityPath.length &&
                        path.every((segment, index) =>
                          segment === identityPath[index]
                        ),
                    ),
                  },
                );
              }
            }

            if (paramSummary.passthrough && source.path.length === 0) {
              if (paramSummary.identityOnly) {
                if (paramSummary.capability === "comparable") {
                  recordComparablePath(source.root, []);
                } else {
                  recordIdentityPath(source.root, []);
                }
              }
              markPassthrough(
                source.root,
                paramSummary.identityOnly ? { identityOnly: true } : undefined,
              );
            }
          }
        } else if (!identityArgumentCall) {
          for (const index of applySignatureCellCapabilities(node)) {
            capabilityHandledArgs.add(index);
          }
        }

        if (
          ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)
        ) {
          // The expression the method is called on, with an `assert` body's
          // operand recording read through. Recording the receiver of a method
          // call puts a call where the member access the author wrote used to
          // be, and both questions asked of it here — which source it was read
          // from, and whether it is cell-like — are about the value the
          // recording hands back rather than about the recording.
          const receiverExpression = unwrapAssertCapture(
            node.expression.expression,
          );
          const directReceiver = resolveSourceRef(receiverExpression);
          const receiver = directReceiver ??
            resolveConservativeCallReceiverRef(node);
          if (receiver) {
            const methodName = getCallMethodName(node.expression);
            const shouldTrackFullShape = !directReceiver &&
              (!methodName || !PRECISE_CHAIN_METHODS.has(methodName));
            if (!methodName) {
              // A dynamic method name (`cell[m]()`) on a cell-like receiver
              // is the open-world case par excellence: the method could be
              // any mutator, so write-exhaustiveness fails closed exactly
              // like the unknown-named fallback below.
              if (
                !checker ||
                isCellLikeExpression(receiverExpression)
              ) {
                markUnverifiedCellUse(receiver.root);
              }
              if (shouldTrackFullShape) {
                trackFullShapeReadRef(receiver);
              } else {
                trackReadRef(receiver);
              }
            } else if (methodName === "elementById") {
              // Addresses a separately derived entity; attribute the access
              // conservatively to the whole array root.
              markWildcard(receiver.root, receiver.path);
            } else if (methodName === "key") {
              const argPath = extractLiteralPathArguments(
                node.arguments,
                checker,
              );
              if (argPath.dynamic) {
                markWildcard(receiver.root, receiver.path);
              } else {
                const keyUsage = outermostTransparentWrapper(node);
                const keyUsageParent = keyUsage.parent;
                const isChainedIntoMemberAccess = !!(
                  keyUsageParent &&
                  (ts.isPropertyAccessExpression(keyUsageParent) ||
                    ts.isElementAccessExpression(keyUsageParent)) &&
                  keyUsageParent.expression === keyUsage
                );
                if (!isChainedIntoMemberAccess) {
                  trackReadRef({
                    root: receiver.root,
                    path: [...receiver.path, ...argPath.path],
                    dynamic: receiver.dynamic,
                  });
                }
              }
            } else if (identityEqualsCall) {
              markIdentityUseRef(receiver, node.expression.expression, {
                comparable: true,
              });
            } else if (WRITER_METHODS.has(methodName)) {
              trackWriteRef(receiver);
              recordMergeableNonAppendWrite(receiver);
              // set(value, onCommit?) / send(event, onCommit?): onCommit runs
              // after the commit settles, so the passed tx is no longer a
              // write channel — but the closure can still write via captured
              // cells, fresh transactions (cell.runtime.edit()), or external
              // I/O, and the contract forbidding that is advisory. That
              // residue is unboundable, so a second argument fails closed.
              if (
                (methodName === "set" || methodName === "send") &&
                node.arguments.length > 1
              ) {
                markUnverifiedCellUse(receiver.root);
              }
            } else if (ARRAY_IDENTITY_WRITER_METHODS.has(methodName)) {
              trackWriteRef(receiver);
              if (mergeablePushMisuseSink && !receiver.dynamic) {
                if (MERGEABLE_APPEND_METHODS.has(methodName)) {
                  mergeablePushSites.push({
                    root: receiver.root,
                    encodedPath: encodePath(receiver.path),
                    node,
                  });
                } else {
                  recordMergeableNonAppendWrite(receiver);
                }
              }
              let hasIdentityArgument = false;
              for (const argument of node.arguments) {
                const argumentRef = resolveSourceRef(argument);
                const rawArgument = unwrapExpression(argument);
                const rawAlias = ts.isIdentifier(rawArgument)
                  ? aliases.get(rawArgument.text)
                  : undefined;
                if (rawAlias?.arrayElement || argumentRef?.arrayElement) {
                  trackReadRef(materializeSourceRef(rawAlias ?? argumentRef!));
                }
                if (argumentRef && hasRecordedIdentityUseRef(argumentRef)) {
                  hasIdentityArgument = true;
                  markIdentityUseRef(argumentRef, argument);
                }
              }
              if (hasIdentityArgument) {
                markArrayItemIdentityUseRef(receiver);
              }
            } else if (READER_METHODS.has(methodName)) {
              // If the .get() result was already resolved with a more specific
              // path by the member-access handler (e.g. notes.get().length →
              // ["notes", "length"]), skip the blanket read. Optional chains
              // are the exception: their projected result path does not by
              // itself retain the receiver Cell in every synthesized closure
              // shape, so record the receiver read explicitly without
              // widening the root to wildcard.
              if (!resolvedGetCalls.has(node)) {
                trackFullShapeReadRef(receiver);
              }
              if (ts.isCallChain(node) || !resolvedGetCalls.has(node)) {
                trackReadRef(receiver);
                recordMergeableReadSite(receiver, node);
              }
            } else if (
              OPAQUE_DERIVATION_METHODS.has(methodName) &&
              (
                !checker ||
                isCellLikeExpression(receiverExpression)
              )
            ) {
              // These methods are available on opaque cells and return opaque
              // results. Dynamic receivers can hide which branch is used, so
              // they must disable shrinking for the root.
              if (receiver.dynamic) {
                markWildcard(receiver.root, receiver.path);
              } else if (receiver.path.length > 0) {
                recordOpaquePath(receiver.root, receiver.path);
              } else {
                markOpaqueUse(receiver.root, receiver.path);
              }
            } else {
              // Unknown method call over a tracked source reads at least the
              // receiver path. On a CELL-LIKE receiver the unknown method
              // could be a mutator this analysis does not recognize (the
              // writer sets are a closed list against an evolving Cell API),
              // so write-exhaustiveness is poisoned — fail closed. Value
              // receivers (e.g. array methods on a `.get()` snapshot) cannot
              // write through the cell and stay reads.
              if (
                !checker ||
                isCellLikeExpression(receiverExpression)
              ) {
                markUnverifiedCellUse(receiver.root);
              }
              if (shouldTrackFullShape) {
                trackFullShapeReadRef(receiver);
              } else if (directReceiver) {
                trackReadRef(receiver);
              }
            }
          }
        }

        // Passing a tracked root object into an opaque helper can conceal
        // indirect traversal/mutation; conservatively disable shrinking.
        if (!identityArgumentCall) {
          for (let index = 0; index < node.arguments.length; index++) {
            if (capabilityHandledArgs.has(index)) {
              continue;
            }
            const argument = node.arguments[index];
            if (!argument) continue;
            const unwrappedArgument = unwrapExpression(argument);
            if (!ts.isIdentifier(unwrappedArgument)) continue;
            const source = resolveSourceRef(unwrappedArgument);
            if (!source) continue;
            if (source.dynamic || source.path.length > 0) continue;
            markWildcard(source.root, source.path);
          }
        }
        if (identityArgumentCall) {
          for (const argument of node.arguments) {
            const source = resolveSourceRef(argument);
            if (source) {
              markIdentityUseRef(source, argument, {
                comparable: identityEqualsCall,
              });
            }
          }
        }

        // Full-shape operations.
        if (isWildcardTraversalCall(node, checker)) {
          const firstArg = node.arguments[0];
          if (firstArg) {
            markWildcardFromExpression(firstArg);
          }
        }

        visitInlineEagerCallbackArguments(node);
      }

      if (ts.isNewExpression(node)) {
        applySignatureCellCapabilities(node);
      }

      if (ts.isVariableDeclaration(node)) {
        clearScopedLocalCollectionBindingNames(node.name);
        const initRef = node.initializer && ts.isExpression(node.initializer)
          ? buildAliasBindingFromExpression(node.initializer)
          : undefined;
        if (ts.isIdentifier(node.name)) {
          if (
            node.initializer &&
            ts.isExpression(node.initializer) &&
            isOptionalAliasInitializerMemberUsage(node.initializer)
          ) {
            optionalPresenceAliases.add(node.name.text);
          } else {
            optionalPresenceAliases.delete(node.name.text);
          }
        }
        assignBindingAlias(node.name, initRef);
      }

      if (
        ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
      ) {
        if (
          node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken
        ) {
          markFromExpression(node.operand, trackWrite);
          markFromExpression(node.operand, trackRead);
        }
      }

      if (ts.isSpreadElement(node)) {
        const spreadExpr = node.expression;
        if (spreadExpr) {
          const ref = resolveSourceRef(spreadExpr);
          if (ref) {
            trackReadRef(ref);
            const identityArrayLocal = getIdentityArrayLocalNameForElementUsage(
              node,
            );
            if (
              identityArrayLocal && identityArrayLocals.has(identityArrayLocal)
            ) {
              markArrayItemIdentityUseRef(ref);
            }
          } else {
            markWildcardFromExpression(spreadExpr);
          }
        }
      }

      if (ts.isSpreadAssignment(node)) {
        const spreadExpr = node.expression;
        if (spreadExpr) {
          markWildcardFromExpression(spreadExpr);
        }
      }

      if (ts.isForInStatement(node)) {
        markWildcardFromExpression(node.expression);
        ts.forEachChild(node, visit);
        return;
      }

      if (ts.isForOfStatement(node)) {
        const iterableExpression = unwrapExpression(node.expression);
        const iterableBinding = resolveArrayElementBinding(node.expression);
        const iterableRef =
          iterableBinding && isSourceRefBinding(iterableBinding)
            ? iterableBinding
            : undefined;
        if (iterableRef) {
          if (iterableRef.dynamic) {
            markWildcard(iterableRef.root);
          } else if (iterableRef.path.length === 0) {
            markPassthrough(iterableRef.root);
          } else {
            trackReadRef(iterableRef);
            recordMergeableReadSite(iterableRef, node.expression);
          }
          if (ts.isCallExpression(iterableExpression)) {
            visit(node.expression);
          }
        } else {
          visit(node.expression);
        }

        const savedAliases = new Map(aliases);
        const savedAliasShapes = new Map(aliasShapes);
        const savedOptionalPresenceAliases = new Set(optionalPresenceAliases);
        const savedSpecificPaths = new Set(aliasesWithSpecificPaths);
        const savedLocalArrayElementBindings = new Map(
          localArrayElementBindings,
        );
        const savedLocalMapValueBindings = new Map(localMapValueBindings);
        const scopedLocalCollectionNames = new Set<string>();
        scopedLocalCollectionNamesStack.push(scopedLocalCollectionNames);
        try {
          if (iterableBinding) {
            if (ts.isVariableDeclarationList(node.initializer)) {
              for (const declaration of node.initializer.declarations) {
                clearScopedLocalCollectionBindingNames(declaration.name);
                assignBindingAlias(declaration.name, iterableBinding);
              }
            } else if (ts.isExpression(node.initializer)) {
              assignExpressionPatternAlias(node.initializer, iterableBinding);
            }
          } else {
            visit(node.initializer);
          }
          visit(node.statement);
        } finally {
          scopedLocalCollectionNamesStack.pop();
          aliases.clear();
          for (const [name, source] of savedAliases) {
            aliases.set(name, source);
          }
          aliasShapes.clear();
          for (const [name, shape] of savedAliasShapes) {
            aliasShapes.set(name, shape);
          }
          optionalPresenceAliases.clear();
          for (const name of savedOptionalPresenceAliases) {
            optionalPresenceAliases.add(name);
          }
          aliasesWithSpecificPaths.clear();
          for (const name of savedSpecificPaths) {
            aliasesWithSpecificPaths.add(name);
          }
          restoreScopedLocalCollectionBindings(
            scopedLocalCollectionNames,
            savedLocalArrayElementBindings,
            savedLocalMapValueBindings,
          );
        }
        return;
      }

      if (ts.isBlock(node)) {
        visitScopedLocalCollectionBindings(() => {
          for (const statement of node.statements) {
            visit(statement);
          }
        });
        return;
      }

      ts.forEachChild(node, visit);
    };

    if (ts.isBlock(fn.body)) {
      for (const statement of fn.body.statements) {
        visit(statement);
      }
    } else {
      visit(fn.body);
    }

    if (mergeablePushMisuseSink && mergeablePushSites.length > 0) {
      // A push whose collection the function also reads explicitly is
      // classified by how the read relates to the push: a push that depends on
      // the read (guard or value) is the dedup-then-push shape; a read that
      // instead feeds another write to the same collection is an independent
      // read-modify-write sharing the handler; a read related to neither is
      // not reported. Influence tracking is name-based and conservative in the
      // noisy direction — ambiguity promotes to the dependent-push finding.
      const classifier = createMergeablePushClassifier({
        fn,
        readSites: mergeableReadSites,
        resolveAliasTarget: (name) => {
          const binding = aliases.get(name);
          if (!binding || binding.dynamic || binding.arrayElement) {
            return undefined;
          }
          return { root: binding.root, encodedPath: encodePath(binding.path) };
        },
      });
      for (const site of mergeablePushSites) {
        if (!states.get(site.root)?.reads.has(site.encodedPath)) continue;
        const kind = classifier.classify(
          site,
          mergeableNonAppendWriteKeys.has(
            mergeableWriteKey(site.root, site.encodedPath),
          ),
        );
        if (kind) {
          mergeablePushMisuseSink({
            node: site.node,
            path: decodePath(site.encodedPath),
            rootName: site.root,
            kind,
          });
        }
      }
    }

    const params: CapabilityParamSummary[] = [];
    for (let index = 0; index < fn.parameters.length; index++) {
      const parameter = fn.parameters[index];
      if (!parameter) continue;
      const summaryName = ts.isIdentifier(parameter.name)
        ? parameter.name.text
        : `${PARAMETER_SUMMARY_PREFIX}${index}`;
      const state = states.get(summaryName);
      if (!state) continue;
      params.push(buildCapabilityParamSummary(summaryName, state));
    }

    const result: FunctionCapabilitySummary = unreadableCellArguments.length
      ? { params, unreadableCellArguments }
      : { params };
    summaryCache.set(fn, result);
    return result;
  } finally {
    inProgress.delete(fn);
  }
}
