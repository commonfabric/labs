/** Separates list coordinator bookkeeping for each serving resolution identity. */

import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";

import type { AddCancel } from "../cancel.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { isRawBuiltinResult, type RawBuiltinReturnType } from "../module.ts";
import type { Action } from "../scheduler.ts";

/**
 * Creates a coordinator lazily for each demander's full resolution identity.
 * The scheduler may invoke one registered raw action for several principals or
 * sessions. Their setup records and pending sync work belong to separate
 * closures even when the durable child addresses share a scope kind.
 * `storeWrites` names the stores every instance shares, for the one action to
 * declare.
 */
export function listInstanceCoordinator(
  create: (identity: ScopeKeyIdentity | undefined) => RawBuiltinReturnType,
  addCancel: AddCancel,
  storeWrites?: readonly NormalizedFullLink[],
): RawBuiltinReturnType {
  const instances = new Map<string, RawBuiltinReturnType>();
  let registeredAction: Action | undefined;
  let active = true;
  addCancel(() => {
    active = false;
    instances.clear();
  });
  return {
    action: (tx) => {
      if (!active) return;
      const identity = tx.tx.scopeKeyIdentity;
      const scope = identity?.sessionId !== undefined
        ? "session"
        : identity?.principal !== undefined
        ? "user"
        : "space";
      const key = identity === undefined
        ? "space"
        : resolveScopeKey(scope, identity);
      let instance = instances.get(key);
      if (!instance) {
        instance = create(identity === undefined ? undefined : { ...identity });
        instances.set(key, instance);
        if (registeredAction && isRawBuiltinResult(instance)) {
          instance.onActionRegistered?.(registeredAction);
        }
      }
      return isRawBuiltinResult(instance) ? instance.action(tx) : instance(tx);
    },
    onActionRegistered: (action) => {
      registeredAction = action;
      for (const instance of instances.values()) {
        if (isRawBuiltinResult(instance)) instance.onActionRegistered?.(action);
      }
    },
    ...(storeWrites ? { storeWrites } : {}),
  };
}
