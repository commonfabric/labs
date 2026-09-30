import { dirname, join, resolve } from "@std/path";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type {
  HarnessCredential,
  HarnessCredentialHealth,
  HarnessCredentialProviderId,
} from "./types.ts";

export interface HarnessCredentialStore {
  getRecord(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
  ): Promise<HarnessCredentialRecord>;
  get(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
  ): Promise<HarnessCredential | undefined>;
  set(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    credential: HarnessCredential,
  ): Promise<void>;
  update(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    updater: (
      current: HarnessCredential | undefined,
    ) => Promise<HarnessCredential | undefined> | HarnessCredential | undefined,
    signal?: AbortSignal,
  ): Promise<HarnessCredential | undefined>;
  delete(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
  ): Promise<void>;
  getHealth(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
  ): Promise<HarnessCredentialHealth | undefined>;
  updateRecord(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    updater: (
      current: HarnessCredentialRecord,
    ) => Promise<HarnessCredentialRecord> | HarnessCredentialRecord,
    signal?: AbortSignal,
  ): Promise<HarnessCredentialRecord>;
}

export interface HarnessCredentialRecord {
  credential?: HarnessCredential;
  health?: HarnessCredentialHealth;
}

const assertValidCredentialRecord = (
  record: HarnessCredentialRecord,
): HarnessCredentialRecord => {
  if (record.health !== undefined && record.credential === undefined) {
    throw new Error("credential health requires a credential");
  }
  return record;
};

/**
 * Host-side Loom adapter contract. Implementations keep token material in
 * Loom's encrypted secret backend and resolve only opaque authenticated owner
 * keys; cf-harness never serializes this adapter or its values into run data.
 */
export interface LoomHarnessCredentialStore extends HarnessCredentialStore {
  readonly backend: "loom-encrypted-secret-store";
}

const credentialKey = (ownerKey: string, providerId: string): string =>
  `${ownerKey}\u0000${providerId}`;

class KeyedMutationQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.#tails.set(key, tail);
    const clearTail = () => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    };
    void tail.then(clearTail, clearTail);
    try {
      const turn = previous.catch(() => {});
      if (signal === undefined) {
        await turn;
      } else {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          void turn.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
        signal.throwIfAborted();
      }
      return await operation();
    } finally {
      release();
    }
  }
}

// File-store instances in one process share this queue so cancellation can
// stop before entering an advisory-lock wait held by another local instance.
const fileMutationQueue = new KeyedMutationQueue();

export class InMemoryHarnessCredentialStore implements HarnessCredentialStore {
  readonly #credentials = new Map<string, HarnessCredential>();
  readonly #health = new Map<string, HarnessCredentialHealth>();
  readonly #queue = new KeyedMutationQueue();

  getRecord(ownerKey: string, providerId: HarnessCredentialProviderId) {
    const key = credentialKey(ownerKey, providerId);
    const credential = this.#credentials.get(key);
    const health = this.#health.get(key);
    return Promise.resolve({
      ...(credential === undefined
        ? {}
        : { credential: structuredClone(credential) }),
      ...(health === undefined ? {} : { health: structuredClone(health) }),
    });
  }

  async get(ownerKey: string, providerId: HarnessCredentialProviderId) {
    return (await this.getRecord(ownerKey, providerId)).credential;
  }

  async set(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    credential: HarnessCredential,
  ): Promise<void> {
    await this.updateRecord(ownerKey, providerId, () => ({ credential }));
  }

  update(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    updater: (
      current: HarnessCredential | undefined,
    ) => Promise<HarnessCredential | undefined> | HarnessCredential | undefined,
    signal?: AbortSignal,
  ): Promise<HarnessCredential | undefined> {
    return this.updateRecord(ownerKey, providerId, async (current) => {
      const credential = await updater(current.credential);
      return credential === undefined ? {} : {
        credential,
        ...(current.health !== undefined ? { health: current.health } : {}),
      };
    }, signal).then((record) => record.credential);
  }

  async delete(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
  ): Promise<void> {
    await this.updateRecord(ownerKey, providerId, () => ({}));
  }

  async getHealth(ownerKey: string, providerId: HarnessCredentialProviderId) {
    return (await this.getRecord(ownerKey, providerId)).health;
  }

  updateRecord(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    updater: (
      current: HarnessCredentialRecord,
    ) => Promise<HarnessCredentialRecord> | HarnessCredentialRecord,
    signal?: AbortSignal,
  ): Promise<HarnessCredentialRecord> {
    const key = credentialKey(ownerKey, providerId);
    return this.#queue.run(key, async () => {
      const next = assertValidCredentialRecord(
        await updater({
          ...(this.#credentials.get(key) !== undefined
            ? { credential: structuredClone(this.#credentials.get(key)!) }
            : {}),
          ...(this.#health.get(key) !== undefined
            ? { health: structuredClone(this.#health.get(key)!) }
            : {}),
        }),
      );
      if (next.credential === undefined) this.#credentials.delete(key);
      else this.#credentials.set(key, structuredClone(next.credential));
      if (next.health === undefined) this.#health.delete(key);
      else this.#health.set(key, structuredClone(next.health));
      return structuredClone(next);
    }, signal);
  }
}

interface CredentialDocumentV1 {
  version: 1;
  owners: Record<
    string,
    Partial<Record<HarnessCredentialProviderId, HarnessCredential>>
  >;
}

interface CredentialDocument {
  version: 2;
  owners: CredentialDocumentV1["owners"];
  health: Record<
    string,
    Partial<Record<HarnessCredentialProviderId, HarnessCredentialHealth>>
  >;
}

const emptyDocument = (): CredentialDocument => ({
  version: 2,
  owners: Object.create(null),
  health: Object.create(null),
});

const setOwn = <T extends object>(
  target: T,
  key: PropertyKey,
  value: unknown,
): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

const isCredential = (value: unknown): value is HarnessCredential => {
  if (!isObjectNotArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  return input.type === "oauth" && input.providerId === "openai-codex" &&
    typeof input.accessToken === "string" &&
    typeof input.refreshToken === "string" &&
    typeof input.expiresAt === "number" && Number.isFinite(input.expiresAt) &&
    typeof input.accountId === "string";
};

const isHealth = (value: unknown): value is HarnessCredentialHealth => {
  if (!isObjectNotArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  return input.status === "reconnect-required" &&
    (input.reason === "invalid-grant" || input.reason === "revoked" ||
      input.reason === "refresh-token-reused");
};

const parseDocument = (text: string): CredentialDocument => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // A parse error quotes the source text around the failure, which in this
    // file can be the stored token.
    throw new Error("credential store is not valid JSON");
  }
  if (!isObjectNotArray(parsed)) {
    throw new Error("credential store must contain a JSON object");
  }
  const input = parsed as Record<string, unknown>;
  if (
    (input.version !== 1 && input.version !== 2) ||
    !isObjectNotArray(input.owners)
  ) {
    throw new Error("unsupported credential store format");
  }
  const owners: CredentialDocument["owners"] = Object.create(null);
  for (const [owner, rawProviders] of Object.entries(input.owners)) {
    if (!isObjectNotArray(rawProviders)) {
      throw new Error("invalid credential owner entry");
    }
    const raw = rawProviders as Record<string, unknown>;
    const credential = raw["openai-codex"];
    if (credential !== undefined && !isCredential(credential)) {
      throw new Error("invalid openai-codex credential entry");
    }
    setOwn(
      owners,
      owner,
      credential === undefined ? {} : { "openai-codex": credential },
    );
  }
  const health: CredentialDocument["health"] = Object.create(null);
  if (input.version === 2) {
    if (!isObjectNotArray(input.health)) {
      throw new Error("invalid credential health entries");
    }
    for (const [owner, rawProviders] of Object.entries(input.health)) {
      if (!isObjectNotArray(rawProviders)) {
        throw new Error("invalid credential health owner entry");
      }
      const raw = rawProviders as Record<string, unknown>;
      const providerHealth = raw["openai-codex"];
      if (providerHealth !== undefined && !isHealth(providerHealth)) {
        throw new Error("invalid openai-codex credential health entry");
      }
      setOwn(
        health,
        owner,
        providerHealth === undefined ? {} : { "openai-codex": providerHealth },
      );
      if (
        providerHealth !== undefined &&
        owners[owner]?.["openai-codex"] === undefined
      ) {
        throw new Error(
          "openai-codex credential health requires a credential",
        );
      }
    }
  }
  return { version: 2, owners, health };
};

export interface FileHarnessCredentialStoreOptions {
  path: string;

  /** @internal Observability hook used by lock-contention tests. */
  onLockAcquisitionStarted?: () => void;
}

export class FileHarnessCredentialStore implements HarnessCredentialStore {
  readonly path: string;
  readonly #onLockAcquisitionStarted?: () => void;
  #lastValid: CredentialDocument = emptyDocument();

  constructor(options: FileHarnessCredentialStoreOptions) {
    this.path = resolve(options.path);
    this.#onLockAcquisitionStarted = options.onLockAcquisitionStarted;
  }

  async #ensurePrivateDirectory(): Promise<void> {
    const directory = dirname(this.path);
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await Deno.lstat(directory);
    if (info.isSymlink || !info.isDirectory) {
      throw new Error("credential store directory must not be a symlink");
    }
    if (
      Deno.build.os !== "windows" && info.mode !== null &&
      (info.mode & 0o077) !== 0
    ) {
      throw new Error(
        "credential store directory must have private permissions",
      );
    }
  }

  async #assertPrivateRegularFile(
    path: string,
    label: "credential store" | "credential store lock",
    allowMissing = true,
  ): Promise<void> {
    try {
      const info = await Deno.lstat(path);
      if (info.isSymlink || !info.isFile) {
        throw new Error(`${label} file must be a regular file`);
      }
      if (
        Deno.build.os !== "windows" && info.mode !== null &&
        (info.mode & 0o077) !== 0
      ) {
        throw new Error(`${label} file must have private permissions`);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound && allowMissing) return;
      throw error;
    }
  }

  async #withFileLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.#ensurePrivateDirectory();
    const lockPath = `${this.path}.lock`;
    let lockFile: Deno.FsFile;
    try {
      lockFile = await Deno.open(lockPath, {
        createNew: true,
        read: true,
        write: true,
        mode: 0o600,
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      await this.#assertPrivateRegularFile(
        lockPath,
        "credential store lock",
        false,
      );
      lockFile = await Deno.open(lockPath, { read: true, write: true });
    }
    let locked = false;
    let cleanupDetached = false;
    try {
      await this.#assertPrivateRegularFile(
        lockPath,
        "credential store lock",
        false,
      );
      signal?.throwIfAborted();
      const lockPromise = lockFile.lock(true).then(() => {
        locked = true;
      });
      this.#onLockAcquisitionStarted?.();
      if (signal === undefined) {
        await lockPromise;
      } else {
        let removeAbortListener = () => {};
        const aborted = new Promise<"aborted">((resolve) => {
          const onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () =>
            signal.removeEventListener("abort", onAbort);
        });
        let outcome: "locked" | "aborted";
        try {
          outcome = await Promise.race([
            lockPromise.then(() => "locked" as const),
            aborted,
          ]);
        } finally {
          removeAbortListener();
        }
        if (outcome === "aborted") {
          cleanupDetached = true;
          void (async () => {
            try {
              await lockPromise;
              await lockFile.unlock().catch(() => {});
            } catch {
              // The caller has already observed cancellation.
            } finally {
              lockFile.close();
            }
          })();
          signal.throwIfAborted();
        }
      }
      signal?.throwIfAborted();
      return await operation();
    } finally {
      if (!cleanupDetached) {
        if (locked) await lockFile.unlock().catch(() => {});
        lockFile.close();
      }
    }
  }

  async #read(): Promise<CredentialDocument> {
    try {
      await this.#ensurePrivateDirectory();
      await this.#assertPrivateRegularFile(this.path, "credential store");
      const document = parseDocument(await Deno.readTextFile(this.path));
      this.#lastValid = document;
      return structuredClone(document);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return emptyDocument();
      throw new Error(
        `failed to read credential store: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async #write(document: CredentialDocument): Promise<void> {
    await this.#ensurePrivateDirectory();
    const temporaryPath = join(
      dirname(this.path),
      `.auth-${crypto.randomUUID()}.tmp`,
    );
    let operationFailed = false;
    let operationError: unknown;
    try {
      await Deno.writeTextFile(
        temporaryPath,
        `${JSON.stringify(document, null, 2)}\n`,
        { createNew: true, mode: 0o600 },
      );
      await Deno.chmod(temporaryPath, 0o600);
      await Deno.rename(temporaryPath, this.path);
      this.#lastValid = structuredClone(document);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    try {
      await Deno.remove(temporaryPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) && !operationFailed) {
        throw error;
      }
    }
    if (operationFailed) {
      throw operationError;
    }
  }

  async getRecord(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
  ): Promise<HarnessCredentialRecord> {
    const document = await this.#read();
    const providers = Object.hasOwn(document.owners, ownerKey)
      ? document.owners[ownerKey]
      : undefined;
    const health = Object.hasOwn(document.health, ownerKey)
      ? document.health[ownerKey]
      : undefined;
    return {
      ...(providers?.[providerId] === undefined
        ? {}
        : { credential: providers[providerId] }),
      ...(health?.[providerId] === undefined
        ? {}
        : { health: health[providerId] }),
    };
  }

  async get(ownerKey: string, providerId: HarnessCredentialProviderId) {
    return (await this.getRecord(ownerKey, providerId)).credential;
  }

  async set(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    credential: HarnessCredential,
  ): Promise<void> {
    await this.updateRecord(ownerKey, providerId, () => ({ credential }));
  }

  update(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    updater: (
      current: HarnessCredential | undefined,
    ) => Promise<HarnessCredential | undefined> | HarnessCredential | undefined,
    signal?: AbortSignal,
  ): Promise<HarnessCredential | undefined> {
    return this.updateRecord(ownerKey, providerId, async (current) => {
      const credential = await updater(current.credential);
      return credential === undefined ? {} : {
        credential,
        ...(current.health !== undefined ? { health: current.health } : {}),
      };
    }, signal).then((record) => record.credential);
  }

  async delete(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
  ): Promise<void> {
    await this.updateRecord(ownerKey, providerId, () => ({}));
  }

  async getHealth(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
  ): Promise<HarnessCredentialHealth | undefined> {
    return (await this.getRecord(ownerKey, providerId)).health;
  }

  updateRecord(
    ownerKey: string,
    providerId: HarnessCredentialProviderId,
    updater: (
      current: HarnessCredentialRecord,
    ) => Promise<HarnessCredentialRecord> | HarnessCredentialRecord,
    signal?: AbortSignal,
  ): Promise<HarnessCredentialRecord> {
    // Credentials and their health share this transaction so a refresh cannot
    // expose a terminal result without durably recording the same conclusion.
    return fileMutationQueue.run(
      this.path,
      () =>
        this.#withFileLock(async () => {
          const document = await this.#read();
          const currentProviders = Object.hasOwn(document.owners, ownerKey)
            ? document.owners[ownerKey]
            : undefined;
          const currentHealth = Object.hasOwn(document.health, ownerKey)
            ? document.health[ownerKey]
            : undefined;
          const next = assertValidCredentialRecord(
            await updater({
              ...(currentProviders?.[providerId] !== undefined
                ? { credential: currentProviders[providerId] }
                : {}),
              ...(currentHealth?.[providerId] !== undefined
                ? { health: currentHealth[providerId] }
                : {}),
            }),
          );
          const providers = { ...(currentProviders ?? {}) };
          if (next.credential === undefined) delete providers[providerId];
          else providers[providerId] = next.credential;
          if (Object.keys(providers).length === 0) {
            delete document.owners[ownerKey];
          } else {
            setOwn(document.owners, ownerKey, providers);
          }
          const health = { ...(currentHealth ?? {}) };
          if (next.health === undefined) delete health[providerId];
          else health[providerId] = next.health;
          if (Object.keys(health).length === 0) {
            delete document.health[ownerKey];
          } else {
            setOwn(document.health, ownerKey, health);
          }
          await this.#write(document);
          return structuredClone(next);
        }, signal),
      signal,
    );
  }

  lastValidSnapshot(): unknown {
    return structuredClone(this.#lastValid);
  }
}

export const defaultHarnessCredentialStorePath = (
  harnessHome: string,
): string => join(resolve(harnessHome), "auth.json");
