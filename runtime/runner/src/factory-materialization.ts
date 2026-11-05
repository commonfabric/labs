import type { CellScope, InSpaceOptions, JSONSchema } from "@commonfabric/api";
import {
  factoryStateOf,
  type FactoryStateV1,
  type FactoryStateView,
  isAdmittedFabricFactory,
  sealFactoryState,
  tryFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { factorySchemasEqual } from "@commonfabric/data-model-schema";
import { type FabricValue, valueEqual } from "@commonfabric/data-model";
import { deepEqual } from "@commonfabric/js-values/deep-equal";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import {
  getFrameworkProvidedPaths,
  isTrustedBuilderArtifact,
} from "./builder/pattern-metadata.ts";
import type {
  HandlerFactory,
  InternalPatternFactory,
  Module,
  ModuleFactory,
  PatternFactory,
} from "./builder/types.ts";
import type { Runtime } from "./runtime.ts";
import type { MemorySpace } from "./storage/interface.ts";
import {
  type FactoryContract,
  factoryContractFromSchema,
} from "./factory-contract.ts";
import { ContextualFlowControl } from "./cfc.ts";

export type { FactoryContract } from "./factory-contract.ts";

/**
 * The owning consumer's state at the instant an async preparation starts.
 * Every callback is reread after the awaited artifact load.
 */
export interface FactoryMaterializationFence {
  readonly owner: object;
  readonly generation: number;
  readonly currentOwner: () => object | undefined;
  readonly currentGeneration: () => number | undefined;
  readonly currentSelection: () => unknown;
}

export interface FactoryMaterializationContext {
  readonly runtime: Runtime;
  /** Trusted source-space provenance. Never read from Factory@1 state. */
  readonly artifactSpace: MemorySpace;
  readonly expected?: FactoryContract;
  readonly fence?: FactoryMaterializationFence;
}

export type MaterializedFactory =
  | PatternFactory<unknown, unknown>
  | ModuleFactory<unknown, unknown>
  | HandlerFactory<unknown, unknown>;

type FactoryRef = FactoryStateV1["ref"];

/** A well-formed factory whose trusted artifact is not available locally yet. */
export class FactoryArtifactUnavailableError extends Error {
  constructor(
    readonly ref: FactoryRef,
    readonly artifactSpace: MemorySpace,
  ) {
    super(`Factory materialization could not resolve ${refLabel(ref)}`);
    this.name = "FactoryArtifactUnavailableError";
  }
}

/** Internal control-flow signal for a cold load whose owner changed in flight. */
export class FactoryMaterializationSupersededError extends Error {
  constructor() {
    super("Factory materialization was superseded while loading");
    this.name = "FactoryMaterializationSupersededError";
  }
}

interface InspectedFactory {
  readonly value: MaterializedFactory;
  readonly state: FactoryStateView;
  readonly trusted: boolean;
}

interface TrustedFactory {
  readonly value: MaterializedFactory;
  readonly state: FactoryStateView;
  readonly contract: FactoryContract;
}

function refLabel(ref: FactoryRef): string {
  return `${ref.identity}#${ref.symbol}`;
}

function inspectFactory(value: unknown): InspectedFactory {
  if (!isAdmittedFabricFactory(value)) {
    throw new TypeError(
      "Factory materialization requires an admitted FabricFactory",
    );
  }
  return {
    value: value as MaterializedFactory,
    state: factoryStateOf(value),
    trusted: isTrustedBuilderArtifact(value),
  };
}

function requireRef(state: FactoryStateView): FactoryRef {
  if (!("ref" in state) || state.ref === undefined) {
    throw new Error(
      "Factory materialization requires a content-addressed ref",
    );
  }
  return state.ref;
}

function schemaLightByRefName(
  factory: MaterializedFactory,
  state: FactoryStateView,
): string | undefined {
  if (state.kind !== "module") return undefined;
  const module = factory as unknown as Module;
  return module.type === "ref" && typeof module.implementation === "string" &&
      (state.argumentSchema === undefined || state.resultSchema === undefined)
    ? module.implementation
    : undefined;
}

function contractForTrustedFactory(
  factory: MaterializedFactory,
  state: FactoryStateView,
  runtime: Runtime,
): FactoryContract {
  const frameworkProvidedPaths = getFrameworkProvidedPaths(factory);
  switch (state.kind) {
    case "pattern":
      return {
        kind: "pattern",
        argumentSchema: state.argumentSchema,
        resultSchema: state.resultSchema,
        frameworkProvidedPaths,
      };
    case "handler":
      return {
        kind: "handler",
        contextSchema: state.contextSchema,
        eventSchema: state.eventSchema,
        frameworkProvidedPaths,
      };
    case "module": {
      const byRefName = schemaLightByRefName(factory, state);
      if (byRefName === undefined) {
        return {
          kind: "module",
          argumentSchema: state.argumentSchema,
          resultSchema: state.resultSchema,
          frameworkProvidedPaths,
        };
      }
      let registered: Module;
      try {
        registered = runtime.moduleRegistry.getModule(byRefName);
      } catch {
        throw new Error(
          `Factory materialization has no trusted ModuleRegistry metadata for ${byRefName}`,
        );
      }
      return {
        kind: "module",
        argumentSchema: registered.argumentSchema,
        resultSchema: registered.resultSchema,
        frameworkProvidedPaths,
      };
    }
  }
}

function contractFromFactoryState(state: FactoryStateView): FactoryContract {
  switch (state.kind) {
    case "pattern":
      return {
        kind: "pattern",
        argumentSchema: state.argumentSchema,
        resultSchema: state.resultSchema,
        frameworkProvidedPaths: [],
      };
    case "module":
      return {
        kind: "module",
        argumentSchema: state.argumentSchema,
        resultSchema: state.resultSchema,
        frameworkProvidedPaths: [],
      };
    case "handler":
      return {
        kind: "handler",
        contextSchema: state.contextSchema,
        eventSchema: state.eventSchema,
        frameworkProvidedPaths: [],
      };
  }
}

function schemaFields(kind: FactoryContract["kind"]): readonly string[] {
  switch (kind) {
    case "pattern":
    case "module":
      return ["argumentSchema", "resultSchema"];
    case "handler":
      return ["contextSchema", "eventSchema"];
  }
}

function schemaAt(
  value: FactoryContract | FactoryStateView,
  field: string,
): JSONSchema | undefined {
  return (value as unknown as Record<string, JSONSchema | undefined>)[field];
}

/**
 * Compare schemas at a boundary where both documents come from trusted,
 * content-addressed metadata.
 *
 * Exact structure is sufficient even when semantic normalization cannot
 * resolve a recursive or external `$ref`: there is no differing assertion to
 * smuggle through that fast path. Non-identical documents still use the
 * fail-closed semantic comparator.
 */
function trustedFactorySchemasEqual(
  left: JSONSchema | undefined,
  right: JSONSchema | undefined,
): boolean {
  try {
    if (deepEqual(left, right)) return true;
  } catch {
    // Malformed cyclic object graphs are not valid JSON Schema documents.
  }
  return factorySchemasEqual(left, right);
}

function assertExpectedContract(
  actual: FactoryContract,
  expected: FactoryContract | undefined,
): void {
  if (expected === undefined) return;
  if (actual.kind !== expected.kind) {
    throw new Error(
      `Factory materialization kind mismatch: expected ${expected.kind}, got ${actual.kind}`,
    );
  }
  for (const field of schemaFields(actual.kind)) {
    if (
      !trustedFactorySchemasEqual(
        schemaAt(actual, field),
        schemaAt(expected, field),
      )
    ) {
      throw new Error(
        `Factory materialization schema mismatch: expected ${actual.kind} ${field}`,
      );
    }
  }
  if (
    Object.hasOwn(expected, "frameworkProvidedPaths") &&
    !deepEqual(
      actual.frameworkProvidedPaths ?? [],
      expected.frameworkProvidedPaths ?? [],
    )
  ) {
    throw new Error(
      "Factory materialization FrameworkProvided metadata mismatch",
    );
  }
}

/**
 * Test a union alternative without loading or executing the factory.
 *
 * Scheduled input preparation uses this only to select one compiler-owned
 * `asFactory` branch. A decoded shell is compared from its carried canonical
 * contract; a trusted live factory may additionally resolve schema-light
 * ModuleRegistry metadata.
 */
export function factoryMatchesExpectedContract(
  value: unknown,
  expected: FactoryContract,
  runtime: Runtime,
): boolean {
  if (!isAdmittedFabricFactory(value)) return false;
  const inspected = inspectFactory(value);
  const actual = inspected.trusted
    ? contractForTrustedFactory(inspected.value, inspected.state, runtime)
    : contractFromFactoryState(inspected.state);
  try {
    assertExpectedContract(actual, expected);
    return true;
  } catch {
    return false;
  }
}

function assertCarriedSchemas(
  carried: FactoryStateV1,
  trustedState: FactoryStateView,
  trustedContract: FactoryContract,
  schemaLightByRef: boolean,
): void {
  for (const field of schemaFields(carried.kind)) {
    const carriedSchema = schemaAt(carried, field);
    const trustedSchema = schemaAt(
      schemaLightByRef ? trustedContract : trustedState,
      field,
    );
    // A genuine schema-light byRef state omits schemas. If wire state carries a
    // hint, it may only be checked against (never substituted for) registry
    // metadata; final canonical-state equality rejects the forged addition.
    if (
      schemaLightByRef && carriedSchema === undefined ||
      trustedFactorySchemasEqual(carriedSchema, trustedSchema)
    ) {
      continue;
    }
    throw new Error(
      `Factory materialization schema mismatch: ${carried.kind} ${field}`,
    );
  }
  if (carried.kind === "pattern") {
    const carriedHasParamsSchema = Object.hasOwn(carried, "paramsSchema");
    const trustedHasParamsSchema = Object.hasOwn(
      trustedState,
      "paramsSchema",
    );
    const trustedParamsSchema = (trustedState as {
      paramsSchema?: JSONSchema;
    }).paramsSchema;
    if (
      carriedHasParamsSchema !== trustedHasParamsSchema ||
      carriedHasParamsSchema &&
        !trustedFactorySchemasEqual(carried.paramsSchema, trustedParamsSchema)
    ) {
      throw new Error(
        "Factory materialization schema mismatch: pattern paramsSchema",
      );
    }
  }
}

function inspectTrustedFactory(
  value: unknown,
  runtime: Runtime,
  carried?: FactoryStateV1,
): TrustedFactory {
  if (
    typeof value !== "function" || !isAdmittedFabricFactory(value) ||
    !isTrustedBuilderArtifact(value)
  ) {
    const suffix = carried === undefined ? "" : ` for ${refLabel(carried.ref)}`;
    throw new Error(
      `Factory materialization resolved an untrusted artifact${suffix}`,
    );
  }
  const factory = value as MaterializedFactory;
  const state = factoryStateOf(factory);
  if (carried !== undefined && state.kind !== carried.kind) {
    throw new Error(
      `Factory materialization kind mismatch: expected ${carried.kind}, got ${state.kind}`,
    );
  }
  const contract = contractForTrustedFactory(factory, state, runtime);
  if (carried !== undefined) {
    const schemaLight = schemaLightByRefName(factory, state) !== undefined;
    assertCarriedSchemas(carried, state, contract, schemaLight);
    if (
      !("ref" in state) || state.ref === undefined ||
      !deepEqual(state.ref, carried.ref)
    ) {
      throw new Error(
        `Factory materialization forged artifact metadata for ${
          refLabel(carried.ref)
        }`,
      );
    }
  }
  return { value: factory, state, contract };
}

function assertPatternFactoryReady(state: FactoryStateView): void {
  if (
    state.kind === "pattern" &&
    Object.hasOwn(state, "paramsSchema") &&
    !Object.hasOwn(state, "params")
  ) {
    throw new Error("Pattern factory requires bound params");
  }
}

function applyModifiers(
  base: MaterializedFactory,
  state: FactoryStateV1,
): MaterializedFactory {
  let materialized = base;
  if (state.kind === "pattern") {
    let patternFactory = materialized as InternalPatternFactory<
      unknown,
      unknown
    >;
    const baseState = factoryStateOf(patternFactory);
    if (Object.hasOwn(state, "params")) {
      if (baseState.kind !== "pattern") {
        throw new Error("Factory materialization resolved a non-pattern base");
      }
      if (Object.hasOwn(baseState, "params")) {
        if (
          !valueEqual(
            baseState.params as FabricValue,
            state.params as FabricValue,
          )
        ) {
          throw new Error(
            "Factory materialization resolved an already-bound base",
          );
        }
      } else {
        patternFactory = patternFactory.curry(state.params);
      }
      materialized = patternFactory;
    } else if (Object.hasOwn(state, "paramsSchema")) {
      throw new Error("Pattern factory requires bound params");
    }
    if (state.defaultScope !== undefined) {
      materialized = (materialized as PatternFactory<unknown, unknown>)
        .asScope(state.defaultScope);
    }
    if (Object.hasOwn(state, "spaceSelector")) {
      materialized = (materialized as PatternFactory<unknown, unknown>).inSpace(
        state.spaceSelector as never,
        state.spaceRequest as InSpaceOptions | undefined,
      );
    }
  } else if (state.kind === "module" && state.defaultScope !== undefined) {
    materialized = (materialized as ModuleFactory<unknown, unknown>).asScope(
      state.defaultScope as CellScope,
    );
  }
  return materialized;
}

function nonSchemaFactoryState(state: FactoryStateV1): FabricValue {
  switch (state.kind) {
    case "pattern":
      return {
        kind: state.kind,
        ref: state.ref,
        ...(Object.hasOwn(state, "params") ? { params: state.params } : {}),
        ...(Object.hasOwn(state, "defaultScope")
          ? { defaultScope: state.defaultScope }
          : {}),
        ...(Object.hasOwn(state, "spaceSelector")
          ? { spaceSelector: state.spaceSelector }
          : {}),
        ...(Object.hasOwn(state, "spaceRequest")
          ? { spaceRequest: state.spaceRequest }
          : {}),
      } as FabricValue;
    case "module":
      return {
        kind: state.kind,
        ref: state.ref,
        ...(Object.hasOwn(state, "defaultScope")
          ? { defaultScope: state.defaultScope }
          : {}),
      } as FabricValue;
    case "handler":
      return { kind: state.kind, ref: state.ref };
  }
}

function materializeResolved(
  resolved: unknown,
  carried: FactoryStateV1,
  context: FactoryMaterializationContext,
): MaterializedFactory {
  const trusted = inspectTrustedFactory(resolved, context.runtime, carried);
  assertExpectedContract(trusted.contract, context.expected);
  const materialized = applyModifiers(trusted.value, carried);
  let resultingState: FactoryStateV1;
  try {
    resultingState = sealFactoryState(materialized);
  } catch {
    throw new Error(
      `Factory materialization could not preserve canonical state for ${
        refLabel(carried.ref)
      }`,
    );
  }
  if (
    !valueEqual(
      nonSchemaFactoryState(resultingState),
      nonSchemaFactoryState(carried),
    )
  ) {
    throw new Error(
      `Factory materialization forged artifact metadata for ${
        refLabel(carried.ref)
      }`,
    );
  }
  return materialized;
}

function sameSelection(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    if (
      tryFactoryState(left) === undefined ||
      tryFactoryState(right) === undefined
    ) {
      return false;
    }
    // Compare the sealed wire state. Live builder views also carry an opaque
    // root token, whose object identity is intentionally process-local and is
    // not part of a factory selection's canonical equality.
    return valueEqual(
      sealFactoryState(left) as unknown as FabricValue,
      sealFactoryState(right) as unknown as FabricValue,
    );
  } catch {
    return false;
  }
}

function assertCurrentAfterAwait(
  originalSelection: unknown,
  fence: FactoryMaterializationFence | undefined,
): void {
  if (fence === undefined) return;
  // Read all three after the await even when the first fact is stale. In
  // particular, currentSelection is a required post-await reactive reread.
  const owner = fence.currentOwner();
  const generation = fence.currentGeneration();
  const selection = fence.currentSelection();
  if (
    owner !== fence.owner || generation !== fence.generation ||
    !sameSelection(selection, originalSelection)
  ) {
    throw new FactoryMaterializationSupersededError();
  }
}

/**
 * Materialize a direct trusted factory or a decoded shell whose artifact is
 * already warm. This function never performs I/O.
 */
export function materializeFactory(
  value: unknown,
  context: FactoryMaterializationContext,
): MaterializedFactory {
  const inspected = inspectFactory(value);
  if (inspected.trusted) {
    const trusted = inspectTrustedFactory(value, context.runtime);
    assertExpectedContract(trusted.contract, context.expected);
    assertPatternFactoryReady(trusted.state);
    return trusted.value;
  }

  const ref = requireRef(inspected.state);
  const carried = inspected.state as FactoryStateV1;
  const resolved = context.runtime.patternManager.isArtifactAvailableInSpace(
      ref.identity,
      context.artifactSpace,
    )
    ? context.runtime.patternManager.artifactFromIdentitySync(
      ref.identity,
      ref.symbol,
    )
    : undefined;
  if (resolved === undefined) {
    throw new FactoryArtifactUnavailableError(ref, context.artifactSpace);
  }
  return materializeResolved(resolved, carried, context);
}

/**
 * Warm-only runner exposure for one schema-declared factory leaf.
 *
 * This is used by synchronous Cell/query delivery. It returns ordinary values
 * unchanged, returns a live callable when the trusted artifact is warm, and
 * throws {@link FactoryArtifactUnavailableError} rather than leaking an inert
 * shell when the artifact is cold.
 */
export function materializeFactoryForSchema(
  value: unknown,
  schema: JSONSchema | undefined,
  context: Omit<FactoryMaterializationContext, "expected">,
): unknown {
  const resolvedSchema = isObjectNotArray(schema) &&
      typeof schema.$ref === "string"
    ? ContextualFlowControl.resolveSchemaRefsOrThrow(schema, schema)
    : schema;
  const expected = factoryContractFromSchema(resolvedSchema);
  if (expected === undefined || value === undefined) return value;
  return materializeFactory(value, { ...context, expected });
}

/**
 * Async-ready materialization. A cold load may warm PatternManager's cache,
 * but owner/generation/selection are reread before any live factory is built.
 */
export async function prepareFactory(
  value: unknown,
  context: FactoryMaterializationContext,
): Promise<MaterializedFactory> {
  const selection = value;
  const inspected = inspectFactory(value);
  if (inspected.trusted) {
    const trusted = inspectTrustedFactory(value, context.runtime);
    assertExpectedContract(trusted.contract, context.expected);
    assertPatternFactoryReady(trusted.state);
    return trusted.value;
  }

  const ref = requireRef(inspected.state);
  const carried = inspected.state as FactoryStateV1;
  const warm = context.runtime.patternManager.isArtifactAvailableInSpace(
      ref.identity,
      context.artifactSpace,
    )
    ? context.runtime.patternManager.artifactFromIdentitySync(
      ref.identity,
      ref.symbol,
    )
    : undefined;
  if (warm !== undefined) return materializeResolved(warm, carried, context);

  const loaded = await context.runtime.patternManager.loadArtifactByIdentity(
    ref.identity,
    ref.symbol,
    context.artifactSpace,
  );
  assertCurrentAfterAwait(selection, context.fence);
  if (loaded === undefined) {
    throw new FactoryArtifactUnavailableError(ref, context.artifactSpace);
  }
  return materializeResolved(loaded, carried, context);
}
