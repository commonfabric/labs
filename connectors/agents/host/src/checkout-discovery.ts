import { isAbsolute, join, resolve } from "@std/path";

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await Deno.lstat(path);
    return info.isFile && !info.isSymlink;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function hasGitMarker(path: string): Promise<boolean> {
  const marker = join(path, ".git");
  try {
    const info = await Deno.lstat(marker);
    if (info.isSymlink) return false;
    if (info.isDirectory) return await isRegularFile(join(marker, "HEAD"));
    if (!info.isFile) return false;

    const match = (await Deno.readTextFile(marker)).match(
      /^gitdir:\s*(.+?)\s*$/,
    );
    if (!match) return false;
    const gitDirectory = isAbsolute(match[1])
      ? resolve(match[1])
      : resolve(path, match[1]);
    const gitDirectoryInfo = await Deno.lstat(gitDirectory);
    return gitDirectoryInfo.isDirectory && !gitDirectoryInfo.isSymlink &&
      await isRegularFile(join(gitDirectory, "HEAD"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export type ValidateGitCheckout = (
  directory: string,
  signal?: AbortSignal,
) => Promise<boolean>;

/** Find every Git checkout below explicitly configured search roots. */
export async function discoverGitCheckoutDirectories(
  roots: string[],
  signal: AbortSignal | undefined,
  validateCheckout: ValidateGitCheckout,
): Promise<string[]> {
  const checkouts = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    if (
      await hasGitMarker(directory) &&
      await validateCheckout(directory, signal)
    ) {
      checkouts.add(directory);
      return;
    }
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        entry.name === ".git" || !entry.isDirectory || entry.isSymlink
      ) continue;
      await visit(join(directory, entry.name));
    }
  };
  for (const configured of roots) {
    const root = resolve(configured);
    const info = await Deno.lstat(root);
    if (info.isSymlink || !info.isDirectory) {
      throw new Error(`checkout search root is not a directory: ${root}`);
    }
    await visit(root);
  }
  return [...checkouts].sort();
}
