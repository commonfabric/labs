import { backtickQuote } from "@commonfabric/utils/markdown";
import type { FabricInstance } from "@/interface.ts";
import { BaseFabricInstance, DEEP_CLONE_CORE } from "@/fabric-bases";

/**
 * Abstract base class for `FabricInstance` wrappers that bridge native JS
 * objects into the `FabricValue` layer. Provides a common `toNativeValue()`
 * method used by both the shallow and deep unwrap functions, replacing their
 * `instanceof` cascades with a single `instanceof FabricNativeWrapper` check.
 */
export abstract class FabricNativeWrapper<T extends object>
  extends BaseFabricInstance {
  /**
   * The wrapped JS value, used by `toNativeValue()` for freeze-state
   * checks.
   */
  protected abstract get wrappedValue(): T;

  /**
   * Converts the wrapped value to frozen form. Only called on a state
   * mismatch.
   */
  protected abstract toNativeFrozen(): T;

  /**
   * Converts the wrapped value to thawed form. Only called on a state
   * mismatch.
   */
  protected abstract toNativeThawed(): T;

  /** Returns the underlying JS value, optionally frozen. */
  toNativeValue(frozen: boolean): T {
    const value = this.wrappedValue;
    if (frozen === Object.isFrozen(value)) return value;
    return frozen ? this.toNativeFrozen() : this.toNativeThawed();
  }

  /**
   * @inheritDoc
   *
   * Deep cloning is rolled out per subclass: those that support it (e.g.
   * `FabricError`) override this with a real core; the rest inherit this
   * throwing stub, so their `deepClone()` throws.
   */
  protected [DEEP_CLONE_CORE](_frozen: boolean): FabricInstance {
    throw new Error(
      `Cannot yet handle deep cloning of ${
        backtickQuote(this.constructor.name)
      }.`,
    );
  }
}
