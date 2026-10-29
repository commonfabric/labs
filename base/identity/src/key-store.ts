import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { ED25519_ALG } from "./ed25519/utils.ts";
import { Identity } from "./identity.ts";
import { once } from "./utils.ts";

/**
 * The shape a key pair is stored in. IndexedDB carries a value by structured
 * cloning, which does not preserve a class, so the store holds the two keys
 * directly: `CryptoKey` handles where the pair has them -- cloning carries one
 * whole, extractability intact -- and bytes where it holds material.
 */
type StoredKeyPair =
  | CryptoKeyPair
  | { publicKey: Uint8Array; privateKey: Uint8Array };

const DEFAULT_DB_NAME = "common-key-store";
const DEFAULT_STORE_NAME = "key-store";
const DB_VERSION = 1;

// An abstraction around storing key materials in IndexedDb.
export class KeyStore {
  #db: DB;

  constructor(db: DB) {
    this.#db = db;
  }

  /** Gets the `name` keypair. */
  async get(name: string): Promise<Identity | void> {
    const result = await this.#db.get(name);
    if (result) {
      return Identity.fromKeyPair(keyPairFromStored(result));
    }
    return result;
  }

  /** Sets the `name` keypair to `value`. */
  async set(name: string, value: Identity): Promise<undefined> {
    await this.#db.set(name, storedFromKeyPair(value.keyPair));
  }

  /** Clears the key store's table. */
  clear(): Promise<void> {
    return this.#db.clear();
  }

  /** The database name that `open()` uses when not given one. */
  static get DEFAULT_DB_NAME(): string {
    return DEFAULT_DB_NAME;
  }

  /**
   * Opens a new instance of `KeyStore`. If no `name` is provided,
   * `KeyStore.DEFAULT_DB_NAME` is used.
   */
  static async open(name = KeyStore.DEFAULT_DB_NAME): Promise<KeyStore> {
    const db = await DB.open(name, DB_VERSION, (event: Event) => {
      const e = event as IDBVersionChangeEvent;
      const { newVersion, oldVersion: _ } = e;
      if (newVersion !== DB_VERSION) {
        throw new Error("common-identity: Invalid DB version.");
      }
      if (!e.target) {
        throw new Error("common-identity: No target on change event.");
      }
      const db: IDBDatabase = (e.target as IDBRequest).result;
      db.createObjectStore(DEFAULT_STORE_NAME);
    });
    return new KeyStore(db);
  }
}

class DB {
  #db: IDBDatabase;
  constructor(db: IDBDatabase) {
    this.#db = db;
  }

  get(key: string): Promise<StoredKeyPair | void> {
    const store = this.#getStore(DEFAULT_STORE_NAME, "readonly");
    return asyncWrap(store.get(key));
  }

  set(key: string, value: unknown): Promise<void> {
    const store = this.#getStore(DEFAULT_STORE_NAME, "readwrite");
    return asyncWrap(store.put(value, key)).then(() => undefined);
  }

  async clear() {
    const store = this.#getStore(DEFAULT_STORE_NAME, "readwrite");
    return await asyncWrap(store.clear());
  }

  static async open(
    dbName: string,
    dbVersion: number,
    onUpgrade: (e: Event) => void,
  ) {
    const req = globalThis.indexedDB.open(dbName, dbVersion);
    once(req, "upgradeneeded", onUpgrade);
    once(req, "blocked", (_) => {
      console.log("KeyStore: Blocked");
    });
    const db = await asyncWrap(req);
    once(db, "versionchange", (event) => {
      const e = event as IDBVersionChangeEvent;
      console.log("KeyStore: VersionChange", e.oldVersion, e.newVersion);
    });
    return new DB(db);
  }

  #getStore(
    storeName: string,
    mode: "readonly" | "readwrite",
  ): IDBObjectStore {
    const tx = this.#db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }
}

/** Converts a key pair into the form this store holds. */
function storedFromKeyPair(keyPair: FabricKeyPair): StoredKeyPair {
  return keyPair.hasMaterial
    ? {
      publicKey: keyPair.publicKeyBytes.slice(),
      privateKey: keyPair.privateKeyBytes.slice(),
    }
    : keyPair.cryptoKeyPair;
}

/**
 * Converts what this store holds back into a key pair. The algorithm is
 * supplied for the material arm, that arm being bytes and so saying nothing
 * about what they are for; a stored `CryptoKey` reports its own.
 *
 * @throws If the stored value is neither arm's shape.
 */
function keyPairFromStored(stored: unknown): FabricKeyPair {
  if (!isObjectNotArray(stored)) {
    throw new Error("common-identity: Could not read stored key.");
  }

  const { publicKey, privateKey } = stored;

  if (
    (publicKey instanceof Uint8Array) && (privateKey instanceof Uint8Array)
  ) {
    return new FabricKeyPair(ED25519_ALG, publicKey, privateKey);
  } else if (
    globalThis.CryptoKey && (publicKey instanceof globalThis.CryptoKey) &&
    (privateKey instanceof globalThis.CryptoKey)
  ) {
    return new FabricKeyPair({ publicKey, privateKey });
  }

  throw new Error("common-identity: Could not read stored key.");
}

function asyncWrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    once(request, "success", (_e: Event): unknown => resolve(request.result));
    once(request, "error", (_e: Event): unknown => reject(request.error));
  });
}
