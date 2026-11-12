/**
 * Changes to a space's access list after its genesis. `ACLManager` changes a
 * list from outside any pattern, retrying on a conflict; `writeAcl()` is the
 * single write both it and a client handler's `grantSpaceAccess()` and
 * `revokeSpaceAccess()` go through, and `applyAccessListChanges()` is how
 * those two calls' changes are applied to a list, on a client and on a
 * serving runtime.
 */

import { cloneIfNecessary, type FabricValue } from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity/did";
import {
  type ACL,
  aclDocId,
  type ACLUser,
  type DeletionTombstone,
  type DID,
  hasConcreteOwner,
  isACL,
} from "@commonfabric/memory/acl";
import type {
  Capability,
  MemorySpace,
  URI,
} from "@commonfabric/memory/interface";

import type { SpaceAccessChange } from "./builder/types.ts";
import type { Cancel } from "./cancel.ts";
import type { Cell } from "./cell.ts";
import { spaceReaderRole } from "./cfc/space-membership.ts";
import type { Runtime } from "./runtime.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "./storage/interface.ts";

export class ACLManager {
  #runtime: Runtime;
  #spaceDid: DID;

  constructor(runtime: Runtime, spaceDid: DID) {
    this.#runtime = runtime;
    this.#spaceDid = spaceDid;
  }

  async get(): Promise<ACL | null> {
    return validateStoredAcl(await this.getStored());
  }

  /**
   * The access list as stored, unvalidated, or `undefined` when there is none.
   * {@link get} makes the same read and validates what it finds.
   */
  async getStored(): Promise<unknown> {
    const aclCell = this.#getCell();
    await aclCell.sync();
    const aclData = aclCell.get();
    await this.#runtime.storageManager.synced();
    return aclData;
  }

  /**
   * Calls `changed` with the access list as stored whenever it changes, once
   * at once with what it starts from, as a cell's sink does, until the
   * returned function is called.
   */
  sink(changed: (stored: unknown) => void): Cancel {
    return this.#getCell().sink((stored) => changed(stored));
  }

  async set(user: ACLUser, capability: Capability): Promise<ACL> {
    await this.get();
    // Initialization authority is enforced by the memory server. This lets a
    // space identity or service DID create the first concrete OWNER through
    // the management API while an ordinary public-compatibility principal is
    // still rejected server-side.
    return await this.#write((acl) => ({
      ...(acl ?? {}),
      [user]: capability,
    }));
  }

  /** Adds READ or WRITE while retaining stronger access, including concurrent grants. */
  async grant(user: DID, capability: "READ" | "WRITE"): Promise<ACL> {
    if (!isDID(user) || (capability !== "READ" && capability !== "WRITE")) {
      throw new Error("A grant must be READ or WRITE.");
    }
    if (await this.get() === null) {
      throw new Error("No ACL initialized for space.");
    }
    return await this.#write((current) => {
      if (current === null) throw new Error("No ACL initialized for space.");
      const existing = current[user] ?? current["*"];
      return {
        ...current,
        [user]: existing === "OWNER" || existing === "WRITE"
          ? existing
          : capability,
      };
    });
  }

  async remove(user: ACLUser): Promise<ACL> {
    if (await this.get() === null) {
      throw new Error("No ACL initialized for space.");
    }
    return await this.#write((current) => {
      if (current === null) throw new Error("No ACL initialized for space.");
      const { [user]: _removed, ...rest } = current;
      return rest;
    });
  }

  /**
   * Deletes the space, as `by`, its sole member: replaces its access list
   * with a deletion tombstone naming `by`, which ends the space for everyone
   * and for good (INV-15 in `docs/specs/memory-v2/09-invariants.md`). The
   * memory server revokes this runtime's session on the space once it has
   * answered, so nothing here waits on the space afterward.
   *
   * @throws SpaceMembersRemainError when the list names anyone besides `by`,
   *   or does not name `by` at OWNER; Error when there is no list, or the
   *   memory server refuses the deletion.
   */
  async delete(by: DID): Promise<void> {
    await this.get();
    try {
      await this.#commit((tx) =>
        writeDeletionTombstone(tx, this.#spaceDid, by)
      );
    } catch (error) {
      // `editWithRetry` reports what the write throws as the reason of the
      // abort it wraps it in, so the refusal is rethrown as itself, for a
      // caller to tell apart.
      const reason =
        ((error as Error).cause as { reason?: unknown } | undefined)
          ?.reason;
      throw reason instanceof SpaceMembersRemainError ? reason : error;
    }
  }

  async #write(mutate: (current: ACL | null) => ACL): Promise<ACL> {
    const written = await this.#commit((tx) =>
      writeAcl(tx, this.#spaceDid, mutate)
    );
    await this.#runtime.idle();
    await this.#runtime.storageManager.synced();
    return written;
  }

  /**
   * Helper for {@link #write} and {@link delete}, which commits `write`,
   * retrying it on a conflict, and returns what it wrote.
   */
  async #commit<T>(write: (tx: IExtendedStorageTransaction) => T): Promise<T> {
    // `editWithRetry` reruns `write` after catching up from a conflict, so
    // every attempt re-reads the list and derives the replacement from it,
    // and a retry merges with the winning list instead of replaying a stale,
    // precomputed whole-document value over it.
    const result = await this.#runtime.editWithRetry(write);
    if (result.error) {
      const error = new Error(result.error.message, { cause: result.error });
      error.name = result.error.name;
      throw error;
    }
    return result.ok;
  }

  #getCell(): Cell<unknown> {
    return this.#runtime.getCellFromLink({
      id: aclDocId(this.#spaceDid) as URI,
      path: [],
      space: this.#spaceDid,
    });
  }
}

/**
 * Replaces, in `tx`, the access list of `space` with what `mutate` returns
 * given the list `tx` reads there, or `null` when the space has none, and
 * returns the replacement. This is the one place a runtime writes an access
 * list after a space's genesis. A handler on a serving runtime changes one
 * through the memory server instead, which writes it
 * (`Server.commitServedAclChange()`).
 *
 * The write is the single whole-document `set` of the access-list document
 * that the memory server requires of an access-list change (INV-12 in
 * `docs/specs/memory-v2/09-invariants.md`). So `tx` commits it alone, as a
 * commit of its own: a commit carrying anything else is refused. The read of
 * the current list is part of `tx`'s read set, so a concurrent change to the
 * list makes the commit conflict rather than be overwritten.
 *
 * @throws Error when the stored list is malformed or has no concrete `OWNER`,
 *   or whatever `mutate` throws.
 */
export function writeAcl(
  tx: IExtendedStorageTransaction,
  space: DID,
  mutate: (current: ACL | null) => ACL,
): ACL {
  return replaceAclDocumentValue(
    tx,
    space,
    (stored) => mutate(validateStoredAcl(stored)),
  );
}

/**
 * The refusal of a deletion while the access list names principals besides
 * the one deleting the space, `others`, each of whom has to be removed first
 * (INV-15's sole-member clause).
 */
export class SpaceMembersRemainError extends Error {
  override readonly name = "SpaceMembersRemainError";

  /** Constructs an instance for `space`, whose list also names `others`. */
  constructor(space: DID, others: readonly string[]) {
    super(
      `Only the sole member of ${space} may delete it; its access list also ` +
        `names ${others.join(", ")}`,
    );
  }
}

/**
 * Replaces, in `tx`, the access list of `space` with a deletion tombstone
 * naming `by`, the commit that deletes the space (INV-15), and returns the
 * tombstone. It is shaped as `writeAcl()`'s write is, the stored document's
 * other fields carried forward.
 *
 * @throws SpaceMembersRemainError when the list `tx` reads names anyone
 *   besides `by`, or does not name `by` at OWNER; Error when the space has no
 *   list, or a malformed one.
 */
export function writeDeletionTombstone(
  tx: IExtendedStorageTransaction,
  space: DID,
  by: DID,
): DeletionTombstone {
  return replaceAclDocumentValue(tx, space, (stored) => {
    const acl = validateStoredAcl(stored);
    if (acl === null) throw new Error("No ACL initialized for space.");
    const others = Object.keys(acl).filter((principal) => principal !== by);
    if (others.length > 0 || acl[by] !== "OWNER") {
      throw new SpaceMembersRemainError(space, others);
    }
    return { deleted: { by } };
  });
}

/**
 * Helper for {@link writeAcl} and {@link writeDeletionTombstone}, which
 * replaces, in `tx`, the value of `space`'s ACL document with what `valueFor`
 * returns given the value `tx` reads there, and returns it.
 */
function replaceAclDocumentValue<T>(
  tx: IExtendedStorageTransaction,
  space: DID,
  valueFor: (stored: unknown) => T,
): T {
  // A write through the value surface is decomposed into per-key writes at
  // `["value", <user>]`, which the commit builder turns into `op: "patch"`
  // operations that the memory server refuses for this document. Addressing
  // the whole document (path `[]`) takes the whole-document branch of the
  // commit builder instead, which emits the `set` the server asks for.
  const address: IMemorySpaceAddress = {
    space,
    id: aclDocId(space) as URI,
    type: "application/json",
    path: [],
  };
  const envelope = tx.readOrThrow(address) as
    | { readonly value?: unknown }
    | undefined;
  const next = valueFor(envelope?.value);
  // We spread the stored envelope rather than writing a bare `{ value }`: a
  // whole-document write replaces every sibling field, so an envelope built
  // from scratch would drop `["cfc"]` (the persisted label map) or `source`
  // if either were set on the document, erasing a label on every change.
  tx.writeOrThrow(address, {
    ...(envelope ?? {}),
    value: next,
  } as FabricValue);
  return next;
}

/**
 * Returns the stored access-list value `aclData` as a frozen `ACL`, or `null`
 * when it is `undefined`, which is how an absent list reads.
 *
 * @throws Error when `aclData` is malformed or has no concrete `OWNER`.
 */
export function validateStoredAcl(aclData: unknown): ACL | null {
  if (aclData === undefined) {
    return null;
  }
  if (!isACL(aclData) || !hasConcreteOwner(aclData)) {
    throw new Error("Stored ACL is malformed or has no concrete OWNER.");
  }

  // Return an immutable, isolated view: `cloneIfNecessary` (frozen by default)
  // identity-passes the already-deep-frozen stored value (zero-copy) and
  // otherwise freezes a clone. Callers that change the list build a fresh
  // object rather than mutating this.
  return cloneIfNecessary(aclData) as ACL;
}

/**
 * Returns `current`, the access list of `space`, with `changes` applied in
 * order. `current` is `null` when the space has no list. A handler's staged
 * `grantSpaceAccess()` and `revokeSpaceAccess()` calls are applied through
 * this on a client and on a serving runtime alike.
 *
 * @throws Error when a change's actor holds no `OWNER` in the list it
 *   changes, or when a change would leave no concrete `OWNER`.
 */
export function applyAccessListChanges(
  space: MemorySpace,
  current: ACL | null,
  changes: readonly SpaceAccessChange[],
): ACL {
  let acl: ACL | null = current;
  for (const { principal, level, actor } of changes) {
    if (acl === null || spaceReaderRole(acl, actor) !== "owner") {
      throw new Error(
        `Changing the access list of ${space} requires \`OWNER\` there, ` +
          `which ${actor} does not hold.`,
      );
    }
    const { [principal]: _removed, ...rest } = acl;
    const next: ACL = level === undefined
      ? rest
      : { ...rest, [principal]: level };
    if (!hasConcreteOwner(next)) {
      throw new Error(
        `Changing the entry of ${principal} would leave the access list of ` +
          `${space} with no concrete \`OWNER\`.`,
      );
    }
    acl = next;
  }
  return acl ?? {};
}
