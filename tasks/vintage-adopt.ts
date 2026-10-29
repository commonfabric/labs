/**
 * Adopt an externally captured space snapshot as a pinned vintage fixture.
 *
 * The capture side of this runs OUT of process — in a git worktree at an old
 * revision, under that revision's own toolchain — precisely because the store
 * it produces holds source closures the current toolchain may no longer
 * compile (`docs/specs/pattern-update-testing.md`, "Adopting an externally
 * captured fixture"). This tool is the current-tree half: it opens the
 * snapshot (running the memory migration chain, as reopening any old space
 * does), re-derives the recorded root from its capture cause, verifies the
 * root's stored `patternIdentity` matches what the capture reported, writes
 * the in-store manifest and restore-control doc, and emits a normal pinned
 * fixture.
 *
 * The root is derived from CAUSE rather than taken as an id argument: entity
 * ids are cause-derived and stable across revisions, so a derivation that
 * lands on a cell with the wrong (or no) stored identity fails the adopt
 * loudly instead of minting a fixture whose manifest addresses nothing.
 *
 * An adopt the tool accepts must be a replay the gate accepts — the same
 * invariant `captureVintage` holds. So before writing anything it applies the
 * replay's own predicates to the entry it is about to record: the main path
 * must map to a pattern key (`patternKeyFromMain`), the entry must be an
 * upgrade target (`isUpgradeTarget`), and today's source for that key must
 * resolve and compile. Without these, a mistyped argument mints a pinned
 * fixture whose every replay fails — the dead end the capture guard exists to
 * prevent, one tool over.
 */

import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { getPatternIdentityRef } from "@commonfabric/runner";
import type { Cell } from "@commonfabric/runner";

import {
  openFileBackedRuntime,
  readVintageManifest,
  type VintageManifestEntry,
  vintageRoot,
  writeVintageManifest,
} from "../runtime/piece/test/state-continuity-harness.ts";
import {
  patternKeyFromMain,
  PINNED,
  stampFor,
  vintageFileName,
  VINTAGES_DIR,
} from "./pattern-vintage-lib.ts";
import { isUpgradeTarget } from "./pattern-vintage-run.ts";

/** Where an adopt resolves keys and writes fixtures. Same shape as the gate's
 * roots, so a test can point everything at a temp tree. */
export interface AdoptRoots {
  repoRoot: string;
  patternsRoot: string;
  vintagesRoot: string;
  signer: Identity;
}

export interface AdoptOptions {
  snapshotPath: string;

  /** The pattern identity the capture reported for the root. */
  expectedIdentity: string;

  /** Fixture directory key, e.g. `system/home/home.test.tsx`. */
  testKey: string;

  /** Repo path replay resolves today's source from,
   * e.g. `/patterns/system/home/home.tsx`. */
  main: string;

  /** Capture cause of the root cell. Defaults to `"home-pattern"`, the cause
   * `ensureDefaultPattern` mints the home root with. */
  cause?: string;

  /**
   * Sub-pattern roots to record alongside the entry root, addressed by the
   * entity id the capture minted them at (a child's id is position-derived,
   * not cause-derived, so it cannot be re-derived here — enumerate the
   * snapshot's `patternIdentity`-carrying cells to find them). Without these
   * the manifest holds only the root, and the gate's presence and
   * before/after state controls never touch the children — which for a
   * pattern like home is exactly the state whose survival the fixture exists
   * to check. Each child's identity and symbol come from its own stored
   * `patternIdentity`; each `main` is validated like the root's.
   */
  children?: readonly { cellId: string; main: string }[];

  roots: AdoptRoots;

  /** Capture stamp; injectable so a test is deterministic. */
  now?: Date;

  log?: (line: string) => void;
}

/** The prefix `main` must carry for `patternKeyFromMain` to map it — the same
 * derivation the replay uses (`patternsPrefix` in `pattern-vintage-run.ts`). */
function patternsPrefix(roots: AdoptRoots): string {
  return `${roots.patternsRoot.slice(roots.repoRoot.length)}/`;
}

/** Map `main` to a pattern key, refusing anything the replay could not
 * identity-compare. Shared by the root and every child entry. */
function mappedRepoKey(main: string, roots: AdoptRoots): string {
  const key = patternKeyFromMain(main, patternsPrefix(roots));
  if (key === undefined) {
    throw new Error(
      `main "${main}" does not map to a pattern key under ` +
        `${patternsPrefix(roots)} — the replay could not resolve today's ` +
        `source for it`,
    );
  }
  // The repo-path branch of that mapping only. `patternKeyFromMain` also maps
  // `/api/patterns/...` routes, but the replay accounts a served route apart
  // from identity comparison — and an adopted fixture is defined as an
  // identity-compared repo-path target (`pattern-update-testing.md`), so a
  // route here is an input error, not an alternative.
  if (!main.startsWith(patternsPrefix(roots))) {
    throw new Error(
      `main "${main}" is a served route — an adopted fixture is an ` +
        `identity-compared repo-path target; record the repo path ` +
        `${patternsPrefix(roots)}${key} instead`,
    );
  }
  return key;
}

/**
 * Validate and adopt. Returns the path of the written fixture. Throws — with
 * nothing written — on any refusal.
 */
export async function adoptVintage(options: AdoptOptions): Promise<string> {
  const {
    snapshotPath,
    expectedIdentity,
    testKey,
    main,
    roots,
    now = new Date(),
    log = () => {},
  } = options;
  const cause = options.cause ?? "home-pattern";
  const children = options.children ?? [];

  // Static entry validation first: these need no runtime, and an entry the
  // replay cannot address must never reach the store-writing steps.
  const key = mappedRepoKey(main, roots);
  const childKeys = children.map((child) => mappedRepoKey(child.main, roots));
  // One manifest entry per cell. The replay's materialize/accounting loop
  // deliberately iterates every entry, so a duplicated cell would inflate
  // `targets`/`changed`/`updated` — and paired with two different mains it
  // would apply two programs to one root and credit both keys.
  const seenCellIds = new Set<string>();
  for (const child of children) {
    if (seenCellIds.has(child.cellId)) {
      throw new Error(`duplicate child cell id ${child.cellId}`);
    }
    seenCellIds.add(child.cellId);
  }
  const candidate: VintageManifestEntry = {
    identity: expectedIdentity,
    symbol: "default",
    main,
    cellId: "",
    space: "",
  };
  if (!isUpgradeTarget(candidate)) {
    throw new Error(
      `"${main}" (identity ${expectedIdentity}) is not an upgrade target — ` +
        `a test entry or keyless identity can never be materialized by the ` +
        `replay`,
    );
  }

  const dir = await Deno.makeTempDir({ prefix: "vintage-adopt-" });
  const vintage = await openFileBackedRuntime(roots.signer, dir, snapshotPath);
  try {
    log(`space: ${vintage.space}`);
    log(`restored spaces: ${vintage.restoredSpaces.join(", ")}`);

    const root = vintage.runtime.getCell(
      vintage.space as never,
      cause,
      undefined as never,
    ) as Cell<unknown>;
    await root.sync();
    const link = root.getAsNormalizedFullLink();
    log(`derived root id: ${link.id}`);

    const ref = getPatternIdentityRef(root);
    if (ref === undefined) {
      throw new Error(
        `root derived from cause "${cause}" carries no patternIdentity — ` +
          "wrong cause or empty store",
      );
    }
    if (ref.identity !== expectedIdentity) {
      throw new Error(
        `stored identity ${ref.identity} != expected ${expectedIdentity}`,
      );
    }
    if (seenCellIds.has(String(link.id))) {
      throw new Error(
        `the entry root ${link.id} is also listed as a child — one manifest ` +
          `entry per cell`,
      );
    }

    // Each child root, addressed by the id the capture minted. The stored
    // `patternIdentity` supplies its identity and symbol — a cell without one
    // is a wrong id or an entity that is not a pattern root, and refusing it
    // here beats a manifest entry the replay reports as missing forever.
    const childEntries: VintageManifestEntry[] = [];
    for (const child of children) {
      const cell = vintage.runtime.getCellFromEntityId(
        vintage.space as never,
        child.cellId as never,
        [],
        undefined as never,
      ) as Cell<unknown>;
      await cell.sync();
      const childRef = getPatternIdentityRef(cell);
      if (childRef === undefined) {
        throw new Error(
          `child ${child.cellId} carries no patternIdentity — wrong id, or ` +
            `not a pattern root`,
        );
      }
      const childEntry: VintageManifestEntry = {
        identity: childRef.identity,
        symbol: childRef.symbol,
        main: child.main,
        cellId: child.cellId,
        space: vintage.space,
      };
      if (!isUpgradeTarget(childEntry)) {
        throw new Error(
          `child "${child.main}" (identity ${childRef.identity}) is not an ` +
            `upgrade target`,
        );
      }
      childEntries.push(childEntry);
    }

    // Today's source must resolve and compile for EVERY recorded main — the
    // replay's first two moves per target, run here so a fixture cannot be
    // pinned pointing at a source that is already missing or broken. The
    // compiled entry ref is kept per key for the symbol check below.
    const refByKey = new Map<string, { identity: string; symbol: string }>();
    for (const entryKey of new Set([key, ...childKeys])) {
      const source = `${roots.patternsRoot}/${entryKey}`;
      let program;
      try {
        program = await resolveLocalProgram(
          (resolver) => vintage.runtime.harness.resolve(resolver),
          { main: source, root: roots.repoRoot },
        );
      } catch (error) {
        throw new Error(
          `today's source ${source} does not resolve: ${error}`,
        );
      }
      let compiled;
      try {
        compiled = await vintage.runtime.patternManager.compilePattern(
          program as never,
          { space: vintage.space as never },
        );
      } catch (error) {
        throw new Error(
          `today's source ${source} does not compile: ${error}`,
        );
      }
      const compiledRef = vintage.runtime.patternManager.getArtifactEntryRef(
        compiled,
      );
      if (compiledRef === undefined) {
        throw new Error(`today's source ${source} has no artifact entry ref`);
      }
      refByKey.set(entryKey, compiledRef);
    }

    const entry: VintageManifestEntry = {
      identity: ref.identity,
      symbol: ref.symbol,
      main,
      cellId: String(link.id),
      space: vintage.space,
    };
    // Every recorded symbol must resolve in today's module, by the SAME rule
    // the materializer applies (`materializeOnCell`): the compiled entry's own
    // symbol, or a named artifact under the compiled identity. A stored root
    // can legitimately name a non-entry artifact (a named export, a
    // transformer hoist), and if today's module dropped that symbol the replay
    // refuses the entry — so the adopt must refuse it first.
    const allEntries: [VintageManifestEntry, string][] = [
      [entry, key],
      ...childEntries.map((childEntry, index) =>
        [childEntry, childKeys[index]] as [VintageManifestEntry, string]
      ),
    ];
    for (const [recorded, entryKey] of allEntries) {
      const compiledRef = refByKey.get(entryKey)!;
      if (
        recorded.symbol !== compiledRef.symbol &&
        vintage.runtime.patternManager.artifactFromIdentitySync(
            compiledRef.identity,
            recorded.symbol,
          ) === undefined
      ) {
        throw new Error(
          `today's ${recorded.main} defines no "${recorded.symbol}" — the ` +
            `stored root names an artifact this version does not have, so ` +
            `the replay would refuse it`,
        );
      }
    }
    await writeVintageManifest(vintage, [entry, ...childEntries]);
    const back = await readVintageManifest(vintage);
    log(`manifest readback: ${JSON.stringify(back)}`);

    // The replay's restore control reads a doc at the known vintage-root cause
    // (a native capture pins the test run's result there). An adopted fixture
    // has no test run, so stamp a marker doc: it travels in the same file, so
    // its presence after restore proves restoration the same way.
    const control = vintageRoot<Record<string, unknown>>(vintage, undefined);
    const { error } = await vintage.runtime.editWithRetry((tx) => {
      control.withTx(tx).set({
        adoptedFrom: snapshotPath.split("/").pop() ?? snapshotPath,
      });
    });
    if (error !== undefined) {
      throw new Error(`could not stamp restore control: ${error.message}`);
    }
    await vintage.runtime.idle();
    await vintage.runtime.storageManager.synced();

    const outDir = `${roots.vintagesRoot}/${testKey}/${PINNED}`;
    await Deno.mkdir(outDir, { recursive: true });
    const dest = `${outDir}/${vintageFileName(stampFor(now), ref.identity)}`;
    try {
      await Deno.lstat(dest);
      throw new Error(`refusing to overwrite existing fixture: ${dest}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await vintage.snapshot(dest);
    log(`fixture written: ${dest}`);
    return dest;
  } finally {
    await vintage.dispose();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

if (import.meta.main) {
  const childArgs = Deno.args.filter((arg) => arg.startsWith("--child="));
  const positional = Deno.args.filter((arg) => !arg.startsWith("--child="));
  const [snapshotPath, expectedIdentity, testKey, main] = positional;
  if (!snapshotPath || !expectedIdentity || !testKey || !main) {
    console.error(
      "usage: vintage-adopt.ts <snapshot.sqlite> <identity> <test key> " +
        "<main> [cause] [--child=<cellId>=<main>]...",
    );
    Deno.exit(2);
  }
  const children = childArgs.map((arg) => {
    const value = arg.slice("--child=".length);
    const split = value.indexOf("=");
    if (split < 1) {
      console.error(`malformed --child argument: ${arg}`);
      Deno.exit(2);
    }
    return { cellId: value.slice(0, split), main: value.slice(split + 1) };
  });
  const repoRoot = Deno.cwd();
  await adoptVintage({
    snapshotPath,
    expectedIdentity,
    testKey,
    main,
    cause: positional[4],
    children,
    roots: {
      repoRoot,
      patternsRoot: `${repoRoot}/patterns`,
      vintagesRoot: `${repoRoot}/${VINTAGES_DIR}`,
      signer: await Identity.fromPassphrase("pattern vintage fixture"),
    },
    log: (line) => console.log(line),
  });
}
