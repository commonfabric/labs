import type { Revision, State } from "@commonfabric/memory/interface";

import {
  type BaseMemoryAddress,
  IAttestation,
  ObjectStorageManager,
} from "../traverse.ts";

/**
 * Object Manager backed by a store map.
 *
 * The keys for the store map are of the form: `${address.id}/application/json`
 */
export class StoreObjectManager implements ObjectStorageManager {
  #store: Map<string, Revision<State>>;
  #readValues = new Map<string, IAttestation>();

  /** The docs we can't read, by store key. */
  public missingDocs = new Map<string, BaseMemoryAddress>();

  constructor(store = new Map<string, Revision<State>>()) {
    this.#store = store;
  }

  getReadDocs(): Iterable<IAttestation> {
    return this.#readValues.values();
  }

  getMissingDocs(): Iterable<BaseMemoryAddress> {
    return this.missingDocs.values();
  }

  /**
   * Loads the state at `address`, or returns `null` if there is no matching
   * state.
   */
  load(address: BaseMemoryAddress): IAttestation | null {
    const key = `${address.id}/${address.type ?? "application/json"}`;
    if (this.#readValues.has(key)) {
      return this.#readValues.get(key)!;
    }
    // we should only have one match
    if (this.#store.has(key)) {
      const storeValue = this.#store.get(key);
      const rv = { address: { ...address, path: [] }, value: storeValue?.is };
      this.#readValues.set(key, rv);
      return rv;
    } else {
      if (!this.missingDocs.has(key)) {
        this.missingDocs.set(key, address);
      }
    }
    return null;
  }
}
