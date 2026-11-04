import { dirname, join, resolve } from "@std/path";
import { sha256 } from "@commonfabric/content-hash";
import { encodeGithubTargetIdentity } from "@commonfabric/github-connector/identity";

const heldPaths = new Set<string>();

function validatePrivateFile(info: Deno.FileInfo, path: string): void {
  if (info.isSymlink || !info.isFile) {
    throw new Error(`GitHub host process lock is not a regular file: ${path}`);
  }
  if (Deno.build.os === "windows") return;
  if (info.uid !== null && info.uid !== Deno.uid()) {
    throw new Error(`GitHub host process lock has a different owner: ${path}`);
  }
  if (info.mode !== null && (info.mode & 0o077) !== 0) {
    throw new Error(
      `GitHub host process lock is accessible by other users: ${path}`,
    );
  }
}

async function openLockFile(path: string): Promise<Deno.FsFile> {
  try {
    const info = await Deno.lstat(path);
    validatePrivateFile(info, path);
    return await Deno.open(path, { read: true, write: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return await Deno.open(path, {
      createNew: true,
      read: true,
      write: true,
      mode: 0o600,
    });
  }
}

/** Return the private default directory for GitHub host process locks. */
export function defaultGithubHostLockDirectory(
  readEnv: (key: string) => string | undefined = (key) => Deno.env.get(key),
  os: typeof Deno.build.os = Deno.build.os,
  uid: () => number | null = () => Deno.uid(),
): string {
  const configured = readEnv("CF_GITHUB_HOST_LOCK_DIR")?.trim();
  if (configured) return resolve(configured);
  const runtimeDirectory = readEnv("XDG_RUNTIME_DIR")?.trim();
  if (runtimeDirectory) {
    return join(resolve(runtimeDirectory), "commonfabric", "github-host");
  }
  if (os === "windows") {
    const windowsBase = readEnv("LOCALAPPDATA")?.trim() ||
      readEnv("TEMP")?.trim() || readEnv("TMP")?.trim();
    if (!windowsBase) {
      throw new Error(
        "CF_GITHUB_HOST_LOCK_DIR is required when no Windows runtime directory is available",
      );
    }
    return join(resolve(windowsBase), "CommonFabric", "github-host");
  }
  const temporaryDirectory = readEnv("TMPDIR")?.trim() || "/tmp";
  const userId = uid();
  if (userId === null) {
    throw new Error("CF_GITHUB_HOST_LOCK_DIR is required without a user ID");
  }
  return join(
    resolve(temporaryDirectory),
    `commonfabric-github-host-${userId}`,
  );
}

/** Return a deterministic process-lock path for one Fabric destination. */
export function githubTargetProcessLockPath(
  apiUrl: string,
  spaceDid: string,
  source: string,
  directory = defaultGithubHostLockDirectory(),
): string {
  const digest = sha256(encodeGithubTargetIdentity(apiUrl, spaceDid, source));
  const key = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return join(resolve(directory), `target-${key}.lock`);
}

/** An exclusive process lock for one GitHub connector destination. */
export class GithubHostProcessLock {
  readonly #file: Deno.FsFile;
  readonly #path: string;
  #released = false;

  private constructor(file: Deno.FsFile, path: string) {
    this.#file = file;
    this.#path = path;
  }

  /** Acquire an exclusive lock or reject when another host owns it. */
  static async acquire(path: string): Promise<GithubHostProcessLock> {
    const normalizedPath = resolve(path);
    if (heldPaths.has(normalizedPath)) {
      throw new Error(`another GitHub host holds the process lock: ${path}`);
    }
    heldPaths.add(normalizedPath);
    let file: Deno.FsFile | undefined;
    try {
      await Deno.mkdir(dirname(normalizedPath), {
        recursive: true,
        mode: 0o700,
      });
      file = await openLockFile(normalizedPath);
      validatePrivateFile(await file.stat(), normalizedPath);
      if (!(await file.tryLock(true))) {
        throw new Error(
          `another GitHub host holds the process lock: ${normalizedPath}`,
        );
      }
      await file.truncate(0);
      await file.write(new TextEncoder().encode(`${Deno.pid}\n`));
      await file.syncData();
      return new GithubHostProcessLock(file, normalizedPath);
    } catch (error) {
      file?.close();
      heldPaths.delete(normalizedPath);
      throw error;
    }
  }

  /** Release the lock and close its file descriptor. */
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
