/**
 * Reads a generic declaration's type nodes for one of its instantiations.
 *
 * A property of `Input<number>` is declared inside `interface Input<T>`, and
 * the type node its declaration carries is written in terms of `T`. The checker
 * resolves a reference to `T` in that node to the declaration's own type
 * parameter, never to `number`, and its public interface instantiates nothing.
 * So a node read for an instantiation is read together with the argument the
 * instantiation gives each type parameter, which a generation context carries
 * as `.typeArguments`.
 *
 * The bindings resolve a type parameter wherever it is formatted, and a node
 * that is itself a reference to one. They do not instantiate a type that only
 * mentions one, such as the `Box<T>` a reference node written `Box<T>` denotes:
 * that stays `Box<T>` to the checker. `findInstantiation()` recovers one of
 * those where the instantiated type it stands for is on hand.
 */

import ts from "typescript";
import type { GenerationContext } from "../interface.ts";

/**
 * Returns `context` with the arguments `type` gives the type parameters of its
 * generic declaration added to `.typeArguments`: those of a type alias it
 * instantiates, those of an interface or class it instantiates, and those of
 * each interface or class that declaration inherits from. Returns `context`
 * itself when `type` binds nothing.
 */
export function withTypeArgumentsOf(
  type: ts.Type,
  context: GenerationContext,
): GenerationContext {
  const checker = context.typeChecker;
  let bindings: Map<ts.Type, ts.Type> | undefined;
  const bind = (parameter: ts.Type, argument: ts.Type | undefined) => {
    if (!argument || argument === parameter) return;
    bindings ??= new Map(context.typeArguments);
    bindings.set(parameter, argument);
  };

  const alias = type.aliasSymbol?.declarations?.find(ts.isTypeAliasDeclaration);
  alias?.typeParameters?.forEach((parameter, index) => {
    bind(
      checker.getTypeAtLocation(parameter),
      type.aliasTypeArguments?.[index],
    );
  });

  const visited = new Set<ts.Type>();
  const bindReference = (current: ts.Type) => {
    if (visited.has(current) || !isTypeReference(current)) return;
    visited.add(current);
    const target = current.target;
    const typeArguments = checker.getTypeArguments(current);
    target.typeParameters?.forEach((parameter, index) => {
      bind(parameter, typeArguments[index]);
    });
    // A base is written in terms of the declaration's own type parameters, as
    // `Base<T>` is in `interface Input<T> extends Base<T>`, and the bindings
    // above carry those on to the instantiation's arguments.
    if (target.objectFlags & ts.ObjectFlags.ClassOrInterface) {
      checker.getBaseTypes(target as ts.InterfaceType).forEach(bindReference);
    }
  };
  bindReference(type);

  return bindings ? { ...context, typeArguments: bindings } : context;
}

/**
 * Returns the argument `type` is bound to in `context`, when `type` is a type
 * parameter the context binds, following a parameter bound to another bound
 * parameter to the end. Returns `type` itself otherwise.
 */
export function resolveTypeArgument(
  type: ts.Type,
  context: GenerationContext,
): ts.Type {
  const bindings = context.typeArguments;
  if (!bindings) return type;
  let current = type;
  const visited = new Set<ts.Type>();
  while (
    current.flags & ts.TypeFlags.TypeParameter && !visited.has(current)
  ) {
    visited.add(current);
    const argument = bindings.get(current);
    if (!argument) break;
    current = argument;
  }
  return current;
}

/**
 * Returns the checker's type for `node`, with a reference to a type parameter
 * `context` binds resolved by `resolveTypeArgument()`.
 */
export function getTypeFromTypeNodeInContext(
  node: ts.TypeNode,
  context: GenerationContext,
): ts.Type {
  return resolveTypeArgument(
    context.typeChecker.getTypeFromTypeNode(node),
    context,
  );
}

/**
 * Returns the member of `candidates` that `declared` is an instantiation of
 * under `context`'s bindings, or `declared` itself when it mentions no bound
 * type parameter or no candidate matches. A candidate matches when it is the
 * bound argument of a type parameter, or instantiates the same generic
 * declaration with arguments that match in turn, as `Box<number>` does for
 * `Box<T>` with `T` bound to `number`.
 */
export function findInstantiation(
  declared: ts.Type,
  candidates: readonly ts.Type[],
  context: GenerationContext,
): ts.Type {
  const resolved = resolveTypeArgument(declared, context);
  if (resolved !== declared || !context.typeArguments?.size) return resolved;
  return candidates.find((candidate) =>
    instantiates(declared, candidate, context)
  ) ?? declared;
}

/**
 * Helper for `findInstantiation()`, which returns `true` when `candidate` is
 * `declared` with every bound type parameter it mentions replaced by its
 * argument.
 */
function instantiates(
  declared: ts.Type,
  candidate: ts.Type,
  context: GenerationContext,
): boolean {
  if (resolveTypeArgument(declared, context) === candidate) return true;

  const checker = context.typeChecker;
  const argumentsMatch = (
    declaredArguments: readonly ts.Type[],
    candidateArguments: readonly ts.Type[],
  ) =>
    declaredArguments.length === candidateArguments.length &&
    declaredArguments.every((argument, index) =>
      instantiates(argument, candidateArguments[index]!, context)
    );

  if (declared.aliasSymbol) {
    return declared.aliasSymbol === candidate.aliasSymbol &&
      argumentsMatch(
        declared.aliasTypeArguments ?? [],
        candidate.aliasTypeArguments ?? [],
      );
  }
  return isTypeReference(declared) && isTypeReference(candidate) &&
    declared.target === candidate.target &&
    argumentsMatch(
      checker.getTypeArguments(declared),
      checker.getTypeArguments(candidate),
    );
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;
}
