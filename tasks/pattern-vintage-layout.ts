/**
 * Stage 3 of the pattern-update regime: where a captured vintage LIVES.
 *
 * Tier 1 (`pattern-compat`) records a contract per pattern and proves the next
 * one is compatible with it. Tier 2 records a real prior STATE per pattern and
 * proves the next version can still read it. This module owns the fixture
 * layout the second one needs, and nothing else — capture and replay live in
 * `packages/piece/test/state-continuity-harness.ts`, the task shell in
 * `pattern-vintage.ts`.
 *
 * Layout:
 *
 *     packages/piece/test/vintages/<test key>/pinned/<iso>-<identity>.sqlite
 *     packages/piece/test/vintages/<test key>/pinned/<iso>-<identity>.sqlite.spaces/<did>.sqlite
 *
 * `<test key>` is the repo path under `packages/patterns/` of the TEST that
 * produced the fixture, so a fixture sits next to nothing and is found by path
 * alone. Keyed by test rather than by pattern because a test need not be named
 * after what it drives — `topics/main.tsx` is tested by `topics/topics.test.tsx`
 * — and one fixture routinely covers several patterns.
 *
 * The `.sqlite.spaces/` directory carries the run's OTHER spaces — a capture
 * that instantiates a pattern via `Factory.inSpace(...)` writes a second store,
 * and a fixture that held only the first would record roots whose state it does
 * not have. It is part of the FIXTURE, not a fixture itself, so
 * `parseVintagePath` declines everything inside one. Its shape lives in
 * `packages/piece/test/vintage-layout.ts`, which the snapshot/restore side needs
 * too and which imports nothing itself.
 *
 * The tree is deliberately NOT under `packages/patterns/`, which is the
 * obvious home for it and the wrong one. `tasks/build-binaries.ts` passes that
 * whole directory to `deno compile --include`, which is recursive and takes
 * arbitrary non-source files — measured, and neither `deno.json`'s `exclude`
 * nor `.denoignore` filters it — so every fixture would be baked into the
 * shipped toolshed binary, and stage 4 accumulates fixtures. The same
 * directory is what `PatternsServer` serves by path, so they would also be
 * fetchable from any deployment. It lives beside the harness that reads it
 * instead.
 *
 * `<identity>` is PROVENANCE, not an address: it records which pattern version
 * wrote the state. Nothing looks a fixture up by it — the replay enumerates the
 * directory and replays everything it finds. That is deliberate. A gate that
 * selected fixtures by identity would silently cover nothing the moment the
 * naming drifted; enumeration cannot.
 *
 * `<iso>` is a capture timestamp, so retention can drop the oldest AUTO
 * captures without parsing anything (stage 4). Pinned vintages are never
 * dropped, which is why they live in their own directory rather than behind a
 * flag: a pruner is invoked by people doing something else, and a deep vintage
 * cannot be recaptured — the pattern that wrote it no longer exists in runnable
 * form.
 *
 * Fixtures are stored RAW, not gzipped, which is the opposite of what the
 * obvious reasoning suggests. A store is mostly slack (home.tsx is 3.5 MiB
 * across 99 revisions) and gzips 15x, so pre-compressing looks free — git
 * zlib-compresses blobs anyway.
 *
 * Measured, it is not free, because it defeats DELTA compression. Two captures
 * of home.tsx, packed into a fresh repo (`git init`, add, commit, `git gc`,
 * `git count-objects -vH`):
 *
 *     raw .sqlite     one 232.50 KiB   two 232.86 KiB   (+0.36 KiB)
 *     gzipped .gz     one 226.13 KiB   two 450.27 KiB   (+224 KiB)
 *
 * The second raw vintage is essentially free because git deltas it against the
 * first; two gzip streams delta not at all. Accumulating vintages is precisely
 * what stage 4 does, so the compounding term dominates the one-off.
 *
 * The cost is working-tree disk: 3.5 MiB a fixture rather than 226 KiB. That
 * is transient and local, where git history is permanent and shared by
 * everyone who clones.
 *
 * Kept apart from `pattern-vintage-lib.ts`, which holds the capture,
 * comparison and reporting around a fixture and reaches the runner to do it.
 * This half is path parsing over a directory walk. It reaches two leaves and
 * nothing else — the companion-directory rule, and the code-point string
 * comparison in `@commonfabric/utils/utf8` — so the test topology in
 * `test-topology/gates.ts` can read the fixture names without loading the
 * runner. Every lane loads that topology before it runs anything.
 */

import { utf8Compare } from "@commonfabric/utils/utf8";

import { VINTAGE_SPACES_SUFFIX } from "../packages/piece/test/vintage-layout.ts";

/** Root of the committed fixture tree. See the note above on why it is here. */
export const VINTAGES_DIR = "packages/piece/test/vintages";

/** Vintages that are never pruned and are the gate's real coverage. */
export const PINNED = "pinned";

/** Vintages captured automatically; retention drops the oldest (stage 4). */
export const AUTO = "auto";

export const VINTAGE_SUFFIX = ".sqlite";

export interface VintageRef {
  /**
   * TEST path relative to `packages/patterns/`, e.g. `system/home.test.tsx`.
   * Named for the test, not the pattern: the fixture covers whatever that
   * test instantiates, which is routinely several patterns.
   */
  testKey: string;

  /** `pinned` or `auto`. */
  tier: string;

  /** Capture timestamp, ISO-8601 with `:` replaced (filenames). */
  stamp: string;

  /** Identity of the pattern version that WROTE this state. */
  identity: string;

  /** Repo-relative path to the fixture file. */
  path: string;
}

/** The directory holding one TEST's fixtures of a given tier. */
export function vintageDir(testKey: string, tier: string): string {
  return `${VINTAGES_DIR}/${testKey}/${tier}`;
}

/**
 * `:` is legal in a POSIX filename and illegal on Windows, and an ISO
 * timestamp is full of them. Substituting keeps the name sortable — which is
 * the only property retention needs — without a platform caveat.
 */
export function stampFor(date: Date): string {
  return date.toISOString().replaceAll(":", "-");
}

export function vintageFileName(stamp: string, identity: string): string {
  return `${stamp}-${identity}${VINTAGE_SUFFIX}`;
}

/**
 * `<stamp>-<identity>`, where the stamp is `stampFor`'s output (an ISO
 * timestamp with `:` substituted) and the identity is everything after it.
 * Both fields contain dashes, so the stamp's fixed shape is the only reliable
 * boundary between them.
 */
const NAME_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-(.+)$/;

/**
 * Parse a fixture path back into its parts, or `undefined` if it is not one.
 *
 * Returning `undefined` rather than throwing is what lets the enumerator walk
 * a directory that also holds a README or a stray file without the gate dying
 * on it.
 *
 * `root` is a parameter, not the constant, so the layout can be exercised
 * against a temp tree. Anchoring it to the repo path instead is not a
 * theoretical smell: Tier 1's `isPatternSource` did exactly that, which
 * silently disabled every exclusion the moment it was handed an absolute path,
 * and the tests could not have caught it because they could not run anywhere
 * else.
 */
export function parseVintagePath(
  path: string,
  root: string = VINTAGES_DIR,
): VintageRef | undefined {
  const prefix = `${root}/`;
  if (!path.startsWith(prefix) || !path.endsWith(VINTAGE_SUFFIX)) {
    return undefined;
  }
  const rest = path.slice(prefix.length);
  const cut = rest.lastIndexOf("/");
  if (cut === -1) return undefined;
  const fileName = rest.slice(cut + 1);
  const dir = rest.slice(0, cut);
  // A companion store is PART of the fixture beside it, not a fixture of its
  // own. Declining it by name is deliberate rather than incidental: its filename
  // is a space DID, which would not parse as `<stamp>-<identity>` today, but a
  // gate that enumerated one as a separate vintage would replay a space against
  // a pattern key it never belonged to — and the reason it does not would be
  // invisible.
  if (dir.split("/").some((part) => part.endsWith(VINTAGE_SPACES_SUFFIX))) {
    return undefined;
  }
  const tierCut = dir.lastIndexOf("/");
  if (tierCut === -1) return undefined;
  const tier = dir.slice(tierCut + 1);
  const testKey = dir.slice(0, tierCut);
  if (testKey.length === 0 || tier.length === 0) return undefined;

  const base = fileName.slice(0, -VINTAGE_SUFFIX.length);
  // Anchor on the STAMP, which has a fixed shape, and take everything after it
  // as the identity. Neither field can be found by splitting on a dash: the
  // stamp contains them (`2026-07-29T16-40-22.484Z`) and so does a base64url
  // identity (`xaLUAd...vaXYy-P8PAkh...`). An earlier version cut at the LAST
  // dash and silently failed to recognize its own freshly-written fixture for
  // home.tsx — whose identity happens to contain one — reporting the pattern
  // as uncovered while the file sat right there.
  //
  // Requiring the stamp to match also rejects a non-fixture that merely ends
  // in the suffix, so the gate says "that is not a fixture" instead of trying
  // to replay it. Retention sorts on this field too (stage 4).
  const parsed = NAME_PATTERN.exec(base);
  if (parsed === null) return undefined;
  const [, stamp, identity] = parsed;

  return { testKey, tier, stamp, identity, path };
}

/**
 * Every fixture under `root`, sorted by path so runs are reproducible.
 *
 * Sorted by code point rather than by `localeCompare`, whose ordering follows
 * the host's default locale: the replay walks this list in order and credits
 * the first fixture that records a pattern, so two hosts ordering it
 * differently would attribute an uncovered pattern to different fixtures.
 */
export async function collectVintages(
  root: string = VINTAGES_DIR,
): Promise<VintageRef[]> {
  const found: VintageRef[] = [];
  const walk = async (dir: string): Promise<void> => {
    try {
      // `Deno.readDir` returns a LAZY iterable: it does not touch the
      // filesystem until iteration, so a try/catch around the call alone
      // catches nothing and a missing tree escapes as ENOENT. The loop has to
      // be inside the try.
      for await (const entry of Deno.readDir(dir)) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory) {
          await walk(path);
          continue;
        }
        const ref = parseVintagePath(path, root);
        if (ref !== undefined) found.push(ref);
      }
    } catch (error) {
      // A missing tree is "no fixtures yet", not a failure — the gate reports
      // that as uncovered patterns, which is the actionable message.
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  };
  await walk(root);
  found.sort((left, right) => utf8Compare(left.path, right.path));
  return found;
}

/** The repository gate and task that replays the committed fixture tree. */
export const VINTAGE_GATE = "pattern-vintage";

/**
 * The identity the vintage gate records one fixture's replay under.
 *
 * The test topology claims these records and the gate writes them, and both
 * build the name here. A suite's claim over an identity is what puts it in a
 * published manifest, and an identity no suite claims is forgotten once
 * nothing records it any more.
 */
export function vintageRecordName(
  ref: Pick<VintageRef, "testKey" | "tier" | "stamp">,
): string {
  return `${VINTAGE_GATE} ${ref.testKey} ${ref.tier} ${ref.stamp}`;
}
