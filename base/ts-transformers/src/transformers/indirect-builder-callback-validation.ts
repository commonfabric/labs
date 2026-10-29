/**
 * Indirect Builder Callback Validation Transformer
 *
 * Reports a compile-time error when a trusted builder receives its callback
 * through a reference the module verifier cannot follow: a property access
 * (`handler(schema, state, callbacks.save)`) or a binding imported from
 * another module.
 *
 * The rule is not this stage's to choose. `verifyTrustedBuilderCall`
 * (`runner/src/sandbox/compiled-bundle-verifier.ts`, normative per §17.6)
 * admits a trusted builder's callback in exactly two spellings — a function
 * written at the call, or a plain identifier bound to a function in the same
 * module — and refuses to load a module that uses any other. Without this
 * stage the author learns that at load, from a verifier message phrased in
 * terms the pattern source never mentions. The check exists to move that
 * refusal to the compile that produced the module, where the offending
 * argument can be pointed at.
 *
 * Only the argument the verifier treats as the callback is judged, mirroring
 * its per-builder positions, so a trusted-builder result passed in a data
 * position is never mistaken for a miswritten callback. Within that argument
 * the resolution mirrors the verifier's too: it follows a name through the
 * declarations this module makes, so an alias of a local function
 * (`const alias = bump`) is accepted exactly as the verifier accepts it.
 *
 * An argument is judged only once it is function-bearing by the checker's
 * call signatures. That is what keeps a call that passes something else
 * entirely to its own diagnostic, and it is also what separates a builder
 * DEFINITION from an application of one — `updateData(state)` classifies as a
 * builder call as well, and the argument it carries is state.
 */

import ts from "typescript";
import { isTrustedBuilder } from "@commonfabric/utils/sandbox-contract";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { detectCallKind, isCallbackReference } from "../ast/call-kind.ts";
import { visitEachChildWithJsx } from "../ast/utils.ts";
import { unwrapExpression } from "../utils/expression.ts";

export class IndirectBuilderCallbackValidationTransformer
  extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const checker = context.checker;

    const visit = (node: ts.Node): ts.Node => {
      if (ts.isCallExpression(node)) {
        const callKind = detectCallKind(node, checker);
        if (callKind?.kind === "builder") {
          validateCallbackArgument(node, callKind.builderName, context);
        }
      }
      // JSX-aware: the stock visitor skips `JsxExpression.expression`, which
      // would exempt a builder authored inline in a JSX attribute.
      return visitEachChildWithJsx(node, visit, context.tsContext);
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }
}

function validateCallbackArgument(
  call: ts.CallExpression,
  builderName: string,
  context: TransformationContext,
): void {
  if (!isTrustedBuilder(builderName)) return;
  const checker = context.checker;
  const sourceFile = call.getSourceFile();
  const candidates = callbackCandidates(call.arguments, builderName);
  // The verifier takes the first candidate that resolves, so one that does
  // means the module loads whatever the others are.
  if (
    candidates.some((candidate) =>
      resolvesToSameModuleFunction(candidate, sourceFile, checker)
    )
  ) {
    return;
  }
  // Function-bearing is also what separates a builder DEFINITION from an
  // application of one: `updateData(state)` classifies as a builder call too,
  // and the argument it carries is state.
  const callback = candidates.find((candidate) =>
    isCallbackReference(candidate, checker)
  );
  if (callback === undefined) return;
  context.reportDiagnostic({
    severity: "error",
    type: "builder-callback:indirect-reference",
    message:
      `This ${builderName} reaches its callback ${
        reachDescription(callback)
      }, ` +
      `which the module verifier cannot follow — the module would be refused ` +
      `at load. Give the function a name in this module and pass that name ` +
      `(\`const onSave = (…) => {…}\` … \`${builderName}(…, onSave)\`), or ` +
      `write the function at the call.`,
    node: callback,
  });
}

/**
 * The arguments the verifier considers for the callback, in the order it
 * considers them, mirroring `callbackIndexesForBuilder`. `multiUserTest` is
 * absent there — its arguments are builder results — so it is absent here.
 */
function callbackCandidates(
  args: ts.NodeArray<ts.Expression>,
  builderName: string,
): readonly ts.Expression[] {
  const at = (index: number) => args.length > index ? [args[index]!] : [];
  switch (builderName) {
    case "pattern":
    case "action":
    case "computed":
      return at(0);
    case "lift":
      // The callback belongs at position 0, but the verifier scans the
      // leading positions defensively and takes the first that resolves.
      // Judging the same window keeps a misplaced callback from passing here
      // and then being refused at load.
      return args.slice(0, 3);
    case "handler":
      // Function-first when the leading argument carries the callback,
      // schema-first otherwise.
      return [...at(0), ...at(2)];
    case "derive":
      return args.length >= 4 ? at(3) : at(1);
    default:
      return [];
  }
}

/**
 * Whether the callback resolves to a function this module declares AND emits.
 *
 * Follows a name through this module's own declarations the way the verifier
 * follows it through the compiled module's bindings: an implementation-bearing
 * function declaration ends the walk, and a variable initializer continues it,
 * so a chain of aliases ending at a local function resolves.
 *
 * Two shapes look like functions here and are not ones the verifier admits. A
 * generator is not direct-callback syntax to it (`tryParseDirectFunction`
 * accepts `async`, never `function*`). And a declaration with no body —
 * ambient, or an overload signature — is erased before emit, leaving the
 * compiled module with a name bound to nothing.
 */
function resolvesToSameModuleFunction(
  argument: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const target = unwrapExpression(argument);
  if (seen.has(target)) return false;
  seen.add(target);

  if (ts.isArrowFunction(target)) {
    return target.getSourceFile().fileName === sourceFile.fileName;
  }
  if (ts.isFunctionExpression(target)) {
    return target.asteriskToken === undefined &&
      target.getSourceFile().fileName === sourceFile.fileName;
  }
  if (!ts.isIdentifier(target)) return false;

  const declarations = (checker.getSymbolAtLocation(target)?.declarations ?? [])
    .filter((declaration) =>
      declaration.getSourceFile().fileName === sourceFile.fileName
    );
  if (declarations.some(isEmittedFunctionDeclaration)) return true;
  // A name whose only function declarations are erased at emit resolves to
  // nothing, so it must not fall through to the initializer walk below.
  if (declarations.some(ts.isFunctionDeclaration)) return false;

  const variable = declarations.find(ts.isVariableDeclaration);
  // Only an exported VARIABLE declaration has its references rewritten to
  // `exports.<name>`, which the verifier's grammar does not admit as a
  // callback target. A function declaration keeps its local binding even when
  // exported, and a trailing `export { … }` clause rewrites nothing.
  if (variable !== undefined && isExportModified(variable)) return false;
  return variable?.initializer !== undefined &&
    resolvesToSameModuleFunction(
      variable.initializer,
      sourceFile,
      checker,
      seen,
    );
}

/** Whether the declaration's own statement carries an `export` modifier. */
function isExportModified(declaration: ts.VariableDeclaration): boolean {
  const statement = declaration.parent?.parent;
  return statement !== undefined && ts.isVariableStatement(statement) &&
    (statement.modifiers ?? []).some((modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword
    );
}

/** A function declaration that survives to emit as a direct callback. */
function isEmittedFunctionDeclaration(
  declaration: ts.Declaration,
): declaration is ts.FunctionDeclaration {
  return ts.isFunctionDeclaration(declaration) &&
    declaration.body !== undefined &&
    declaration.asteriskToken === undefined;
}

/** How the callback is reached, for the diagnostic's first clause. */
function reachDescription(argument: ts.Expression): string {
  const target = unwrapExpression(argument);
  if (
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target)
  ) {
    return "through a property access";
  }
  return "through a binding this module does not declare";
}
