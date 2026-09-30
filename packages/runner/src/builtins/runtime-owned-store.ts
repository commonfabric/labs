// The seam a builtin holding state goes through: mint the document, name it to
// the write-side fit check, and enroll it for as long as the piece runs.
//
// A store the runtime owns holds whatever the transactions running a builtin
// read, so no confidentiality an author writes into a schema covers it. Naming
// it here is what lets CFC's fit check (spec §8.12.4) declare that policy from
// the flow instead of refusing the write; `docs/specs/cfc-enforcement-matrix.md`
// §4 states which stores qualify.

import type { JSONSchema } from "../builder/types.ts";
import { type Cell, cellRuntime } from "../cell.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
  runtimeWritePolicyAuthorization,
} from "../cfc/types.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { runtimeOwnedStoreOwnerKey } from "../cfc/runtime-owned-stores.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { scopedCell } from "./scope-policy.ts";

/**
 * Name `store` as a store the runtime owns for `owner`'s piece: a document a
 * builtin mints from its own node's cause to hold state, rather than data an
 * author named.
 *
 * A builtin's state store holds whatever the transactions running that builtin
 * read, and an author cannot know which atoms a given transaction will carry,
 * so no confidentiality declaration written into a schema covers it. CFC's
 * write-side fit check (spec §8.12.4) reads this marker and declares that
 * policy itself; `docs/specs/cfc-enforcement-matrix.md` §4 states the route.
 * The runner records the same marker for a piece's own argument, result and
 * internal documents.
 *
 * Only a store keyed on this NODE belongs here. A document the runtime mints
 * from a constant or from the space's own principal — a space cell, a shared
 * clock, a per-space pinned-cell list — is shared by every piece in the space,
 * so one piece's flow join has no business becoming its declared policy.
 *
 * The marker names the store for THIS transaction, which is what a store the
 * runtime mints and fills in one go needs — a dialog message, say. A store the
 * node keeps across transactions wants {@link ownedCell}, which enrolls it as
 * well.
 *
 * The marker carries the runtime's authorization, which is what the fit check
 * asks for: the method that records it is reachable from anything holding a
 * cell, so an unmarked marker naming the same document counts for nothing.
 */
export function recordRuntimeOwnedStore(
  tx: IExtendedStorageTransaction,
  owner: Cell<any>,
  store: Cell<any>,
): void {
  const ownerLink = owner.getAsNormalizedFullLink();
  const storeLink = store.getAsNormalizedFullLink();
  tx.recordCfcWritePolicyInput({
    kind: "structural-provenance",
    target: {
      space: storeLink.space,
      id: storeLink.id,
      scope: storeLink.scope,
      path: [...storeLink.path],
    },
    claim: CFC_STRUCTURAL_PROVENANCE_RUNTIME_OWNED_STORE,
    sources: [{
      space: ownerLink.space,
      id: ownerLink.id,
      scope: ownerLink.scope,
      path: [...ownerLink.path],
    }],
  }, runtimeWritePolicyAuthorization);
}

/**
 * The store this node keeps under `cause`, at `scope` — minted in `owner`'s
 * space, named to the write-side fit check per {@link
 * recordRuntimeOwnedStore}, ENROLLED for the rest of this runtime's life, and
 * addressed at the instance scope the caller asked for.
 *
 * This is the shape every builtin holding its own state uses, so the mint, the
 * marker and the scoping stay together: a builtin that mints a store without
 * naming it has a store whose every labeled write is refused, and the refusal
 * arrives at whichever later transaction first carries a label rather than at
 * the mint.
 *
 * The enrollment is what reaches those later transactions — a node's state is
 * written by event handlers and by settled requests, each on a transaction of
 * its own. It lasts until `owner`'s piece is cancelled, which is why only a
 * store the node KEEPS belongs here: one minted per event would grow the
 * enrollment for as long as the piece runs, and needs the marker alone.
 */
export function ownedCell<T = any>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  owner: Cell<any>,
  cause: unknown,
  schema: JSONSchema | undefined,
  scope: NormalizedFullLink["scope"],
): Cell<T> {
  const base = runtime.getCell<T>(owner.space, cause, schema, tx);
  const store = scopedCell(runtime, tx, base, scope);
  recordRuntimeOwnedStore(tx, owner, store);
  enrollRuntimeOwnedStore(tx, owner, store);
  return store;
}

/**
 * Enroll `store` as a store the runtime owns for `owner`'s piece, so a
 * transaction that neither minted it nor re-marked it still finds it, until
 * that piece's nodes are cancelled. Pairs with {@link
 * recordRuntimeOwnedStore}, which names it for one transaction; both are
 * wanted where a store outlives its mint.
 */
export function enrollRuntimeOwnedStore(
  tx: IExtendedStorageTransaction,
  owner: Cell<any>,
  store: Cell<any>,
): void {
  const ownerLink = owner.getAsNormalizedFullLink();
  const storeLink = store.getAsNormalizedFullLink();
  const ownerKey = runtimeOwnedStoreOwnerKey(
    storeLink,
    ownerLink,
    cellRuntime(owner).scopeKeyIdentity,
  );
  if (ownerKey === undefined) return;
  tx.enrollRuntimeOwnedStore(
    {
      space: storeLink.space,
      id: storeLink.id,
      scope: storeLink.scope,
      path: [...storeLink.path],
    },
    ownerKey,
    runtimeWritePolicyAuthorization,
  );
}
