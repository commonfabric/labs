// "This server is serving a rehearsal clone, not production."
//
// `cf space clone` (see docs/plans/space-clone-rehearsal.md) writes a
// `.cf-clone` marker into the clone directory. A clone deliberately keeps the
// SOURCE space's DID — re-keying would break stored CFC `Space(...)` labels and
// orphan the ACL doc — so two stores can legitimately claim one identity, and
// once the clone is being served nothing distinguishes it from production
// except a port number.
//
// The filesystem rails in `cf space clone` stop a clone being WRITTEN into a
// live store. This is the other half: it makes a clone being SERVED visible in
// the log an operator is already watching. The July 2026 rehearsal was driven
// mostly through agents, and its operator could only say "I didn't notice any
// trouble, but there could have been some I missed" — this is what turns that
// into something noticeable.

import * as Path from "@std/path";

/** Written by `cf space clone`; its body is the human-readable provenance. */
const MARKER = ".cf-clone";

/**
 * The store root a marker would live in: the directory `MEMORY_DIR` names, or
 * the containing directory in single-file (`DB_PATH`) mode.
 *
 * Returns null when the configuration cannot be interpreted as a local
 * directory — a malformed URL, or a non-`file:` store. Absence of a banner
 * never blocks startup.
 */
export function storeRootPath(
  config: { memoryDir?: string; dbPath?: string },
): string | null {
  if (config.dbPath) return Path.dirname(config.dbPath);
  const dir = config.memoryDir;
  if (!dir) return null;
  if (!dir.startsWith("file://")) {
    return Path.isAbsolute(dir) ? dir : null;
  }
  try {
    return Path.fromFileUrl(dir);
  } catch {
    return null;
  }
}

/**
 * The startup banner for a served clone, or null when the store is not one.
 *
 * Deliberately silent on every read failure: a banner is diagnostic, and
 * refusing to start a server because a marker file could not be read would
 * trade a cosmetic problem for an outage.
 */
export function cloneBanner(
  config: { memoryDir?: string; dbPath?: string },
): string | null {
  const root = storeRootPath(config);
  if (root === null) return null;

  let marker: string;
  try {
    marker = Deno.readTextFileSync(Path.join(root, MARKER));
  } catch {
    return null;
  }

  const rule = "═".repeat(72);
  const provenance = marker
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `  ${line}`);

  return [
    rule,
    "  ⚠️  SERVING A REHEARSAL CLONE — THIS IS NOT PRODUCTION",
    "",
    ...provenance,
    rule,
  ].join("\n");
}

/** Print the banner when the configured store is a clone. */
export function announceCloneIfServed(
  config: { memoryDir?: string; dbPath?: string },
  log: (message: string) => void = console.log,
): void {
  const banner = cloneBanner(config);
  if (banner !== null) log(banner);
}
