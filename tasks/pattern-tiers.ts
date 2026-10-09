/**
 * Which pattern sources must carry a tier marker, and what that marker says.
 *
 * `packages/patterns/index.md` sorts this package into tiers by how much
 * authority an example carries. Two of those tiers mean "do not copy": legacy
 * (superseded) and fixture (scaffolding that pins a bug). An index states that
 * where a reader has to go looking for it, and a reader who opened the file
 * from a directory listing or a grep hit never does. So each file in those two
 * tiers opens with a marker saying which one it is.
 *
 * The tables below are what `check-pattern-tiers.ts` holds the markers to. A
 * whole directory takes a tier through `TIER_DIRECTORIES`; a loose file takes
 * one through `TIER_FILES`. Membership and marker are checked in both
 * directions, so a file listed here without a marker fails, and a marker on a
 * file not listed here fails too.
 *
 * The other three tiers — primitive, exemplar, demo — carry no marker. Their
 * instruction is to copy, or to copy the capability call and not the style,
 * which is what a reader already assumes, so a marker on the several hundred
 * remaining pattern sources would buy nothing. `check-pattern-tiers` reports
 * both counts on a passing run.
 */

import { isPatternSource, patternKey, PATTERNS_DIR } from "./pattern-files.ts";

/** The tiers whose files carry a marker. */
export type MarkedTier = "legacy" | "fixture";

/**
 * The exact text that opens a file of each marked tier, as the first two lines
 * of the file. Fixed text rather than a template: the check compares literally,
 * which is what stops the wording drifting file by file until it says nothing.
 */
export const TIER_MARKERS: Readonly<Record<MarkedTier, string>> = {
  legacy:
    "// PATTERN TIER: legacy — superseded or non-idiomatic; kept for what\n" +
    "// depends on it. Do not copy from this file. Tiers: packages/patterns/index.md",
  fixture:
    "// PATTERN TIER: fixture — scaffolding that pins a bug or drives the\n" +
    "// runtime. Do not copy from this file. Tiers: packages/patterns/index.md",
};

/**
 * Directories, relative to the patterns root, every pattern source under which
 * takes the given tier. A trailing slash is required so that a prefix match
 * cannot spill into a sibling whose name merely starts the same way.
 */
export const TIER_DIRECTORIES: Readonly<Record<string, MarkedTier>> = {
  "collaborative-note/": "legacy",
  "factory-outputs/": "legacy",
  "gideon-tests/": "fixture",
  "loom-overlay-fixture/": "fixture",
  "map-captured-object-spread/": "fixture",
  "plain-array-callback-locals/": "fixture",
  "scope-bug-computed-vnode-blank/": "fixture",
  "scope-bug-ct1597-forward/": "fixture",
  "scope-bug-ct1597-reduce/": "fixture",
  "test/": "fixture",
};

/** Individual pattern sources, relative to the patterns root, and their tier. */
export const TIER_FILES: Readonly<Record<string, MarkedTier>> = {
  "cell-link.tsx": "fixture",
  "nested-map-ifelse-test.tsx": "fixture",
  "render-test.tsx": "fixture",
  "self-reference-test.tsx": "fixture",
  "vehicles.ts": "legacy",
};

/**
 * Files a table would tier that take no marker anyway, each with the reason.
 *
 * This is an escape hatch, and an escape hatch nobody can review is a hole. So
 * an entry carries its reason in the value, the way `check-no-waitfor.ts`'s
 * allowlist does, and `check-pattern-tiers.ts` rejects an entry naming a file
 * no table would have tiered — an exemption that exempts nothing is either a
 * typo or a file that moved. What the check cannot decide is whether a reason
 * is a good one; that is what review is for, and why the reason is here rather
 * than implied.
 */
export const UNTIERED_FILES: Readonly<Record<string, string>> = {
  "test/vnode-helpers.ts":
    "The shared rendered-tree helper that pattern tests are meant to call. " +
    "Marking it 'do not copy' would say the opposite of what it is for.",
};

/**
 * The tier the tables give a pattern source, ignoring the exemptions.
 *
 * Kept separate from `tierOf` so the exemption list can be checked against the
 * tables. Folding the two together makes every exemption look untiered, which
 * leaves nothing to test an exemption against.
 */
export function tableTierOf(key: string): MarkedTier | undefined {
  const exact = TIER_FILES[key];
  if (exact !== undefined) return exact;
  for (const [prefix, tier] of Object.entries(TIER_DIRECTORIES)) {
    if (key.startsWith(prefix)) return tier;
  }
  return undefined;
}

/** The marked tier a pattern source belongs to, or undefined for the rest. */
export function tierOf(key: string): MarkedTier | undefined {
  if (key in UNTIERED_FILES) return undefined;
  return tableTierOf(key);
}

/** The marked tier a file's own text declares, or undefined if it declares none. */
export function declaredTier(source: string): MarkedTier | undefined {
  for (const [tier, marker] of Object.entries(TIER_MARKERS)) {
    if (source.startsWith(`${marker}\n`)) return tier as MarkedTier;
  }
  return undefined;
}

/** Whether a file opens with something claiming to be a marker at all. */
export function hasMarkerLine(source: string): boolean {
  return source.startsWith("// PATTERN TIER:");
}

/** A file's text with `tier`'s marker at the top, replacing any it already has. */
export function withMarker(source: string, tier: MarkedTier): string {
  return `${TIER_MARKERS[tier]}\n${stripMarker(source)}`;
}

/**
 * A file's text with a tier marker removed from the top.
 *
 * Only a marker matching `TIER_MARKERS` exactly is removed, by its own line
 * count. Text that opens `// PATTERN TIER:` and matches nothing is left where
 * it is: guessing how far a mangled marker runs is how a rewrite eats the
 * comment underneath it, and the check reports the mismatch either way.
 */
export function stripMarker(source: string): string {
  for (const marker of Object.values(TIER_MARKERS)) {
    if (!source.startsWith(`${marker}\n`)) continue;
    return source.slice(marker.length + 1);
  }
  return source;
}

/** Every pattern source under `dir`, paired with its key and expected tier. */
export async function collectTierTargets(
  dir: string = PATTERNS_DIR,
): Promise<{ path: string; key: string; tier: MarkedTier | undefined }[]> {
  const targets: { path: string; key: string; tier: MarkedTier | undefined }[] =
    [];

  async function walk(current: string) {
    for await (const entry of Deno.readDir(current)) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      if (!entry.isFile) continue;
      if (!isPatternSource(path, dir)) continue;
      const key = patternKey(path, dir);
      targets.push({ path, key, tier: tierOf(key) });
    }
  }

  await walk(dir);
  return targets.sort((a, b) => a.key.localeCompare(b.key));
}
