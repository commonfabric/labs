/** A file a directory listing named, resolved to its real path and its info. */
export interface ListedFile {
  /** The path as the listing named it. */
  path: string;
  real: string;
  stat: Deno.FileInfo;
}

/**
 * Resolves each of the files `paths` names, in order, leaving out a file that
 * can no longer be resolved: one removed since it was listed, or one that
 * cannot be read.
 */
export function* resolveListedFiles(
  paths: Iterable<string>,
): Generator<ListedFile> {
  for (const path of paths) {
    let resolved: ListedFile;
    try {
      const real = Deno.realPathSync(path);
      resolved = { path, real, stat: Deno.statSync(real) };
    } catch {
      continue;
    }
    yield resolved;
  }
}
