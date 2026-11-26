import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";
import { isObjectNotArray } from "@commonfabric/js-values/types";

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

/** The part of an `IDBRequest` a key store reads. */
export interface KeyStoreRequest<T> extends EventTarget {
  readonly result: T;
  readonly error: DOMException | null;
}

/** The part of an `IDBObjectStore` a key store uses. */
export interface KeyStoreObjectStore {
  get(key: string): KeyStoreRequest<unknown>;
  put(value: unknown, key: string): KeyStoreRequest<unknown>;
  clear(): KeyStoreRequest<unknown>;
}

/** The part of an `IDBDatabase` a key store uses. */
export interface KeyStoreDatabase extends EventTarget {
  transaction(
    storeName: string,
    mode: IDBTransactionMode,
  ): { objectStore(name: string): KeyStoreObjectStore };
  createObjectStore(name: string): unknown;
}

/** The part of an `IDBFactory` a key store uses to open its database. */
export interface KeyStoreDatabaseFactory {
  open(name: string, version: number): KeyStoreRequest<KeyStoreDatabase>;
}

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
    if (result === undefined) return;
    return Identity.fromKeyPair(keyPairFromStored(result));
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
   * Opens a new instance of `KeyStore`, holding its keys in the database
   * `name` that `factory` opens. If no `name` is provided,
   * `KeyStore.DEFAULT_DB_NAME` is used, and `factory` is the platform's
   * IndexedDB unless one is given.
   */
  static async open(
    name = KeyStore.DEFAULT_DB_NAME,
    factory: KeyStoreDatabaseFactory = globalThis.indexedDB,
  ): Promise<KeyStore> {
    return new KeyStore(await DB.open(factory, name, DB_VERSION));
  }
}

class DB {
  #db: KeyStoreDatabase;
  constructor(db: KeyStoreDatabase) {
    this.#db = db;
  }

  get(key: string): Promise<unknown> {
    const store = this.#getStore(DEFAULT_STORE_NAME, "readonly");
    return asyncWrap(store.get(key));
  }

  set(key: string, value: unknown): Promise<void> {
    const store = this.#getStore(DEFAULT_STORE_NAME, "readwrite");
    return asyncWrap(store.put(value, key)).then(() => undefined);
  }

  async clear(): Promise<void> {
    const store = this.#getStore(DEFAULT_STORE_NAME, "readwrite");
    await asyncWrap(store.clear());
  }

  /**
   * Opens the database `dbName` at `dbVersion` through `factory`, creating
   * its object store when the database is new. Opening at one version only,
   * an upgrade is always from nothing to that version.
   */
  static async open(
    factory: KeyStoreDatabaseFactory,
    dbName: string,
    dbVersion: number,
  ) {
    const req = factory.open(dbName, dbVersion);
    once(req, "upgradeneeded", () => {
      req.result.createObjectStore(DEFAULT_STORE_NAME);
    });
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
  ): KeyStoreObjectStore {
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

function asyncWrap<T>(request: KeyStoreRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    once(request, "success", (_e: Event): unknown => resolve(request.result));
    once(request, "error", (_e: Event): unknown => reject(request.error));
  });
}
