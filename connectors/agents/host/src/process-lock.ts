import { dirname, join, resolve } from "@std/path";
import { agentTargetKey } from "./target-state.ts";

const heldPaths = new Set<string>();

function validatePrivateInfo(
  info: Deno.FileInfo,
  path: string,
  kind: "directory" | "file",
): void {
  if (info.isSymlink) {
    throw new Error(`process lock ${kind} cannot be a symbolic link: ${path}`);
  }
  if (kind === "directory" ? !info.isDirectory : !info.isFile) {
    throw new Error(`process lock ${kind} is not a ${kind}: ${path}`);
  }
  if (Deno.build.os === "windows") return;
  if (info.uid !== null && info.uid !== Deno.uid()) {
    throw new Error(`process lock ${kind} has a different owner: ${path}`);
  }
  if (info.mode !== null && (info.mode & 0o077) !== 0) {
    throw new Error(
      `process lock ${kind} permits access by other users: ${path}`,
    );
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  validatePrivateInfo(await Deno.lstat(path), path, "directory");
}

async function openPrivateLockFile(path: string): Promise<Deno.FsFile> {
  let prior: Deno.FileInfo;
  try {
    prior = await Deno.lstat(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return await Deno.open(path, {
      createNew: true,
      read: true,
      write: true,
      mode: 0o600,
    });
  }
  validatePrivateInfo(prior, path, "file");
  const file = await Deno.open(path, { read: true, write: true });
  try {
    const actual = await file.stat();
    validatePrivateInfo(actual, path, "file");
    if (
      Deno.build.os !== "windows" && prior.dev !== null &&
      actual.dev !== null && prior.ino !== null && actual.ino !== null &&
      (prior.dev !== actual.dev || prior.ino !== actual.ino)
    ) {
      throw new Error(`process lock file changed while opening: ${path}`);
    }
    return file;
  } catch (error) {
    file.close();
    throw error;
  }
}

export type ProcessLockEnvReader = (key: string) => string | undefined;

export function defaultAgentsHostLockDirectory(
  readEnv: ProcessLockEnvReader = (key) => Deno.env.get(key),
): string {
  const configured = readEnv("CF_AGENTS_HOST_LOCK_DIR");
  if (configured?.trim()) return resolve(configured.trim());

  const runtimeDirectory = readEnv("XDG_RUNTIME_DIR");
  if (runtimeDirectory?.trim()) {
    return join(
      resolve(runtimeDirectory.trim()),
      "commonfabric",
      "agents-host",
    );
  }

  if (Deno.build.os === "windows") {
    const windowsBase = readEnv("LOCALAPPDATA") ?? readEnv("TEMP") ??
      readEnv("TMP");
    if (!windowsBase?.trim()) {
      throw new Error(
        "CF_AGENTS_HOST_LOCK_DIR is required when no Windows runtime directory is available",
      );
    }
    return join(resolve(windowsBase.trim()), "CommonFabric", "agents-host");
  }

  const temporaryDirectory = readEnv("TMPDIR")?.trim() || "/tmp";
  return join(
    resolve(temporaryDirectory),
    `commonfabric-agents-host-${Deno.uid()}`,
  );
}

export async function defaultTargetProcessLockPath(
  apiUrl: string,
  spaceDid: string,
  ownerDid: string,
  lockDirectory = defaultAgentsHostLockDirectory(),
): Promise<string> {
  const key = await agentTargetKey(apiUrl, spaceDid, ownerDid);
  return join(resolve(lockDirectory), `target-${key}.lock`);
}

export class AgentsHostProcessLock {
  readonly #file: Deno.FsFile;
  readonly #path: string;
  #released = false;

  private constructor(file: Deno.FsFile, path: string) {
    this.#file = file;
    this.#path = path;
  }

  static async acquire(path: string): Promise<AgentsHostProcessLock> {
    const normalizedPath = resolve(path);
    if (heldPaths.has(normalizedPath)) {
      throw new Error(
        `another agent host holds the process lock: ${normalizedPath}`,
      );
    }
    heldPaths.add(normalizedPath);
    let file: Deno.FsFile | undefined;
    try {
      await ensurePrivateDirectory(dirname(normalizedPath));
      file = await openPrivateLockFile(normalizedPath);
      if (!(await file.tryLock(true))) {
        throw new Error(
          `another agent host holds the process lock: ${normalizedPath}`,
        );
      }
      await file.truncate(0);
      await file.write(new TextEncoder().encode(`${Deno.pid}\n`));
      await file.syncData();
      return new AgentsHostProcessLock(file, normalizedPath);
    } catch (error) {
      file?.close();
      heldPaths.delete(normalizedPath);
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    try {
      await this.#file.unlock();
    } finally {
      this.#file.close();
      heldPaths.delete(this.#path);
    }
  }
}
