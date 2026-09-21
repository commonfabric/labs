import { cloneIfNecessary, type FabricValue } from "@commonfabric/data-model";
import { isDIDKey } from "@commonfabric/identity/did";
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
import type { IMemorySpaceAddress } from "./storage/interface.ts";

export class ACLManager {
  #runtime: Runtime;
  #spaceDid: DID;

  constructor(runtime: Runtime, spaceDid: DID) {
    this.#runtime = runtime;
    this.#spaceDid = spaceDid;
  }

  async get(): Promise<ACL | null> {
    const aclCell = this.#getCell();
    await aclCell.sync();
    const aclData = aclCell.get();
    await this.#runtime.storageManager.synced();

    return this.#validateStoredACL(aclData);
  }

  #validateStoredACL(aclData: unknown): ACL | null {
    if (aclData === undefined) {
      return null;
    }
    if (!isACL(aclData) || !hasConcreteOwner(aclData)) {
      throw new Error("Stored ACL is malformed or has no concrete OWNER.");
    }

    // Return an immutable, isolated view: `cloneIfNecessary` (frozen by
    // default) identity-passes the already-deep-frozen stored value (zero-copy)
    // and otherwise freezes a clone. Callers that change the ACL (`set` /
    // `remove`) build a fresh object rather than mutating this.
    return cloneIfNecessary(aclData) as ACL;
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
    if (!isDIDKey(user) || (capability !== "READ" && capability !== "WRITE")) {
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
    // The memory server requires an ACL mutation to be a single whole-document
    // `set` on `of:<space>`, rejecting anything else with "ACL mutations must
    // replace the space-scoped ACL document". Writing through the value
    // surface does not produce one: `normalizeAndDiff` decomposes a
    // `Cell.set()` into per-key write details at `["value", <user>]`, and the
    // commit builder turns those into `op: "patch"`. Genesis only worked
    // because it hand-rolls a raw `set` and bypasses the commit builder
    // entirely, so every post-genesis grant and revoke failed.
    //
    // Address the whole document (path `[]`) instead. That takes the
    // whole-document branch in the commit builder and emits the `set` the
    // server's storage invariant asks for.
    const address: IMemorySpaceAddress = {
      space: this.#spaceDid,
      id: aclDocId(this.#spaceDid) as URI,
      type: "application/json",
      path: [],
    };
    const result = await this.#runtime.editWithRetry((tx) => {
      // `editWithRetry` reruns this callback after catching up from a
      // conflict. Re-read and derive the replacement in every attempt so a
      // retry merges with the winning ACL instead of replaying a stale,
      // precomputed whole-document value over it.
      const envelope = tx.readOrThrow(address) as
        | { readonly value?: unknown }
        | undefined;
      const current = this.#validateStoredACL(envelope?.value);
      const next = mutate(current);
      // Spread the stored envelope rather than writing a bare `{ value }`: a
      // whole-document write replaces every sibling field, so constructing the
      // envelope from scratch would silently drop `["cfc"]` (the persisted
      // label map) or `source` if either is ever set on the ACL document.
      // Neither exists on it today — this keeps that from becoming a latent
      // way to erase a label on every grant.
      tx.writeOrThrow(address, {
        ...(envelope ?? {}),
        value: next,
      } as FabricValue);
      return next;
    });
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
