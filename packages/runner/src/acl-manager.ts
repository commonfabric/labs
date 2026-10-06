/**
 * Changes to a space's access list after its genesis. `ACLManager` changes a
 * list from outside any pattern, retrying on a conflict; `writeAcl()` is the
 * single write both it and a handler's `grantSpaceAccess()` and
 * `revokeSpaceAccess()` go through.
 */

import { cloneIfNecessary, type FabricValue } from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity/did";
import {
  type ACL,
  aclDocId,
  type ACLUser,
  type DID,
  hasConcreteOwner,
  isACL,
} from "@commonfabric/memory/acl";
import type { Capability, URI } from "@commonfabric/memory/interface";

import type { Cell } from "./cell.ts";
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
    await this.get();
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
    const acl = await this.get();
    if (acl === null) {
      throw new Error("No ACL initialized for space.");
    }
    return await this.#write((current) => {
      if (current === null) {
        throw new Error("No ACL initialized for space.");
      }
      const { [user]: _removed, ...rest } = current;
      return rest;
    });
  }

  async #write(mutate: (current: ACL | null) => ACL): Promise<ACL> {
    const result = await this.#runtime.editWithRetry((tx) =>
      // `editWithRetry` reruns this callback after catching up from a
      // conflict, so every attempt re-reads the list and derives the
      // replacement from it, and a retry merges with the winning list instead
      // of replaying a stale, precomputed whole-document value over it.
      writeAcl(tx, this.#spaceDid, mutate)
    );
    if (result.error) {
      const error = new Error(result.error.message, { cause: result.error });
      error.name = result.error.name;
      throw error;
    }
    await this.#runtime.idle();
    await this.#runtime.storageManager.synced();
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
 * returns the replacement. This is the one place the runtime writes an access
 * list after a space's genesis.
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
  const next = mutate(validateStoredAcl(envelope?.value));
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
