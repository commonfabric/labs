import * as Path from "@std/path";

/**
 * An absolute, symlink-resolved form of `path` — even when it does not exist
 * yet.
 *
 * Both properties are load-bearing for the clone safety rails. A relative path
 * can never overlap an absolute live-store directory, so returning one verbatim
 * silently disarms `assertSafeTarget` — the clone lands inside the store the
 * rail was meant to protect, under a banner claiming it did not. And on macOS
 * `/tmp` is a symlink to `/private/tmp`, so two spellings of one directory must
 * canonicalize together or the comparison misses.
 *
 * `realPath` needs the path to exist, so for a target we are about to create we
 * resolve the nearest existing ancestor and re-append the rest. A root can be
 * missing too — a Windows drive letter with no drive behind it — and then
 * nothing above it exists to resolve, so the absolute path is returned as it
 * stands.
 */
export async function canonicalPath(
  path: string,
  realPath: (path: string) => Promise<string> = Deno.realPath,
): Promise<string> {
  const absolute = Path.resolve(path);
  try {
    return await realPath(absolute);
  } catch (error) {
    // Anything other than "not there yet" — a component that is a regular
    // file, a permission problem — is a real error the caller must see.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const parent = Path.dirname(absolute);
    if (parent === absolute) return absolute;
    return Path.join(
      await canonicalPath(parent, realPath),
      Path.basename(absolute),
    );
  }
}
