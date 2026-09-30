import { dirname, join, resolve } from "@std/path";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  type HarnessModelProviderId,
  isHarnessModelProviderId,
} from "../config.ts";
import { HarnessControlError } from "../control-errors.ts";

export const HARNESS_PROVIDER_SETTINGS_VERSION = 1 as const;

export interface HarnessProviderSettings {
  version: typeof HARNESS_PROVIDER_SETTINGS_VERSION;
  modelProvider: HarnessModelProviderId;
}

export type HarnessProviderSettingsState =
  | { state: "missing" }
  | { state: "configured"; settings: HarnessProviderSettings }
  | { state: "invalid"; detail: string }
  | { state: "unsupported-version"; version: number | null }
  | { state: "unreadable"; detail: string };

export interface HarnessProviderResolution {
  provider: HarnessModelProviderId;
  source: "explicit" | "environment" | "persistent";
}

const detailOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const parseDocument = (text: string): HarnessProviderSettingsState => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { state: "invalid", detail: "settings file is not valid JSON" };
  }
  if (!isObjectNotArray(parsed)) {
    return { state: "invalid", detail: "settings file must contain an object" };
  }
  const input = parsed as Record<string, unknown>;
  if (input.version !== HARNESS_PROVIDER_SETTINGS_VERSION) {
    const version = typeof input.version === "number" &&
        Number.isSafeInteger(input.version)
      ? input.version
      : null;
    return { state: "unsupported-version", version };
  }
  if (!isHarnessModelProviderId(input.modelProvider)) {
    return {
      state: "invalid",
      detail: "settings file contains an invalid model provider",
    };
  }
  return {
    state: "configured",
    settings: {
      version: HARNESS_PROVIDER_SETTINGS_VERSION,
      modelProvider: input.modelProvider,
    },
  };
};

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

const mutationQueue = new KeyedMutationQueue();

export interface FileHarnessProviderSettingsStoreOptions {
  path: string;

  /** @internal Observability hook used by lock-contention tests. */
  onLockAcquisitionStarted?: () => void;
}

/** Secure persistent storage for the machine's default model provider. */
export class FileHarnessProviderSettingsStore {
  readonly path: string;
  readonly #onLockAcquisitionStarted?: () => void;

  constructor(options: FileHarnessProviderSettingsStoreOptions) {
    this.path = resolve(options.path);
    this.#onLockAcquisitionStarted = options.onLockAcquisitionStarted;
  }

  async #ensurePrivateDirectory(): Promise<void> {
    const directory = dirname(this.path);
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await Deno.lstat(directory);
    if (info.isSymlink || !info.isDirectory) {
      throw new Error("provider settings directory must not be a symlink");
    }
    if (
      Deno.build.os !== "windows" && info.mode !== null &&
      (info.mode & 0o077) !== 0
    ) {
      throw new Error(
        "provider settings directory must have private permissions",
      );
    }
  }

  async #assertPrivateRegularFile(
    path: string,
    label: "provider settings" | "provider settings lock",
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
        "provider settings lock",
        false,
      );
      lockFile = await Deno.open(lockPath, { read: true, write: true });
    }
    let locked = false;
    let cleanupDetached = false;
    try {
      await this.#assertPrivateRegularFile(
        lockPath,
        "provider settings lock",
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

  async inspect(): Promise<HarnessProviderSettingsState> {
    try {
      const directory = dirname(this.path);
      const directoryInfo = await Deno.lstat(directory);
      if (directoryInfo.isSymlink || !directoryInfo.isDirectory) {
        return {
          state: "unreadable",
          detail: "provider settings directory must not be a symlink",
        };
      }
      if (
        Deno.build.os !== "windows" && directoryInfo.mode !== null &&
        (directoryInfo.mode & 0o077) !== 0
      ) {
        return {
          state: "unreadable",
          detail: "provider settings directory must have private permissions",
        };
      }
      await this.#assertPrivateRegularFile(this.path, "provider settings");
      return parseDocument(await Deno.readTextFile(this.path));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return { state: "missing" };
      return { state: "unreadable", detail: detailOf(error) };
    }
  }

  async #write(
    settings: HarnessProviderSettings,
    signal?: AbortSignal,
  ): Promise<void> {
    const temporaryPath = join(
      dirname(this.path),
      `.config-${crypto.randomUUID()}.tmp`,
    );
    let failure: unknown;
    try {
      await Deno.writeTextFile(
        temporaryPath,
        `${JSON.stringify(settings, null, 2)}\n`,
        { createNew: true, mode: 0o600 },
      );
      await Deno.chmod(temporaryPath, 0o600);
      signal?.throwIfAborted();
      await Deno.rename(temporaryPath, this.path);
    } catch (error) {
      failure = error;
    }
    try {
      await Deno.remove(temporaryPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) && failure === undefined) {
        throw error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  initialize(
    modelProvider: HarnessModelProviderId,
    signal?: AbortSignal,
  ): Promise<{ settings: HarnessProviderSettings; changed: boolean }> {
    return mutationQueue.run(
      this.path,
      () =>
        this.#withFileLock(async () => {
          const state = await this.inspect();
          if (state.state === "configured") {
            return { settings: state.settings, changed: false };
          }
          if (state.state !== "missing") throw stateError(state);
          const settings = {
            version: HARNESS_PROVIDER_SETTINGS_VERSION,
            modelProvider,
          } as const;
          await this.#write(settings, signal);
          return { settings, changed: true };
        }, signal),
      signal,
    );
  }

  set(
    modelProvider: HarnessModelProviderId,
    signal?: AbortSignal,
  ): Promise<{ settings: HarnessProviderSettings; changed: boolean }> {
    return mutationQueue.run(
      this.path,
      () =>
        this.#withFileLock(async () => {
          const state = await this.inspect();
          if (
            state.state !== "missing" && state.state !== "configured"
          ) {
            throw stateError(state);
          }
          const settings = {
            version: HARNESS_PROVIDER_SETTINGS_VERSION,
            modelProvider,
          } as const;
          const changed = state.state === "missing" ||
            state.settings.modelProvider !== modelProvider;
          if (changed) await this.#write(settings, signal);
          return { settings, changed };
        }, signal),
      signal,
    );
  }
}

const stateError = (
  state: Exclude<
    HarnessProviderSettingsState,
    { state: "missing" | "configured" }
  >,
): HarnessControlError =>
  new HarnessControlError(
    "provider-configuration-required",
    state.state === "unsupported-version"
      ? "Provider settings use an unsupported version"
      : state.state === "unreadable"
      ? "Provider settings are unreadable"
      : "Provider settings are invalid",
  );

/**
 * Resolves the provider a run bills against, from an explicit request, the
 * environment, then the persistent preference. Neither provider is a default:
 * a harness that configured none resolves to none, so a run is refused rather
 * than routed to a billing route nobody named.
 */
export const resolveHarnessModelProviderPreference = async (options: {
  store: Pick<FileHarnessProviderSettingsStore, "inspect">;
  explicit?: HarnessModelProviderId;
  environment?: HarnessModelProviderId;
}): Promise<HarnessProviderResolution> => {
  if (options.explicit !== undefined) {
    return { provider: options.explicit, source: "explicit" };
  }
  if (options.environment !== undefined) {
    return { provider: options.environment, source: "environment" };
  }
  const state = await options.store.inspect();
  if (state.state === "configured") {
    return { provider: state.settings.modelProvider, source: "persistent" };
  }
  if (state.state === "missing") {
    throw new HarnessControlError(
      "provider-configuration-required",
      "No model provider is selected; choose one with --model-provider, " +
        "CF_HARNESS_MODEL_PROVIDER, or `config set`",
    );
  }
  throw stateError(state);
};

/** Returns the provider settings path for one canonical harness home. */
export const defaultHarnessProviderSettingsPath = (
  harnessHome: string,
): string => join(resolve(harnessHome), "config.json");
