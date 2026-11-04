import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import {
  declaredVerbResultTypeNode,
  detectCallKind,
  registerSyntheticCallType,
} from "../../ast/mod.ts";
import { CaptureCollector } from "../capture-collector.ts";
import {
  createActionEventSchema,
  createHandlerEventSchema,
  createHandlerStateSchema,
} from "../utils/schema-factory.ts";
import { unwrapArrowFunction } from "../utils/ast-helpers.ts";
import { buildCapturedHandlerClosureCall } from "../utils/capture-scaffold.ts";

/**
 * Check if a call expression is an action() call from commonfabric
 */
function isActionCall(
  node: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const callKind = detectCallKind(node, context.checker);
  return callKind?.kind === "builder" && callKind.builderName === "action";
}

/**
 * Extract the callback function from an action call.
 * Action has one signature: action(callback)
 *
 * Note: Only arrow functions are supported (see the transform's doc comment
 * for limitation details).
 */
function extractActionCallback(
  actionCall: ts.CallExpression,
): ts.ArrowFunction | undefined {
  const args = actionCall.arguments;

  if (args.length === 1) {
    const callback = args[0];
    if (callback) {
      return unwrapArrowFunction(callback);
    }
  }

  return undefined;
}

/**
 * Transform an action() call to a handler() call with explicit closures.
 * Returns undefined for any other node.
 *
 * This is to handler as computed is to lift:
 * - Input: action(() => count.set(count.get() + 1))
 * - Output: handler((_, { count }) => count.set(count.get() + 1))({ count })
 *
 * The action callback takes zero or one parameters (optional event) and closes
 * over scope variables. The transformer extracts these closures and makes them
 * explicit as handler params.
 *
 * Examples:
 * - action(() => doSomething())           → no event, schema is false
 * - action((e) => doSomething(e.target))  → has event, schema is inferred
 *
 * ## Limitation: Arrow Functions Only
 *
 * Currently only arrow functions are supported, not function expressions.
 * This matches the behavior of the JSX event handler transform.
 *
 * Supported:     action(() => count.set(count.get() + 1))
 * NOT supported: action(function() { count.set(count.get() + 1) })
 *
 * To support function expressions in the future:
 * 1. Update PatternBuilder.buildHandlerCallback to accept FunctionExpression
 *    (currently typed as ArrowFunction only)
 * 2. Update this transform to use isFunctionLikeExpression instead of
 *    unwrapArrowFunction
 * 3. Potentially update the JSX event handler transform for consistency
 * 4. Add test cases for function expression callbacks
 */
export function transformActionCall(
  node: ts.Node,
  context: TransformationContext,
  visitor: ts.Visitor,
): ts.CallExpression | undefined {
  if (!ts.isCallExpression(node) || !isActionCall(node, context)) {
    return undefined;
  }
  const actionCall = node;
  const { checker } = context;

  // Extract callback
  const callback = extractActionCallback(actionCall);
  if (!callback) {
    return undefined;
  }

  // Recursively transform the callback body first
  const transformedBody = ts.visitNode(
    callback.body,
    visitor,
  ) as ts.ConciseBody;

  // Collect captures
  const collector = new CaptureCollector(checker);
  const { captureTree } = collector.analyze(callback);

  // Determine event parameter name:
  // - If callback has an event param, preserve its name
  // - Otherwise use "_" to indicate unused
  const eventParam = callback.parameters[0];
  const eventParamName = eventParam && ts.isIdentifier(eventParam.name)
    ? eventParam.name.text
    : "_";

  // For action, event parameter is optional:
  // - action(() => ...) → event schema is `false` (never type)
  // - action((e) => ...) → event schema is inferred from the parameter
  // `action<Event, Result>`'s first type argument is the authored event —
  // the contract the served schema must carry (docs/history/plans/verb-input-contract.md)
  // — so it is preferred over inference from the parameter, which loses the
  // authored node for annotation-free callbacks. The node is registered with
  // its resolved type: it travels into a synthesized handler call, and an
  // unregistered node degrades schema generation to nothing at all.
  const authoredEventTypeNode = actionCall.typeArguments?.[0];
  if (authoredEventTypeNode) {
    const authoredEventType = checker.getTypeFromTypeNode(
      authoredEventTypeNode,
    );
    if ((authoredEventType.flags & ts.TypeFlags.Any) === 0) {
      context.state.typeRegistry.set(authoredEventTypeNode, authoredEventType);
    }
  }
  const eventTypeNode = callback.parameters.length > 0
    ? authoredEventTypeNode ?? createHandlerEventSchema(callback, context)
    : createActionEventSchema(context);

  // State schema is based on captures
  const stateTypeNode = createHandlerStateSchema(
    captureTree,
    undefined, // no explicit state parameter in action
    context,
  );

  // `action<Event, Result>`'s second type argument is the verb's declared
  // result. Lowering to `handler` is where it would otherwise be lost — the
  // rewritten call carries schemas, not the authored type arguments — so it
  // rides into `handler`'s third type-argument slot, which SchemaInjection
  // lowers to the module's result schema.
  const resultTypeNode = declaredVerbResultTypeNode(actionCall, "action");

  const finalCall = buildCapturedHandlerClosureCall(
    actionCall,
    callback,
    transformedBody,
    captureTree,
    eventTypeNode,
    stateTypeNode,
    context,
    {
      eventParamName,
      paramsParamName: "__cf_action_params",
      ...(resultTypeNode ? { resultTypeNode } : {}),
    },
  );

  // Register the return type in the TypeRegistry for schema inference.
  // This enables SchemaInjectionTransformer to correctly infer the pattern's result type
  // when an action is returned as a property (e.g., return { inc: action(...) }).
  // Without this registration, the synthetic handler call has no type information,
  // resulting in an empty result schema for the pattern.
  //
  // Note: The action call has type `ModuleFactory<T, Stream<void>>`, but the finalCall
  // is `handler(...)({...})` which CALLS the factory. We need the return type of that call,
  // which is `Reactive<Stream<void>>`.
  const typeRegistry = context.state.typeRegistry;
  // Get the type of the original action call (ModuleFactory<T, Stream<void>>)
  const actionType = checker.getTypeAtLocation(actionCall);
  // Get the call signature to find what type is returned when calling the factory
  const callSignatures = actionType.getCallSignatures();
  if (callSignatures.length > 0) {
    const callReturnType = callSignatures[0]!.getReturnType();
    // This should be Reactive<Stream<void>> - the type of calling handler(...)({...})
    registerSyntheticCallType(finalCall, callReturnType, typeRegistry);
  }

  return finalCall;
}
