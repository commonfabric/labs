import {
  type DebugValueOptions,
  toCompactDebugString,
} from "@commonfabric/data-model";

import { defineAuthoredDebugAccessors } from "../harness/authored-debug-source.ts";
import { getVerifiedProvenance } from "../harness/verified-provenance.ts";
import { hardenVerifiedFunction } from "../sandbox/function-hardening.ts";
import { generateHandlerSchema } from "../schema.ts";
import { assertNotInActionExecution } from "./action-context.ts";
import { toJSONMethod } from "./json-member.ts";
import {
  applyArgumentIfcToResult,
  connectInputAndOutputs,
} from "./node-utils.ts";
import {
  brandTrustedBuilderArtifact,
  getArtifactEntryRef,
} from "./pattern-metadata.ts";
import { getTopFrame } from "./pattern.ts";
import { reactive, stream } from "./reactive.ts";
import { moduleToEncodableForm } from "./to-encodable-form.ts";
import type {
  AssertPart,
  AssertRawPart,
  AssertRecord,
  CellScope,
  FactoryInput,
  Handler,
  HandlerFactory,
  HandlerState,
  JSONSchema,
  Module,
  ModuleFactory,
  NodeRef,
  OpaqueCell,
  Reactive,
  Schema,
  SchemaWithoutCell,
  Stream,
  StripCell,
  toEncodableForm,
  toJSON,
} from "./types.ts";

export function createNodeFactory<T = any, R = any>(
  moduleSpec: Module,
): ModuleFactory<T, R> {
  // Attach source location and preview to function implementations for debugging
  if (typeof moduleSpec.implementation === "function") {
    assertNotInActionExecution("lift");
    const implementation = prepareInspectableImplementation(
      moduleSpec.implementation,
    );
    annotateFunctionDebugMetadata(implementation);
    hardenVerifiedFunction(implementation);
    moduleSpec.implementation = implementation;
  }

  const module: Module & toEncodableForm & toJSON = {
    ...moduleSpec,
    toJSON: toJSONMethod,
    toEncodableForm: () => moduleToEncodableForm(module),
  };
  // A module with ifc confidentiality on its argument schema should have at least
  // that value on its result schema
  module.resultSchema = applyArgumentIfcToResult(
    module.argumentSchema,
    module.resultSchema,
  );
  const factory = Object.assign(
    (inputs: FactoryInput<T>): Reactive<R> => {
      const outputs = reactive<R>(undefined, module.resultSchema);
      const node: NodeRef = { module, inputs, outputs, frame: getTopFrame() };

      connectInputAndOutputs(node);
      (outputs as OpaqueCell<R>).connect(node);

      return outputs;
    },
    module,
  ) as ModuleFactory<T, R>;
  factory.asScope = (scope: CellScope) =>
    createNodeFactory({ ...module, defaultScope: scope });
  // Provenance brand: every node factory (lift / handler / byRef / the list-op
  // factories) is a trusted builder artifact, so a hoisted one registered via
  // `__cfReg` may receive a content-addressed `{ identity, symbol }` reference.
  // Only the trusted builders call `createNodeFactory`, so a `__cf_data`-forged
  // look-alike never acquires the brand. (Patterns brand separately in
  // builder/pattern.ts.)
  brandTrustedBuilderArtifact(factory);
  return factory;
}

/**
 * Declare a module
 *
 * Function-first form, matching pattern()/handler() convention: the callback
 * leads, schemas trail and are optional. The argument/result schemas are plain
 * JSONSchema values that are NOT materialized into the callback input type —
 * the callback's own (or transformer-inferred) type stands. The no-input form
 * is `lift(fn, false)`: argumentSchema:false makes the no-arg application valid
 * (the runner's isValidArgument check passes on `argumentSchema === false`),
 * which is how computed-origin (zero-capture) lifts lower.
 *
 * @param implementation A function that takes an input and returns a result
 *
 * @returns A module node factory that also serializes as module.
 */
// The first overload returns a BARE function type so that a generic
// implementation's type parameter reaches the caller — see `LiftFunction` in
// `packages/api/index.ts` for what TypeScript requires of that shape and what
// declaring it costs. The two overloads below keep `ModuleFactory`: neither
// carries a type parameter through, so neither has anything to preserve.
export function lift<T, R>(
  implementation: (input: T) => R,
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
  options?: DeriveSchedulerOptions,
): (inputs: FactoryInput<StripCell<T>>) => Reactive<R>;
export function lift<T>(
  implementation: (input: T) => any,
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
  options?: DeriveSchedulerOptions,
): ModuleFactory<StripCell<T>, ReturnType<typeof implementation>>;
export function lift<T extends (...args: any[]) => any>(
  implementation: T,
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
  options?: DeriveSchedulerOptions,
): ModuleFactory<StripCell<Parameters<T>[0]>, ReturnType<T>>;
export function lift<T, R>(
  implementation?: ((input: T) => R) | DeriveSchedulerOptions,
  argumentSchema?: JSONSchema | DeriveSchedulerOptions,
  resultSchema?: JSONSchema | DeriveSchedulerOptions,
  options?: DeriveSchedulerOptions,
): ModuleFactory<T, R> {
  const resolvedImplementation =
    (typeof implementation === "function" ? implementation : undefined) as
      | ((input: T) => R)
      | undefined;
  const resolvedArgumentSchema = argumentSchema as JSONSchema | undefined;
  const resolvedResultSchema = resultSchema as JSONSchema | undefined;

  return createNodeFactory({
    type: "javascript",
    implementation: resolvedImplementation,
    ...(resolvedArgumentSchema !== undefined
      ? { argumentSchema: resolvedArgumentSchema }
      : {}),
    ...(resolvedResultSchema !== undefined
      ? { resultSchema: resolvedResultSchema }
      : {}),
    ...(options?.materializerWriteInputPaths
      ? { materializerWriteInputPaths: options.materializerWriteInputPaths }
      : {}),
    ...(options?.completeSchedulerScopeSummary
      ? { completeSchedulerScopeSummary: true as const }
      : {}),
  });
}

interface DeriveSchedulerOptions {
  materializerWriteInputPaths?: readonly (readonly string[])[];
  completeSchedulerScopeSummary?: true;
}

export function byRef<T, R>(ref: string): ModuleFactory<T, R> {
  return createNodeFactory({
    type: "ref",
    implementation: ref,
  });
}

/**
 * The options a `handler(...)` call carries in its trailing slot.
 *
 * `resultSchema` is the verb's declared result — `action<E, R>` /
 * `handler<E, T, R>` — lowered here by the CTS schema-injection stage. It is
 * absent for a value-less verb, and the module then carries no result schema
 * at all, which is what keeps a declared result opt-in.
 *
 * The schema-injected call spreads any options the author wrote into this same
 * object, so a member here may be one this builder does not read.
 */
export interface HandlerOptions {
  resultSchema?: JSONSchema;
}

function handlerInternal<E, T>(
  eventSchema:
    | JSONSchema
    | ((event: E, props: T) => any)
    | undefined,
  stateSchema?: JSONSchema,
  handler?: (event: E, props: T) => any,
  options?: HandlerOptions,
): HandlerFactory<E, T> {
  if (typeof eventSchema === "function") {
    throw new Error(
      "Handler requires schemas or CTS transformer\n" +
        "help: automatic schema inference needs the CTS transforms, which run as part of the Common Fabric build; provide explicit schemas to go without them",
    );
  }

  // Attach source location and preview to handler function for debugging
  if (typeof handler === "function") {
    assertNotInActionExecution("handler");
    handler = prepareInspectableImplementation(handler);
    annotateFunctionDebugMetadata(handler);
    hardenVerifiedFunction(handler);
  }

  const schema = generateHandlerSchema(eventSchema, stateSchema);

  // Carry the argument schema's ifc confidentiality through to the declared
  // result, as `createNodeFactory` does for a lift. Only a declared result is
  // joined: absence stays absence, so a verb that declares nothing keeps a
  // module with no result schema rather than acquiring the join's `true`.
  const resultSchema = options?.resultSchema === undefined
    ? undefined
    : applyArgumentIfcToResult(schema, options.resultSchema);

  const module: Handler<E, T> & toEncodableForm & toJSON & {
    bind: (inputs: FactoryInput<StripCell<T>>) => Stream<E>;
  } = {
    type: "javascript",
    implementation: handler,
    wrapper: "handler",
    with: (inputs: FactoryInput<StripCell<T>>) => factory(inputs),
    // Overriding the default `bind` method on functions. The wrapper will bind
    // the actual inputs, so they'll be available as `this`
    bind: (inputs: FactoryInput<StripCell<T>>) => factory(inputs),
    toJSON: toJSONMethod,
    toEncodableForm: () => moduleToEncodableForm(module),
    ...(schema !== undefined && { argumentSchema: schema }),
    ...(resultSchema !== undefined && { resultSchema }),
  };

  const factory = Object.assign(
    (props: FactoryInput<StripCell<T>>): Stream<E> => {
      // If the event schema is false, we actually set it to true here, since
      // otherwise we won't think it needs to be handled. Ditto for state.
      // TODO(@ubik2): I should be able to remove this workaround, but the stream
      // handler wasn't being triggered. This is a temporary workaround.
      const flexibleEventSchema = eventSchema
        ? eventSchema
        : true as JSONSchema;
      const eventStream = stream<E>(flexibleEventSchema);

      // Set stream marker (cast to E as stream is typed for the events it accepts)
      const node: NodeRef = {
        module,
        inputs: { $ctx: props, $event: eventStream },
        outputs: {},
        frame: getTopFrame(),
      };

      connectInputAndOutputs(node);

      return eventStream;
    },
    module,
  );

  // Provenance brand, like every factory from `createNodeFactory` (whose
  // comment always claimed handler coverage — handler factories are built
  // here and bypassed it): only a branded artifact may acquire a
  // content-addressed `{ identity, symbol }` reference via `__cfReg`
  // indexing, and a non-exported handler's `$implRef`/CFC provenance depends
  // on exactly that registration.
  brandTrustedBuilderArtifact(factory);

  return factory;
}

export function handler<
  E extends JSONSchema = JSONSchema,
  T extends JSONSchema = JSONSchema,
>(
  eventSchema: E,
  stateSchema: T,
  handler: (event: Schema<E>, props: Schema<T>) => any,
): HandlerFactory<SchemaWithoutCell<E>, SchemaWithoutCell<T>>;
export function handler<E, T>(
  eventSchema: JSONSchema,
  stateSchema: JSONSchema,
  handler: (event: E, props: HandlerState<T>) => any,
): HandlerFactory<E, T>;
export function handler<E, T>(
  handler: (event: E, props: HandlerState<T>) => any,
): HandlerFactory<E, T>;
// Declared results, reached only by naming all three type arguments — the
// same explicit-only rule as `action`'s result overload, mirrored here and in
// api's `HandlerFunction` (both halves are hand-maintained; an overload
// present in only one of them is unreachable from patterns while the other's
// tests stay green). The `=> any` overloads above absorb every inferred call
// first, so an incidental return never declares a result. Props typing
// mirrors api too: a callback sees `HandlerState<T>`, with non-handle members
// readonly.
export function handler<E, T, R>(
  eventSchema: JSONSchema,
  stateSchema: JSONSchema,
  handler: (event: E, props: HandlerState<T>) => R,
): HandlerFactory<E, T, R>;
export function handler<E, T, R>(
  handler: (event: E, props: HandlerState<T>) => R,
): HandlerFactory<E, T, R>;
// The trailing options slot is not part of the authored surface: a pattern
// declares its result with the type argument above, and the schema-injection
// stage lowers that declaration into `options.resultSchema` here.
export function handler<E, T, R = void>(
  eventSchema:
    | JSONSchema
    | ((event: E, props: T) => any)
    | undefined,
  stateSchema?: JSONSchema,
  handler?: (event: E, props: T) => any,
  options?: HandlerOptions,
): HandlerFactory<E, T, R> {
  return handlerInternal(
    eventSchema,
    stateSchema,
    handler,
    options,
  ) as HandlerFactory<E, T, R>;
}

// unsafe closures: doesn't need any arguments.
// Uses argumentSchema: false to signal "takes no input" so the action
// validation doesn't skip it due to undefined arguments.
export const computed: <T>(fn: () => T) => Reactive<T> = <T>(fn: () => T) =>
  createNodeFactory<any, T>({
    type: "javascript",
    implementation: fn,
    argumentSchema: false,
  })(undefined);

/**
 * Records one operand of an `assert` body and returns it unchanged.
 *
 * It stores the resolved value the body computed rather than rendering it. The
 * array is local to a single evaluation of the body and is discarded unless the
 * assertion fails, so `assertRenderParts` renders these only on that failing
 * path — a passing assertion never renders an operand.
 */
export const assertCapture = <T>(
  parts: AssertRawPart[],
  src: string,
  value: T,
): T => {
  parts.push({ src, value });
  return value;
};

/**
 * Rendering options for a failing assertion's operands: as deep, as many array
 * elements and buffer bytes, and as long a string as the conversion allows.
 * A view tree costs two levels per node and a nested cell three, so the
 * renderer's default depth elides an operand after a handful of nodes; a
 * list or a string differs from what was expected at whatever index it does,
 * and the renderer's default lengths would elide exactly that. A diagnostic
 * wants the whole of it.
 */
const ASSERT_RENDER_OPTIONS: DebugValueOptions = {
  maxDepth: Infinity,
  maxArrayLength: Infinity,
  maxBufferLength: Infinity,
  maxProperties: Infinity,
  maxStringLines: Infinity,
};

/**
 * Renders the operands captured by `assertCapture` into the record's `parts`.
 *
 * A passing assertion (`ok === true`) returns an empty list without touching
 * the values, so the common case pays nothing to render diagnostics it will
 * never show. Only a failing assertion renders each captured value with
 * `toCompactDebugString` with `ASSERT_RENDER_OPTIONS`.
 */
export const assertRenderParts = (
  ok: boolean,
  parts: AssertRawPart[],
): AssertPart[] =>
  ok ? [] : parts.map(({ src, value }) => ({
    src,
    rendered: toCompactDebugString(value, ASSERT_RENDER_OPTIONS),
  }));

/**
 * assert: a `computed` for pattern-test assertions that reports its operands.
 *
 * The assert-diagnostics transformer rewrites the body to record each operand
 * and to return an `AssertRecord`, so this implementation is reached only when
 * a source opts out of the transform. It produces the same record shape with
 * no operands recorded, so the declared type holds either way.
 */
export const assert: (fn: () => boolean) => Reactive<AssertRecord> = (
  fn: () => boolean,
) =>
  createNodeFactory<any, AssertRecord>({
    type: "javascript",
    implementation: () => ({ ok: fn(), source: "", parts: [] }),
    argumentSchema: false,
  })(undefined);

/**
 * action: Creates a handler that doesn't use the state parameter.
 *
 * This is to handler as computed is to lift:
 * - User writes: action((e) => count.set(e.data))
 * - Transformer rewrites to: handler((e, { count }) => count.set(e.data))({ count })
 *
 * The transformer extracts closures and makes them explicit, just like how
 * computed(() => expr) becomes a lift-applied computation with closure
 * extraction.
 *
 * NOTE: This function should never be called directly at runtime because the
 * CTS transformer rewrites action() calls to handler() calls. If this function
 * is reached, it means CTS is not enabled.
 *
 * @example Zero-parameter action (most common)
 * ```ts
 * const increment = action(() => count.set(count.get() + 1));
 * // Returns Stream<void>
 * ```
 *
 * @example Action with event data
 * ```ts
 * const selectItem = action((id: string) => selected.set(id));
 * // Returns Stream<string>
 * ```
 *
 * @param _event - A function that receives an event and performs side effects
 * @throws Error if called directly (CTS must be enabled for action() to work)
 */
export function action(_event: () => void): Stream<void>;
export function action<E>(_event: (event: E) => void): Stream<E>;
// Overload 3: a declared result, reached only by supplying both type arguments
// explicitly — `action<AddTopic, TopicRef>((e) => { ...; return ref })`.
//
// The result is NOT inferred from the callback, deliberately. A concise arrow
// body returns whatever its last call evaluates to, and the common ones return
// values rather than void — `Cell.set` returns the cell (api `ISettable`), so
// `action((id: string) => selected.set(id))` would infer a `Cell` result and
// silently declare a verb result nobody wrote. TypeScript cannot tell that
// incidental return from a deliberate one, so overload 2 absorbs every
// callback (anything is assignable to a void-returning signature) and a result
// has to be asked for by name.
//
// Contextual typing does not reach here either: annotating the binding
// `const v: Stream<E, R> = action(...)` still selects overload 2 and fails to
// assign. That failure is the intended one — dropping a declared result is a
// compile error naming `[CELL_RESULT_TYPE]`, not silence.
export function action<E, R>(
  _event: (event: E) => R,
): Stream<E, R>;
export function action<E, R = void>(
  _event: (event?: E) => R,
): Stream<E, R> {
  throw new Error(
    "action() must be used with CTS transforms enabled - it is rewritten to handler() at compile time by the Common Fabric build process",
  );
}

function annotateFunctionDebugMetadata(
  fn: (...args: any[]) => unknown,
): void {
  if (!Object.isExtensible(fn)) {
    return;
  }

  // The sidecar is consumed only after module evaluation, immediately before
  // provenance is recorded. Install the lazy accessors now, while the function
  // is still extensible; hardening freezes it moments from here.
  defineAuthoredDebugAccessors(fn);

  // Store function body preview for hover tooltips.
  const fnStr = fn.toString();
  (fn as { preview?: string }).preview = fnStr.slice(0, 200);
}

function prepareInspectableImplementation<
  T extends (...args: any[]) => unknown,
>(
  implementation: T,
): T {
  if (Object.isExtensible(implementation)) {
    return implementation;
  }

  // A hardened implementation that already carries verified identity must be
  // returned as-is. Provenance and artifact entry refs are keyed on the
  // function OBJECT (WeakMaps, the anti-spoof design), so the wrapper below is
  // a fresh identity-less function: it serializes body-only with no `$implRef`
  // and re-evaluates bare-SES — module scope gone — on reload (the silent
  // "helper is not a function" unlink; see the helper-unlink investigation
  // record). A registered implementation already passed through a factory
  // once — that is how it was registered — so it already carries its
  // inspectable metadata and loses nothing by skipping the wrap.
  if (
    getVerifiedProvenance(implementation) !== undefined ||
    getArtifactEntryRef(implementation) !== undefined
  ) {
    return implementation;
  }

  const source = implementation.toString();
  const wrapped = function (this: unknown, ...args: Parameters<T>) {
    return implementation.apply(this, args);
  } as (...args: Parameters<T>) => ReturnType<T>;

  Object.defineProperty(wrapped, "toString", {
    value: () => source,
    configurable: true,
  });

  return wrapped as T;
}
