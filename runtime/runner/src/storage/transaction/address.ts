import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import type { IMemoryAddress } from "../interface.ts";
import { normalizeCellScope } from "../../scope.ts";

/**
 * Address identity string, per scope INSTANCE (key-vocabulary.md §1
 * site 8): the scope segment is the shared scope_key, resolved against the
 * acting identity of the transaction/notification context the address
 * belongs to — one action tx may carry writes to several instances of one
 * doc (its own narrow instance plus the broad redirect slot), and those
 * must not collapse to one entry. An address that NAMES its instance
 * (`scopeKey`, server-execution v2 stage A — a keyed notification address
 * on a serving replica) is keyed by it; the identity resolves the rest.
 * No space segment: the string is per-space by construction.
 */
export const toString = (address: IMemoryAddress, identity: ScopeKeyIdentity) =>
  `/${
    address.scopeKey ?? resolveScopeKey(address.scope, identity)
  }/${address.id}/${JSON.stringify(address.path)}`;

/**
 * Returns true if `candidate` address references location within the
 * the `source` address. Otherwise returns false.
 */
export const includes = (
  source: IMemoryAddress,
  candidate: IMemoryAddress,
) => {
  if (
    source.id !== candidate.id ||
    normalizeCellScope(source.scope) !== normalizeCellScope(candidate.scope)
  ) {
    return false;
  }

  // Check if candidate path starts with source path
  if (candidate.path.length < source.path.length) {
    return false;
  }

  // Compare each path element
  for (let i = 0; i < source.path.length; i++) {
    if (source.path[i] !== candidate.path[i]) {
      return false;
    }
  }

  return true;
};
