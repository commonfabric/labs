import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { normalizeCellScope } from "../scope.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { SpaceScopeAndURI } from "./types.ts";

/**
 * The dependency-graph node key: one node per scope INSTANCE of a document
 * (scopes.md §7 M2; key-vocabulary.md §1 site 1). The middle segment is
 * the shared scope_key vocabulary — never the scope NAME — so dirtiness
 * matches storage's exact-scope_key reader matching instead of collapsing
 * every principal's instances onto one node.
 *
 * `identity` is the acting identity the scoped address resolves against.
 * It arrives WITH the work — in the OFF arm every key is built from the
 * runtime's own authenticated session (`Runtime.scopeKeyIdentity`), which
 * is what keeps this re-keying OFF-arm neutral: at cardinality 1 the
 * re-keyed string partitions state exactly as the scope-NAME string did
 * (key-vocabulary.md §2).
 *
 * An address that NAMES its instance (`address.scopeKey`, server-execution
 * v2 stage A — a served per-instance run's logged read, a keyed
 * notification address) is keyed by that instance and the identity is
 * not consulted: on a serving runtime one node's N instance runs log
 * reads of N different instances of one doc, and each must key to ITS
 * instance rather than to whatever the runtime's own identity would
 * resolve. Absent (every client, the whole OFF arm) the identity resolves
 * it as before, so the field's absence keeps the key text byte-identical.
 *
 * This is also the composite `${space}/${scope_key}/${id}` constructor for
 * every map that shares the format (the storage manager's pending-load
 * keys cross-match these strings in `collectPendingLoadParkKeys`).
 */
export function entityKey(
  address: Pick<IMemorySpaceAddress, "space" | "id" | "scope" | "scopeKey">,
  identity: ScopeKeyIdentity,
): SpaceScopeAndURI {
  return `${address.space}/${
    address.scopeKey ?? resolveScopeKey(address.scope, identity)
  }/${address.id}`;
}

/**
 * The scope-NAME-keyed twin of {@link entityKey}, for the scheduler's
 * reader→writer TOPOLOGY relations (the writer index and the materializer
 * write index — server-execution v2 stage A, key-vocabulary.md §1 site 1's
 * split): a writer's DECLARED write surface names scope NAMES and one node
 * writes ALL instances of that surface (C11b's singular node), so the edge
 * between a user-scoped-declared writer and a reader running as any
 * principal must hold regardless of which instance the reader's logged
 * read names. Keying that index per instance would drop the edge the
 * moment reads carry non-own instances (today both sides collapse to the
 * runtime's own instance and match by accident). Dirtiness — the
 * dependency and trigger keys — stays per instance via {@link entityKey};
 * instance-precise dirtiness across this fan-in is stage B's B7.
 */
export function entityNameKey(
  address: Pick<IMemorySpaceAddress, "space" | "id" | "scope">,
): SpaceScopeAndURI {
  return `${address.space}/${
    normalizeCellScope(address.scope)
  }/${address.id}` as SpaceScopeAndURI;
}
