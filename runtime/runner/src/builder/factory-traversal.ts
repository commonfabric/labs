import {
  createFactoryShell,
  factoryStateOf,
  type FactoryStateValueField,
  isAdmittedFabricFactory,
  mapFactoryStateValues,
} from "@commonfabric/data-model/fabric-factory";
import {
  codecOf,
  NULL_LIVE_ENVIRONMENT,
  ProblematicValue,
} from "@commonfabric/data-model/codec-common";
import {
  FabricLink,
  FabricMap,
  FabricSet,
} from "@commonfabric/data-model/fabric-instances";
import {
  deepFreeze,
  FabricInstance,
  type FabricValue,
} from "@commonfabric/data-model";

import {
  deriveFactoryStateCopy,
  isTrustedBuilderArtifact,
} from "./pattern-metadata.ts";

export interface FactoryTraversalContext {
  readonly memo: WeakMap<object, unknown>;
  readonly active: WeakSet<object>;
}

export function createFactoryTraversalContext(): FactoryTraversalContext {
  return {
    memo: new WeakMap<object, unknown>(),
    active: new WeakSet<object>(),
  };
}

/**
 * Whether a Fabric instance owns recursively traversable codec state.
 *
 * Links remain atomic references. FabricMap and FabricSet remain atomic here
 * because their registered codecs deliberately throw until those value kinds
 * are implemented; the canonical writer still rejects them at its codec
 * boundary.
 */
export function hasTraversableFabricInstanceState(
  value: unknown,
): value is FabricInstance {
  return value instanceof FabricInstance &&
    !(value instanceof FabricLink) &&
    !(value instanceof FabricMap) &&
    !(value instanceof FabricSet);
}

/**
 * Traverse the codec-owned state of a Fabric instance and reconstruct the
 * same protocol value when that state changes.
 *
 * This is intentionally separate from ordinary object enumeration: codec
 * state may live in private slots, and the context-free reconstruction path
 * must not acquire runner authority while rebuilding an inert wire value.
 */
export function mapFabricInstanceStateForTraversal<T extends FabricInstance>(
  value: T,
  mapState: (state: FabricValue) => FabricValue,
): T {
  const codec = codecOf(value);
  const state = codec.encode(value as FabricValue, NULL_LIVE_ENVIRONMENT);
  const mappedState = mapState(state);
  if (Object.is(mappedState, state)) return value;

  const mapped = codec.decode(
    codec.tagForValue(value as FabricValue),
    mappedState,
    NULL_LIVE_ENVIRONMENT,
  );
  if (!(mapped instanceof FabricInstance) || codecOf(mapped) !== codec) {
    throw new Error("Codec traversal changed the Fabric instance type");
  }

  // `ProblematicValue.error` is local diagnostic metadata, intentionally not
  // part of the round-tripped wire state. In-process graph transforms must not
  // erase it, so retain it after codec-owned state reconstruction. Re-freezing
  // the replacement preserves the context-free decode's canonical form and
  // cannot materialize any nested factory shell.
  if (value instanceof ProblematicValue && mapped instanceof ProblematicValue) {
    return deepFreeze(
      new ProblematicValue(
        mapped.wireTypeTag,
        mapped.state,
        value.error,
      ),
    ) as unknown as T;
  }
  return mapped as T;
}

function factoryKey(value: unknown): object {
  if (typeof value !== "function") {
    throw new TypeError("Factory traversal requires a callable");
  }
  return value;
}

/**
 * Traverse the hidden value-bearing portion of an admitted factory and rebuild
 * the callable when any nested value changes.
 *
 * Repeated factory identities are ordinary DAG reuse and return the same mapped
 * callable. Only encountering a factory while its own hidden state is active is
 * a cycle.
 */
export function mapFactoryForTraversal<T>(
  factory: T,
  mapValue: (value: unknown, field: FactoryStateValueField) => unknown,
  context: FactoryTraversalContext,
): T {
  if (!isAdmittedFabricFactory(factory)) {
    throw new TypeError(
      "Factory traversal requires an admitted Factory@1 value",
    );
  }

  const key = factoryKey(factory);
  if (context.memo.has(key)) return context.memo.get(key) as T;
  if (context.active.has(key)) {
    throw new TypeError("Circular reference detected in factory state");
  }

  context.active.add(key);
  try {
    const state = factoryStateOf(factory);
    const mappedState = mapFactoryStateValues(state, mapValue);
    let mapped: unknown;
    if (mappedState === state) {
      mapped = factory;
    } else if (isTrustedBuilderArtifact(factory)) {
      mapped = deriveFactoryStateCopy(factory, mappedState);
    } else if ("rootToken" in state) {
      throw new Error("Untrusted live factory state cannot be reconstructed");
    } else {
      mapped = createFactoryShell(mappedState);
    }

    if (!isAdmittedFabricFactory(mapped)) {
      throw new Error("Factory state deriver returned an unadmitted callable");
    }
    const derivedState = factoryStateOf(mapped);
    if (derivedState.kind !== state.kind) {
      throw new Error("Factory state deriver changed the factory kind");
    }
    if (
      "rootToken" in state && "rootToken" in derivedState &&
      state.rootToken !== derivedState.rootToken
    ) {
      throw new Error("Factory state deriver changed the root token");
    }
    if (
      state.ref !== undefined &&
      (derivedState.ref?.identity !== state.ref.identity ||
        derivedState.ref.symbol !== state.ref.symbol)
    ) {
      throw new Error("Factory state deriver changed the artifact ref");
    }

    context.memo.set(key, mapped);
    return mapped as T;
  } finally {
    context.active.delete(key);
  }
}

/**
 * Visit the hidden value-bearing portion of an admitted factory without
 * rebuilding or memoizing it.
 *
 * Unlike mapping, visiting is occurrence-sensitive: callers may attach schema
 * or path meaning to the current occurrence, so a repeated factory must invoke
 * the visitor again. The shared active set still distinguishes ordinary DAG
 * reuse from a real recursive factory-state cycle.
 */
export function visitFactoryForTraversal(
  factory: unknown,
  visitValue: (
    value: unknown,
    field: FactoryStateValueField,
  ) => void,
  context: FactoryTraversalContext,
): void {
  if (!isAdmittedFabricFactory(factory)) {
    throw new TypeError(
      "Factory traversal requires an admitted Factory@1 value",
    );
  }

  const key = factoryKey(factory);
  if (context.active.has(key)) {
    throw new TypeError("Circular reference detected in factory state");
  }

  context.active.add(key);
  try {
    mapFactoryStateValues(factoryStateOf(factory), (value, field) => {
      visitValue(value, field);
      return value;
    });
  } finally {
    context.active.delete(key);
  }
}
