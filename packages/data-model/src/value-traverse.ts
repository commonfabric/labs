/** Read-only traversal of Fabric containers, including instance codec state. */

import type {
  FabricContainerValue,
  FabricPlainObject,
  FabricValue,
} from "./interface.ts";
import { FabricBytes } from "./fabric-primitives/FabricBytes.ts";
import { isDeepFrozen } from "./deep-freeze.ts";
import {
  DefaultValueVisitor,
  DO_RECURSE_VALUES,
  type VisitResult,
  visitValue,
} from "./value-visit/index.ts";

/**
 * Calls `callback` once per container identity in a Fabric graph, including
 * containers in instance codec state. Input must remain unchanged during the
 * walk. Shared subtrees are visited once; reference cycles are rejected unless
 * `allowCycles` is set, in which case each identity is still visited only once.
 */
export function forEachFabricContainerValue(
  value: FabricValue,
  callback: (value: FabricContainerValue) => void,
  options: { allowCycles?: boolean } = {},
): void {
  visitValue(
    value,
    new ContainerVisitor(callback, options.allowCycles === true),
  );
}

class ContainerVisitor extends DefaultValueVisitor {
  readonly #seen = new WeakSet<object>();
  readonly #callback: (value: FabricContainerValue) => void;
  readonly #allowCycles: boolean;

  constructor(
    callback: (value: FabricContainerValue) => void,
    allowCycles: boolean,
  ) {
    super();
    this.#callback = callback;
    this.#allowCycles = allowCycles;
  }

  override visitFabricContainerValue(
    value: FabricContainerValue,
  ): VisitResult<never, FabricValue> {
    if (this.#seen.has(value)) return { type: "mapTo", value };
    this.#seen.add(value);
    this.#callback(value);
    return DO_RECURSE_VALUES;
  }

  override visitPrimitiveValue(): undefined {
    return undefined;
  }

  override visitCycle(
    value: FabricContainerValue,
  ): VisitResult<never, FabricValue> {
    if (this.#allowCycles) return { type: "mapTo", value };
    throw new Error("Cannot traverse a cyclic Fabric value");
  }

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}

/** Frozen roots keep their estimate without retaining their graphs. */
const sizeEstimates = new WeakMap<object, number>();

/**
 * Estimates a graph's storage weight without encoding or copying it. Counts
 * container identities once, UTF-16 strings, property slots and instance codec
 * state. Opaque primitives receive a conservative maximum weight. This is a
 * cache admission heuristic, not a measurement of the engine's heap layout.
 */
export function estimateFabricValueSize(value: FabricValue): number {
  const cacheable = typeof value === "object" && value !== null &&
    isDeepFrozen(value);
  const cached = cacheable ? sizeEstimates.get(value) : undefined;
  if (cached !== undefined) return cached;
  const visitor = new SizeVisitor();
  visitValue(value, visitor);
  const size = visitor.size;
  if (cacheable) sizeEstimates.set(value, size);
  return size;
}

class SizeVisitor extends DefaultValueVisitor {
  readonly #seen = new WeakSet<object>();
  #size = 0;

  get size(): number {
    return this.#size;
  }

  override visitFabricContainerValue(
    value: FabricContainerValue,
  ): VisitResult<never, FabricValue> {
    if (this.#seen.has(value)) return { type: "mapTo", value };
    this.#seen.add(value);
    this.#size += 64 + (Array.isArray(value) ? value.length * 8 : 0);
    return DO_RECURSE_VALUES;
  }

  override visitingFabricPlainObjectEntry(
    _container: FabricPlainObject,
    key: string,
  ): undefined {
    this.#size += 24 + key.length * 2;
    return undefined;
  }

  override visitPrimitiveValue(value: FabricValue): undefined {
    if (typeof value === "string") this.#size += 16 + value.length * 2;
    else if (typeof value === "bigint") {
      this.#size += 16 + value.toString(16).length;
    } else if (value instanceof FabricBytes) this.#size += 64 + value.length;
    else if (typeof value === "object" && value !== null) {
      this.#size += Number.MAX_SAFE_INTEGER;
    } else if (typeof value === "symbol") {
      this.#size += 16 + (Symbol.keyFor(value)?.length ?? 0) * 2;
    } else this.#size += 8;
    return undefined;
  }

  override visitCycle(
    value: FabricContainerValue,
  ): VisitResult<never, FabricValue> {
    return { type: "mapTo", value };
  }

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}
