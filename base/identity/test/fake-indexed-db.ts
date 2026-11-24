/**
 * An in-memory stand-in for the part of IndexedDB a `KeyStore` uses, so that a
 * key store can be exercised where there is no IndexedDB. Values are stored
 * by structured cloning, as IndexedDB stores them, and every request settles
 * on a later microtask, after its caller has attached its listeners.
 */

import type {
  KeyStoreDatabase,
  KeyStoreDatabaseFactory,
  KeyStoreObjectStore,
  KeyStoreRequest,
} from "../src/key-store.ts";

/** A request that settles once, with a result or with an error. */
class FakeRequest<T> extends EventTarget implements KeyStoreRequest<T> {
  #result: { value: T } | undefined;
  #error: DOMException | null = null;

  get result(): T {
    if (this.#result === undefined) throw new Error("No result yet.");
    return this.#result.value;
  }

  get error(): DOMException | null {
    return this.#error;
  }

  /** Sets the result without announcing it, for an `upgradeneeded` handler. */
  hold(result: T): void {
    this.#result = { value: result };
  }

  /** Settles with `result` on a later microtask. */
  succeed(result: T): this {
    this.#result = { value: result };
    queueMicrotask(() => this.dispatchEvent(new Event("success")));
    return this;
  }

  /** Settles with `error` on a later microtask. */
  fail(error: DOMException): this {
    this.#error = error;
    queueMicrotask(() => this.dispatchEvent(new Event("error")));
    return this;
  }
}

/** One database: its object stores, by name, each a map from key to value. */
export class FakeDatabase extends EventTarget implements KeyStoreDatabase {
  #stores = new Map<string, Map<string, unknown>>();
  #failure: DOMException | null = null;

  /** The names of the object stores this database holds. */
  get storeNames(): string[] {
    return [...this.#stores.keys()];
  }

  /** Makes every later request against this database fail with `error`. */
  failWith(error: DOMException): void {
    this.#failure = error;
  }

  createObjectStore(name: string): void {
    // A real IndexedDB refuses a second store of the same name.
    if (this.#stores.has(name)) {
      throw new DOMException(`store ${name} exists`, "ConstraintError");
    }
    this.#stores.set(name, new Map());
  }

  transaction(
    storeName: string,
    _mode: IDBTransactionMode,
  ): { objectStore(name: string): KeyStoreObjectStore } {
    this.#entries(storeName);
    return { objectStore: (name) => this.#objectStore(name) };
  }

  #entries(storeName: string): Map<string, unknown> {
    const entries = this.#stores.get(storeName);
    if (entries === undefined) {
      throw new DOMException(`No store ${storeName}.`, "NotFoundError");
    }
    return entries;
  }

  #objectStore(name: string): KeyStoreObjectStore {
    const entries = this.#entries(name);
    const settle = <T>(operation: () => T): KeyStoreRequest<T> => {
      const request = new FakeRequest<T>();
      return this.#failure
        ? request.fail(this.#failure)
        : request.succeed(operation());
    };
    return {
      get: (key) => settle(() => structuredClone(entries.get(key))),
      put: (value, key) =>
        settle(() => {
          entries.set(key, structuredClone(value));
          return key;
        }),
      clear: () =>
        settle(() => {
          entries.clear();
          return undefined;
        }),
    };
  }
}

/** A set of databases by name, opened as IndexedDB opens them. */
export class FakeIndexedDB implements KeyStoreDatabaseFactory {
  #databases = new Map<string, FakeDatabase>();
  #blockNext = false;

  /** Indicates whether the database `name` has been opened. */
  has(name: string): boolean {
    return this.#databases.has(name);
  }

  /** The database named `name`, which must have been opened. */
  database(name: string): FakeDatabase {
    const database = this.#databases.get(name);
    if (database === undefined) throw new Error(`No database ${name}.`);
    return database;
  }

  /** Makes the next `open()` report itself blocked before it succeeds. */
  blockNext(): void {
    this.#blockNext = true;
  }

  open(name: string, _version: number): KeyStoreRequest<KeyStoreDatabase> {
    const request = new FakeRequest<KeyStoreDatabase>();
    const blocked = this.#blockNext;
    this.#blockNext = false;
    let database = this.#databases.get(name);
    queueMicrotask(() => {
      if (blocked) request.dispatchEvent(new Event("blocked"));
      if (database === undefined) {
        database = new FakeDatabase();
        this.#databases.set(name, database);
        request.hold(database);
        request.dispatchEvent(new Event("upgradeneeded"));
      }
      request.succeed(database);
    });
    return request;
  }
}
