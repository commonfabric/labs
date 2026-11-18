/** Cycle validation for boundaries whose value encoding cannot carry cycles. */

import { BaseFabricPrimitive } from "./fabric-bases/BaseFabricPrimitive.ts";
import type {
  FabricArray,
  FabricContainerValue,
  FabricPlainObject,
  FabricValue,
} from "./interface.ts";
import {
  isValidDeepFrozenFabricValue,
  recordValidDeepFrozenFabricValue,
} from "./deep-freeze.ts";
import { isFabricContainerValue } from "./types/index.ts";
import {
  DefaultValueVisitor,
  DO_RECURSE_VALUES,
  type VisitResult,
  visitValue,
} from "./value-visit/index.ts";

/**
 * Successfully checked frozen graphs need no subsequent walk. This relies on
 * FabricInstance's deep-frozen honesty mandate: frozen state cannot later grow
 * a reference cycle through a private slot.
 */
const acyclic = new WeakSet<object>();

class AcyclicVisitor extends DefaultValueVisitor {
  readonly #seen = new Set<object>();

  override visitFabricContainerValue(
    value: FabricContainerValue,
  ): VisitResult<never, FabricValue> {
    if (acyclic.has(value) || this.#seen.has(value)) {
      return { type: "mapTo", value };
    }
    this.#seen.add(value);
    return DO_RECURSE_VALUES;
  }

  override visitPrimitiveValue(): undefined {
    return undefined;
  }

  override visitCycle(): never {
    throw new Error("Cannot encode a cyclic Fabric value");
  }

  static {
    Object.freeze(this);
    Object.freeze(this.prototype);
  }
}

/**
 * Records `container`, a frozen array or plain object whose own layer is a
 * valid `FabricValue` layer, as a deep-frozen acyclic `FabricValue` when each
 * of its children is already known to be one, so that checking it later costs
 * a lookup. A container with any other child is left for those checks to walk.
 */
export function recordFrozenFabricContainer(
  container: FabricArray | FabricPlainObject,
): void {
  if (Array.isArray(container)) {
    for (let i = 0; i < container.length; i++) {
      if (i in container && !isKnownAcyclicChild(container[i])) return;
    }
  } else {
    for (const child of Object.values(container)) {
      if (!isKnownAcyclicChild(child)) return;
    }
  }
  recordValidDeepFrozenFabricValue(container);
  acyclic.add(container);
}

/**
 * Helper for `recordFrozenFabricContainer()`, which tells whether `value`, a
 * `FabricValue`, is known to be deep-frozen and acyclic without walking it.
 */
function isKnownAcyclicChild(value: FabricValue): boolean {
  return typeof value !== "object" || value === null ||
    BaseFabricPrimitive.isInstance(value) || acyclic.has(value);
}

/**
 * Rejects reference cycles, including cycles through instance codec state.
 * Shared subtrees are allowed. Validation never copies or freezes input;
 * successful checks of deep-frozen roots are memoized by identity.
 */
export function assertAcyclicFabricValue(value: FabricValue): void {
  if (!isFabricContainerValue(value) || acyclic.has(value)) return;
  const visitor = new AcyclicVisitor();
  visitValue(value, visitor);
  if (isValidDeepFrozenFabricValue(value)) acyclic.add(value);
}
