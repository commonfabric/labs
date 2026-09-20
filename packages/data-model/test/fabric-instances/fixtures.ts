/**
 * Shared doubles for the `FabricInstance` tests: a live environment that
 * refuses to resolve a cell, and the two recursion callbacks for driving the
 * freeze protocols by hand.
 *
 * The callbacks let a test invoke a protocol member on an instance directly,
 * rather than reaching it through the generic entry point that would otherwise
 * do the walking.
 */

import { deepFreeze, type FabricValue, isDeepFrozen } from "@";
import { BaseLiveEnvironment } from "@/codec-common";

/** Dummy live environment for tests. */
export class DummyLiveEnvironment extends BaseLiveEnvironment {
  override getCell(): never {
    throw new Error("getCell not implemented in test");
  }
}

export const dummyEnv = new DummyLiveEnvironment(true);

/**
 * Recursion-callback helper for exercising the `[DEEP_FREEZE]` protocol member
 * directly (invoking it on an instance with a recursion callback). It uses
 * `deepFreeze` only as a recursion helper on the nested (plain) sub-values --
 * never as the entry point for the instance itself.
 */
export const subFreeze = (v: FabricValue): FabricValue => deepFreeze(v);

/** Like `subFreeze`, except for `[IS_DEEP_FROZEN]` and `isDeepFrozen`. */
export const subIsDeepFrozen = (v: FabricValue): boolean => isDeepFrozen(v);
