/**
 * Mergeable-push misuse classification
 *
 * The capability analysis reports a `Cell.push` or `Cell.pushAll` whose
 * receiver collection the same function also reads explicitly. This module
 * classifies the relationship between that read and the push, so the
 * diagnostic can say the right thing — or nothing:
 *
 * - `read-dependent-push`: the push depends on the read, either through a
 *   guard (the dedup-then-push shape: an enclosing condition or an earlier
 *   early-return derives from the read) or through its value (the pushed
 *   content derives from the read). The intent is better expressed as an
 *   identity-addressed `addUnique` or a read-modify-write `set`.
 * - `independent-read-modify-write`: the read does not feed the push, but the
 *   function also performs another write to the same collection (the
 *   append-then-trim shape). The read still keeps the append in the conflict
 *   set; the remedy is to move the independent read-modify-write into its own
 *   handler.
 * - `undefined` (no finding): the read neither feeds the push nor a sibling
 *   write to the collection. The append does forfeit merging, but there is
 *   usually no better expression, so the check stays silent.
 *
 * The classification is deliberately conservative in the noisy direction:
 * read influence is tracked through variable initializers, assignments, and
 * loop bindings by name, without scope analysis, so over-approximation can
 * only promote a finding to `read-dependent-push` — the diagnosis the
 * unstratified check gave every site. Under-approximation demotes to the
 * independent-write message or to silence, never to a wrong recommendation.
 */

import ts from "typescript";

export type MergeablePushMisuseKind =
  | "read-dependent-push"
  | "independent-read-modify-write";

/**
 * A `Cell.push(...)` or `Cell.pushAll(...)` whose receiver collection is also
 * read explicitly within the same analyzed function. Reported through
 * `CapabilityAnalysisOptions.mergeablePushMisuseSink`.
 */
export interface MergeablePushMisuse {
  /** The `push(...)` or `pushAll(...)` call to point the diagnostic at. */
  readonly node: ts.Node;

  /** The collection path that is both read and pushed, relative to its root. */
  readonly path: readonly string[];

  /** The analyzed parameter/root the collection belongs to. */
  readonly rootName: string;

  /** How the explicit read relates to the push. */
  readonly kind: MergeablePushMisuseKind;
}

/** A push or explicit-read call site collected during the capability walk. */
export interface MergeableCollectionSite {
  readonly root: string;
  readonly encodedPath: string;
  readonly node: ts.Node;
}

export interface MergeablePushClassifierInput {
  /** The analyzed function; the ancestor climb and taint pass stop here. */
  readonly fn: ts.Node;

  /** Explicit read sites (`.get()` calls and `for..of` iterables). */
  readonly readSites: readonly MergeableCollectionSite[];

  /**
   * Resolves a local identifier to the collection it aliases (from the
   * capability walk's alias bindings), if any.
   */
  readonly resolveAliasTarget: (
    name: string,
  ) => { readonly root: string; readonly encodedPath: string } | undefined;
}

export interface MergeablePushClassifier {
  /**
   * Classifies one push site that the capability analysis already gated on
   * "the function reads the same collection path". Returns `undefined` when
   * the read is unrelated to both the push and any sibling write.
   */
  readonly classify: (
    site: MergeableCollectionSite,
    hasIndependentSameCollectionWrite: boolean,
  ) => MergeablePushMisuseKind | undefined;
}

function isFunctionBoundary(node: ts.Node): boolean {
  return ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node);
}

/**
 * Whether the statement can exit the enclosing function before the statements
 * after it run. Returns inside nested callbacks don't count: they exit the
 * callback, not this function.
 */
function containsEarlyExit(statement: ts.Node): boolean {
  let found = false;
  const scan = (node: ts.Node): void => {
    if (found) return;
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      found = true;
      return;
    }
    if (isFunctionBoundary(node)) return;
    ts.forEachChild(node, scan);
  };
  scan(statement);
  return found;
}

/**
 * Identifier occurrences that name a member or binding rather than reference
 * a value; these never carry read influence.
 */
function isNamePosition(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === identifier;
  if (ts.isPropertyAssignment(parent)) return parent.name === identifier;
  if (ts.isVariableDeclaration(parent)) return parent.name === identifier;
  if (ts.isBindingElement(parent)) return true;
  if (ts.isParameter(parent)) return parent.name === identifier;
  if (ts.isFunctionDeclaration(parent)) return parent.name === identifier;
  if (ts.isMethodDeclaration(parent)) return parent.name === identifier;
  return false;
}

function collectBoundNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBoundNames(element.name, out);
  }
}

function isLogicalOrCoalescingOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment;
}

function getStatementList(
  node: ts.Node,
): readonly ts.Statement[] | undefined {
  if (ts.isBlock(node)) return node.statements;
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    return node.statements;
  }
  return undefined;
}

export function createMergeablePushClassifier(
  input: MergeablePushClassifierInput,
): MergeablePushClassifier {
  const { fn, readSites, resolveAliasTarget } = input;

  interface TargetContext {
    readonly siteNodes: ReadonlySet<ts.Node>;
    readonly taintedNames: ReadonlySet<string>;
  }
  const contexts = new Map<string, TargetContext>();

  const targetKey = (root: string, encodedPath: string): string =>
    JSON.stringify([root, encodedPath]);

  /**
   * Whether the expression's value can derive from an explicit read of the
   * target collection: it contains a read site, an identifier tainted by one,
   * or an identifier aliasing the collection itself.
   */
  const touches = (
    node: ts.Node,
    root: string,
    encodedPath: string,
    siteNodes: ReadonlySet<ts.Node>,
    taintedNames: ReadonlySet<string>,
  ): boolean => {
    let found = false;
    const scan = (current: ts.Node): void => {
      if (found) return;
      if (siteNodes.has(current)) {
        found = true;
        return;
      }
      if (ts.isIdentifier(current) && !isNamePosition(current)) {
        if (taintedNames.has(current.text)) {
          found = true;
          return;
        }
        const alias = resolveAliasTarget(current.text);
        if (alias && alias.root === root && alias.encodedPath === encodedPath) {
          found = true;
          return;
        }
      }
      ts.forEachChild(current, scan);
    };
    scan(node);
    return found;
  };

  /**
   * Names whose value derives from an explicit read of the target: variable
   * initializers, assignments, and `for..of`/`for..in` bindings over touched
   * expressions, iterated to a fixpoint. Names are matched without scope
   * analysis; collisions over-approximate, which only promotes the finding.
   */
  const computeTaintedNames = (
    root: string,
    encodedPath: string,
    siteNodes: ReadonlySet<ts.Node>,
  ): Set<string> => {
    const tainted = new Set<string>();
    const touchesTarget = (node: ts.Node): boolean =>
      touches(node, root, encodedPath, siteNodes, tainted);
    let changed = true;
    while (changed) {
      changed = false;
      const taintBinding = (name: ts.BindingName): void => {
        const before = tainted.size;
        collectBoundNames(name, tainted);
        if (tainted.size > before) changed = true;
      };
      const scan = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) && node.initializer &&
          touchesTarget(node.initializer)
        ) {
          taintBinding(node.name);
        } else if (
          ts.isBinaryExpression(node) &&
          isAssignmentOperator(node.operatorToken.kind) &&
          ts.isIdentifier(node.left) &&
          !tainted.has(node.left.text) &&
          touchesTarget(node.right)
        ) {
          tainted.add(node.left.text);
          changed = true;
        } else if (
          (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
          ts.isVariableDeclarationList(node.initializer) &&
          touchesTarget(node.expression)
        ) {
          for (const declaration of node.initializer.declarations) {
            taintBinding(declaration.name);
          }
        }
        ts.forEachChild(node, scan);
      };
      scan(fn);
    }
    return tainted;
  };

  const contextFor = (root: string, encodedPath: string): TargetContext => {
    const key = targetKey(root, encodedPath);
    let context = contexts.get(key);
    if (!context) {
      const siteNodes = new Set<ts.Node>();
      for (const site of readSites) {
        if (site.root === root && site.encodedPath === encodedPath) {
          siteNodes.add(site.node);
        }
      }
      context = {
        siteNodes,
        taintedNames: computeTaintedNames(root, encodedPath, siteNodes),
      };
      contexts.set(key, context);
    }
    return context;
  };

  /**
   * Everything the push is control-dependent on, walking up to the analyzed
   * function: enclosing condition expressions, receivers of enclosing
   * callback-taking calls, and — the canonical dedup shape — earlier sibling
   * statements that can exit the function before the push runs.
   */
  const collectGuardContainers = (pushNode: ts.Node): ts.Node[] => {
    const containers: ts.Node[] = [];
    let child: ts.Node = pushNode;
    let parent: ts.Node | undefined = child.parent;
    while (parent && child !== fn) {
      if (
        ts.isIfStatement(parent) &&
        (parent.thenStatement === child || parent.elseStatement === child)
      ) {
        containers.push(parent.expression);
      } else if (
        ts.isConditionalExpression(parent) &&
        (parent.whenTrue === child || parent.whenFalse === child)
      ) {
        containers.push(parent.condition);
      } else if (
        ts.isBinaryExpression(parent) && parent.right === child &&
        isLogicalOrCoalescingOperator(parent.operatorToken.kind)
      ) {
        containers.push(parent.left);
      } else if (
        (ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
        parent.statement === child
      ) {
        containers.push(parent.expression);
      } else if (
        ts.isForStatement(parent) && parent.statement === child &&
        parent.condition
      ) {
        containers.push(parent.condition);
      } else if (
        (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
        parent.statement === child
      ) {
        containers.push(parent.expression);
      } else if (isFunctionBoundary(parent) && parent !== fn) {
        const call = parent.parent;
        if (
          call && ts.isCallExpression(call) &&
          call.arguments.some((argument) => argument === parent)
        ) {
          containers.push(call.expression);
        }
      } else {
        const statements = getStatementList(parent);
        if (statements) {
          for (const statement of statements) {
            if (statement === child) break;
            if (containsEarlyExit(statement)) containers.push(statement);
          }
        }
      }
      child = parent;
      parent = parent.parent;
    }
    return containers;
  };

  const classify = (
    site: MergeableCollectionSite,
    hasIndependentSameCollectionWrite: boolean,
  ): MergeablePushMisuseKind | undefined => {
    const { siteNodes, taintedNames } = contextFor(site.root, site.encodedPath);
    const touchesTarget = (node: ts.Node): boolean =>
      touches(node, site.root, site.encodedPath, siteNodes, taintedNames);

    // Data dependence: the pushed value derives from the read.
    if (
      ts.isCallExpression(site.node) &&
      site.node.arguments.some(touchesTarget)
    ) {
      return "read-dependent-push";
    }
    // Control dependence: a guard governing the push derives from the read.
    if (collectGuardContainers(site.node).some(touchesTarget)) {
      return "read-dependent-push";
    }
    if (hasIndependentSameCollectionWrite) {
      return "independent-read-modify-write";
    }
    return undefined;
  };

  return { classify };
}
