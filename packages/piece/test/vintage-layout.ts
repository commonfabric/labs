/**
 * Where a vintage fixture's SPACES live on disk.
 *
 * A space is one SQLite file, so a capture that instantiates a pattern in
 * another space (`Factory.inSpace(...)` — how a profile is created) writes a
 * SECOND file, and a fixture that copied only the first would record roots
 * whose state it does not hold. The companion directory sits beside the primary
 * file, holds one raw `.sqlite` per other space, and travels with it in git —
 * raw, so delta compression still works (see
 * `tasks/pattern-vintage-layout.ts`).
 *
 * Its own module, and a deliberately empty one: `state-continuity-harness.ts`
 * needs this rule to write and restore a fixture, and
 * `tasks/pattern-vintage-layout.ts` needs it to tell a companion from a
 * fixture — and that second module is pure path parsing whose unit test should
 * not have to load the runner, the memory server and the identity stack to
 * check a string. Importing the harness for a constant took its dependency
 * graph from 11 modules to 765.
 */

/** Suffix of the directory carrying a fixture's NON-primary space stores. */
export const VINTAGE_SPACES_SUFFIX = ".sqlite.spaces";

/**
 * The companion directory for the fixture at `fixturePath` (`…/<name>.sqlite`).
 *
 * The suffix keeps the primary file's `.sqlite` in view rather than replacing
 * it — `<stamp>-<identity>.sqlite` → `<stamp>-<identity>.sqlite.spaces/` — so
 * the pair reads as one fixture, and so `parseVintagePath` can decline anything
 * inside one on the directory NAME alone. A bare `.spaces` would be a weaker
 * discriminator over a tree that is not exclusively fixtures.
 */
export function vintageCompanionDir(fixturePath: string): string {
  return `${fixturePath.replace(/\.sqlite$/, "")}${VINTAGE_SPACES_SUFFIX}`;
}

/**
 * A companion's filename encodes its space id. Percent-encoding is what
 * `encodeStoreSubject` uses for a space's own store filename too, so this is
 * the same escape rather than a second invention — but NOT the same realized
 * name: in directory mode `resolveSpaceStoreUrl` resolves the encoded filename
 * as a URL segment, so a live store's file is the LITERAL did while a companion
 * stays encoded. The pair here is self-consistent, which is all that matters.
 */
export function companionFileName(space: string): string {
  return `${encodeURIComponent(space)}.sqlite`;
}

/**
 * The space a companion filename names, or `undefined` if it cannot be one this
 * repo wrote.
 *
 * Guarded rather than a bare `decodeURIComponent`, which throws `URIError` on a
 * malformed escape (`%zz`) — a stray file in the companion directory would then
 * take down every fixture in the run, not just its own. Mirrors
 * `spaceFromStoreFilename`, the same inverse for the store layout.
 */
export function companionSpace(fileName: string): string | undefined {
  if (!fileName.endsWith(".sqlite")) return undefined;
  try {
    return decodeURIComponent(fileName.slice(0, -".sqlite".length));
  } catch {
    return undefined;
  }
}
