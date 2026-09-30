/**
 * The implementation side of the primitive hierarchy: the base class that
 * concrete primitives extend, and the symbol keying the tag each one reports.
 *
 * `FabricPrimitive` is the contract external code is written against, and this
 * is where the shared implementation behind it lives. The split is held by
 * convention rather than by the type system -- nothing stops a subclass from
 * extending the contract directly -- so the invariant is enforced at runtime
 * instead of being assumed.
 */

import { type Constructor } from "@commonfabric/utils/types";

import { FabricPrimitive } from "@/interface.ts";
import type { FabricPrimitiveValueTag } from "@/fabric-primitives";

/**
 * Well-known symbol keying the getter through which a concrete primitive
 * reports its `ValueTag`. A symbol rather than a name, so that the member is
 * implementation plumbing and no part of a primitive's client-facing surface.
 */
export const VALUE_TAG: unique symbol = Symbol("data-model.valueTag");

/**
 * Access key used to authorize calls to `BaseFabricPrimitive[BLESS]()`. It is
 * _not_ `export`ed from this file, so that only `blessFabricPrimitiveClass()`
 * can succeed in performing a blessing.
 */
const BLESSING_KEY: unique symbol = Symbol("data-model.FabricPrimitiveBlessing");

/**
 * Symbol bound on the `BaseFabricPrimitive` constructor (class object) and
 * instances to a method which can bless such objects.
 */
const BLESS: unique symbol = Symbol("data-model.bless");

/**
 * Abstract base class for `FabricPrimitive` subclasses. Concrete
 * `FabricPrimitive` classes extend this, not `FabricPrimitive` directly:
 * `FabricPrimitive` is the pure abstract contract that external code is written
 * against, while `BaseFabricPrimitive` is the designated home for shared
 * implementation. Its counterpart `BaseFabricInstance` carries the
 * `shallowClone()` template method; this class carries the construction-time
 * freeze, the static invariant guard, and the `[VALUE_TAG]` getter that each
 * subclass supplies.
 */
export abstract class BaseFabricPrimitive extends FabricPrimitive {
  /**
   * Brand which indicates by its presence as a `#privateProperty` that this
   * instance was created inside the `data-model`.
   */
  readonly #instanceBlessed = true;

  /** Constructs an instance. */
  constructor() {
    if (!BaseFabricPrimitive.#blessedClasses.has(new.target)) {
      throw new Error("Invalid attempt to construct an instance of an unblessed `FabricPrimitive` class.");
    }

    super();

    // Freezing here rather than at the end of each concrete constructor is
    // sound because a primitive's state is entirely private: private fields
    // are not properties, so a subclass assigns its own after `super()`
    // returns regardless of this. A primitive is immutable from birth and has
    // no mutable phase, so a frozen report is simply true of it -- and the
    // freeze makes it non-extensible too, which is what turns a stray property
    // addition into a throw.
    Object.freeze(this);
  }

  //
  // Subclass contract
  //

  /**
   * The tag this instance reports, one of `FABRIC_PRIMITIVE_VALUE_TAGS`, which
   * the `tagOf*()` dispatches return for it. Each concrete class supplies
   * its own. A subclass of one that does not is tagged as its parent, which
   * is a bug in that subclass and not one the dispatches defend against.
   */
  abstract get [VALUE_TAG](): FabricPrimitiveValueTag;

  //
  // Static members
  //

  /**
   * Set of blessed classes.
   */
  static #blessedClasses = new WeakSet<Constructor<BaseFabricPrimitive>>();

  /**
   * Blesses a class as genuinely minted by the `data-model`, if authorized by
   * `blessingKey`. This also freezes its prototype, to more fully guarantee
   * inertness.
   */
  protected static [BLESS](ctor: Constructor<BaseFabricPrimitive>, blessingKey: typeof BLESSING_KEY) {
    if (blessingKey === BLESSING_KEY) {
      this.#blessedClasses.add(ctor);
      Object.freeze(ctor.prototype);
    } else {
      throw new Error("Invalid attempt to bless `FabricPrimitive` class.");
    }
  }

  /**
   * Type guard for `BaseFabricPrimitive`, which also enforces the invariant
   * that every `FabricPrimitive` is in fact a `BaseFabricPrimitive` which was
   * minted inside the `data-model`. Concrete `FabricPrimitive` classes are
   * required to _directly_ extend `BaseFabricPrimitive`. This function is
   * similar to `BaseFabricInstance.isInstance()` but imposes tighter
   * restrictions, given the fully-controlled nature of the `FabricPrimitive`
   * hierarchy.
   *
   * Like its counterpart, this uses "death before confusion" on the mismatch:
   * it throws rather than quietly returning `false`, so a broken subclass is
   * surfaced at the point of use. The throw is intentional despite the
   * predicate-style name. In addition, because this error can be elicited by
   * client code _not_ controlled by the system, the error message _does not_
   * indicate that it is a "shouldn't happen."
   *
   * @throws If `value` is a `FabricPrimitive` that is not a genuine instance
   *   minted within the `data-model`.
   */
  static isInstance(value: unknown): value is BaseFabricPrimitive {
    if ((value === null) || (typeof value !== "object")) {
      return false;
    } else if (#instanceBlessed in value) {
      return true;
    } else if (value instanceof FabricPrimitive) {
      throw new Error("Detected counterfeit `FabricPrimitive`.");
    } else {
      return false;
    }
  }
}

/**
 * Blesses a constructor (class object) as being a `data-model`-owned
 * `FabricPrimitive` constructor. In addition to simply marking the constructor,
 * this also freezes its `prototype`, to more fully guarantee inertness.
 */
export function blessFabricPrimitiveClass(
  ctor: Constructor<BaseFabricPrimitive>,
) {
  BaseFabricPrimitive[BLESS](ctor, BLESSING_KEY);
}
