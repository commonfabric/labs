// Reader for the `COMPILED` build-metadata file that `tasks/build-binaries.ts`
// writes next to a binary's entry package and includes via `deno compile
// --include`. The values travel with the artifact and identify the commit it
// was built from.

import { isObjectOrArray } from "./types.ts";

/** Build metadata for a compiled binary. */
export interface BuildInfo {
  /** Commit the binary was built from, or `null` if not recorded. */
  commitSha: string | null;

  /** Time the binary was built, or `null` if not recorded. */
  builtAt: string | null;
}

/**
 * Returns `s` with surrounding whitespace removed, or `null` if what remains
 * is empty. This is how an absent, blank, or `undefined` field in the metadata
 * file becomes a single `null`.
 */
export function normalize(s: string | null | undefined): string | null {
  const trimmed = s?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Reads the build metadata file at `path`. Every failure mode -- an
 * unreadable file, an empty one, malformed JSON, or JSON that is not an
 * object -- yields a `BuildInfo` with both fields `null`, on the principle
 * that missing provenance must not stop a binary from starting.
 */
export function readBuildInfoFrom(path: URL | string): BuildInfo {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(path);
  } catch {
    return { commitSha: null, builtAt: null };
  }
  if (!raw.trim()) return { commitSha: null, builtAt: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { commitSha: null, builtAt: null };
  }
  if (!isObjectOrArray(parsed)) {
    return { commitSha: null, builtAt: null };
  }
  const obj = parsed as Partial<BuildInfo>;
  return {
    commitSha: normalize(obj.commitSha),
    builtAt: normalize(obj.builtAt),
  };
}
