/** Transactional access to a person's dedicated Home shared-space catalog. */

import type { DID } from "@commonfabric/identity";
import { commitPreconditionValueHash } from "@commonfabric/memory/v2";
import type { Cell, Runtime } from "@commonfabric/runner";

import {
  isSharedSpaceCatalog,
  normalizeSharedSpaceRegistration,
  type SharedSpaceCatalog,
  sharedSpaceCatalogCause,
  type SharedSpaceCatalogHome,
  sharedSpaceCatalogHost,
  type SharedSpaceCatalogRead,
  type SharedSpaceEntry,
  type SharedSpaceMembershipChange,
  type SharedSpaceMembershipResult,
  sharedSpaceOfferKey,
  type SharedSpaceRegistration,
  type SharedSpaceRegistrationResult,
  validateSharedSpaceMembershipChange,
} from "./shared-space-catalog-contract.ts";

/** A host's display admission check, run against the transaction's read. */
export type CatalogReadGuard = (cell: Cell<unknown>) => void;

/**
 * Returns the canonical catalog cell after checking the principal and Home
 * route. The caller supplies Home configuration independently of any shared
 * space's host. Use this cell for invalidation signals; read availability
 * through `getSharedSpaceCatalog()`, which preserves storage failures.
 */
export function sharedSpaceCatalogCell(
  runtime: Runtime,
  home: SharedSpaceCatalogHome,
): Cell<unknown> {
  const cause = sharedSpaceCatalogCause(home.principal);
  if (
    runtime.servingPosture || runtime.userIdentityDID !== home.principal
  ) {
    throw new Error(
      "Catalog Home principal differs from the runtime identity.",
    );
  }
  const host = sharedSpaceCatalogHost(home.host);
  if (
    sharedSpaceCatalogHost(runtime.hostForSpace(home.principal as DID).href) !==
      host
  ) throw new Error("Catalog Home host differs from the runtime's Home route.");
  return runtime.getCell(home.principal as DID, cause, true);
}

/**
 * Reads a validated catalog snapshot. Load failures reject; only a successful
 * storage read can report an absent catalog. Cached cell values alone do not
 * establish availability.
 */
export async function getSharedSpaceCatalog(
  runtime: Runtime,
  home: SharedSpaceCatalogHome,
  admit?: CatalogReadGuard,
): Promise<SharedSpaceCatalogRead> {
  home = { ...home };
  const cell = await loadCatalog(runtime, home);
  const tx = runtime.edit();
  try {
    const bound = cell.withTx(tx);
    admit?.(bound);
    const stored = bound.getRaw();
    if (stored === undefined) return { status: "absent" };
    if (!isSharedSpaceCatalog(stored)) {
      throw new Error("The shared-space catalog is malformed or unsupported.");
    }
    return { status: "ready", catalog: stored };
  } finally {
    tx.abort();
  }
}

/**
 * Registers a validated shared space without changing existing membership.
 * An offer receipt and its entry commit together. A successful return includes
 * server confirmation; a thrown failure must not be interpreted as absence.
 */
export async function registerSharedSpace(
  runtime: Runtime,
  home: SharedSpaceCatalogHome,
  input: SharedSpaceRegistration,
  admit?: CatalogReadGuard,
): Promise<SharedSpaceRegistrationResult> {
  const registration = normalizeSharedSpaceRegistration(input);
  const revision = crypto.randomUUID();
  return await editCatalog(runtime, home, admit, (catalog, changed) => {
    const { space, host, kind, title, offer } = registration;
    const current = catalog.entries[space];
    if (current && current.host !== host) {
      return { status: "conflict", reason: "host" };
    }
    if (current && current.kind !== kind) {
      return { status: "conflict", reason: "kind" };
    }
    const key = offer && sharedSpaceOfferKey(offer.from, offer.id);
    const receipt = key && catalog.offers[key];
    if (
      receipt && (receipt.space !== space || receipt.host !== host ||
        receipt.kind !== kind)
    ) return { status: "conflict", reason: "offer" };
    const entry: SharedSpaceEntry = current ?? {
      space,
      host,
      kind,
      ...(title === undefined ? {} : { title }),
      state: registration.initialState ?? "saved",
      revision,
    };
    if (!current || (key && !receipt)) changed();
    catalog.entries[space] = entry;
    if (key && offer) {
      catalog.offers[key] = { ...offer, space, host, kind };
    }
    return { status: current ? "existing" : "registered", entry };
  });
}

/**
 * Applies an explicit membership action only to the revision it observed.
 * Repeating the same retained action confirms it; a later action makes the
 * old request conflict, even if its requested state happens to match again.
 */
export async function changeSharedSpaceMembership(
  runtime: Runtime,
  home: SharedSpaceCatalogHome,
  change: SharedSpaceMembershipChange,
  admit?: CatalogReadGuard,
): Promise<SharedSpaceMembershipResult> {
  validateSharedSpaceMembershipChange(change);
  change = { ...change };
  const revision = crypto.randomUUID();
  return await editCatalog(runtime, home, admit, (catalog, changed) => {
    const current = catalog.entries[change.space];
    if (!current) return { status: "conflict", reason: "missing" };
    const last = current.lastAction;
    if (last?.id === change.id) {
      return last.expectedRevision === change.expectedRevision &&
          last.state === change.state
        ? { status: "confirmed", entry: current }
        : { status: "conflict", reason: "action" };
    }
    if (current.revision !== change.expectedRevision) {
      return { status: "conflict", reason: "revision" };
    }
    const entry: SharedSpaceEntry = {
      ...current,
      state: change.state,
      revision,
      lastAction: {
        id: change.id,
        expectedRevision: change.expectedRevision,
        state: change.state,
      },
    };
    changed();
    catalog.entries[change.space] = entry;
    return { status: "applied", entry };
  });
}

/**
 * Helper for catalog operations, which validates the backing value and runs
 * the whole transition in one transaction. Storage conflicts re-evaluate the
 * same action and expected revision through the runtime's transaction API.
 */
async function editCatalog<T extends { status: string }>(
  runtime: Runtime,
  home: SharedSpaceCatalogHome,
  admit: CatalogReadGuard | undefined,
  action: (catalog: SharedSpaceCatalog, changed: () => void) => T,
): Promise<T | { status: "conflict"; reason: "catalog-changed" }> {
  home = { ...home };
  const cell = await loadCatalog(runtime, home);
  const address = cell.getAsNormalizedFullLink();
  const result = await runtime.editWithRetry((tx) => {
    sharedSpaceCatalogCell(runtime, home);
    const bound = cell.withTx(tx);
    admit?.(bound);
    const stored = bound.getRaw();
    if (stored !== undefined && !isSharedSpaceCatalog(stored)) {
      throw new Error("The shared-space catalog is malformed or unsupported.");
    }
    const catalog: SharedSpaceCatalog = stored === undefined
      ? { version: 1, entries: {}, offers: {} }
      : {
        ...stored,
        entries: { ...stored.entries },
        offers: { ...stored.offers },
      };
    let changed = false;
    const outcome = action(catalog, () => changed = true);
    if (changed) {
      bound.set(catalog);
    } else if (outcome.status !== "conflict") {
      // Read-only commits can finish locally. Confirmation pins the snapshot
      // at the server, including when a replica has not seen a peer's write.
      if (!tx.addCommitPrecondition) {
        throw new Error("Catalog confirmation requires commit preconditions.");
      }
      tx.addCommitPrecondition(address.space, {
        kind: "entity-value-hash",
        id: address.id,
        scope: address.scope,
        valueHash: stored === undefined
          ? null
          : commitPreconditionValueHash(stored),
      });
    }
    return outcome;
  });
  if (result.error) {
    if (
      result.error.name === "ConflictError" && result.error.message ===
        `entity-value-hash precondition target changed: ${address.id}`
    ) {
      return { status: "conflict", reason: "catalog-changed" };
    }
    throw new Error(result.error.message, { cause: result.error });
  }
  return result.ok;
}

/** Loads the catalog through storage's failure-preserving read interface. */
async function loadCatalog(
  runtime: Runtime,
  home: SharedSpaceCatalogHome,
): Promise<Cell<unknown>> {
  const cell = sharedSpaceCatalogCell(runtime, home);
  await runtime.scheduler.idleWithPendingCommits();
  await cell.sync();
  const address = cell.getAsNormalizedFullLink();
  const provider = runtime.storageManager.open(address.space);
  const loaded = await provider.sync(
    address.id,
    { path: [], schema: false },
    address.scope,
  );
  if (loaded.error !== undefined) {
    throw new Error(loaded.error.message, { cause: loaded.error });
  }
  const denied = runtime.storageManager.spaceAccessError?.(address.space) ??
    runtime.storageManager.authorizationError?.(address.space);
  if (denied !== undefined) throw denied;
  sharedSpaceCatalogCell(runtime, home);
  return cell;
}
