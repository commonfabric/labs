/**
 * The vintage gate's actual work: capture a populated store by running a
 * pattern's own tests, and replay a captured store under today's source.
 *
 * Split from `pattern-vintage.ts` so it takes its roots as arguments instead of
 * deriving them from `import.meta.url`. That is what makes the gate testable
 * against a temp tree holding a throwaway pattern — and the test that buys is
 * the one that matters: break a pattern on purpose and prove the gate goes red.
 * Verifying that by hand on every change is exactly the check that stops
 * happening.
 */

import { exists } from "@std/fs";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { FragmentWriter } from "@commonfabric/test-support/records";
import type { Identity } from "@commonfabric/identity";
import { runTestPattern } from "../packages/cli/lib/test-runner.ts";
import {
  AUTO,
  autoGenerationsToPrune,
  collectVintages,
  describeError,
  hoistSupersessionReason,
  newestAutoGeneration,
  patternKeyFromMain,
  PINNED,
  promoteVintage,
  relativeToRepo,
  removeVintages,
  type ReplayFailure,
  replayFilterTakes,
  stampFor,
  vintageFileName,
  vintageRecordName,
  type VintageRef,
} from "./pattern-vintage-lib.ts";
import {
  isPresentRootValue,
  isReduction,
  materializeOnCell,
  openFileBackedRuntime,
  readStateUnder,
  readStoredResultSchema,
  readVintageManifest,
  readVintageState,
  strandedKeys,
  vintageHoldsRoot,
  type VintageManifestEntry,
  vintageRootCause,
  vintageRootHasState,
  writeVintageManifest,
} from "../packages/piece/test/state-continuity-harness.ts";
import { vintageCompanionDir } from "../packages/piece/test/vintage-layout.ts";
import {
  acceptedDropKey,
  acceptedDropsFor,
  type AcceptedStateDrop,
  withoutAcceptedDrops,
} from "./pattern-vintage-accepted-drops.ts";
import { derivedCorrectionsFor } from "./pattern-vintage-derived-corrections.ts";

export interface GateRoots {
  /** Repo root, used only to shorten paths in reports. */
  repoRoot: string;

  /** Directory pattern keys are resolved against. */
  patternsRoot: string;

  /** Directory fixtures live under. */
  vintagesRoot: string;

  /** Signer every capture and replay runs as. */
  signer: Identity;
}

/** What a replay reads beyond the tree it is pointed at. */
export interface ReplayOptions {
  /**
   * Removals the state comparison forgives, defaulting to the repository's
   * own `ACCEPTED_STATE_DROPS`. A test supplies its own list so that a case
   * about the accounting is written against a pattern it wrote, rather than
   * against whichever entries the repository's list holds today.
   */
  acceptedDrops?: readonly AcceptedStateDrop[];
}

async function withRuntime<T>(
  roots: GateRoots,
  fromSnapshot: string | undefined,
  run: (
    vintage: Awaited<ReturnType<typeof openFileBackedRuntime>>,
  ) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "pattern-vintage-" });
  // `openFileBackedRuntime` is INSIDE the try: opening a corrupt fixture is a
  // way it throws, and leaving the open outside would leak the temp copy of
  // every fixture that failed to open — 3.5 MiB a time.
  let vintage: Awaited<ReturnType<typeof openFileBackedRuntime>> | undefined;
  try {
    vintage = await openFileBackedRuntime(roots.signer, dir, fromSnapshot);
    return await run(vintage);
  } finally {
    await vintage?.dispose().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Where a recorded `main` says a repo pattern lives, for THESE roots. */
function patternsPrefix(roots: GateRoots): string {
  return `${roots.patternsRoot.slice(roots.repoRoot.length)}/`;
}

function localProgramOptions(roots: GateRoots, key: string) {
  return { main: `${roots.patternsRoot}/${key}`, root: roots.repoRoot };
}

/**
 * Whether a recorded instantiation is something today's source can be applied
 * to. Four ways it is not:
 *
 * - No source path at all: unaddressable, nothing to resolve.
 * - A `*.test.tsx` entry: a test pattern creates stores and is never an upgrade
 *   target (#5180).
 * - A path that is not repo-root-relative. The evaluate loop records injected
 *   helper modules too (`cfc.ts`), and the repo's own discriminator for "an
 *   authored file" is a leading `/`. Without this the replay would build
 *   `${repoRoot}cfc.ts` — a path with no separator, so a spurious red.
 * - A `keyless:` identity: a session pointer, not a content hash, so it can
 *   never equal a freshly compiled identity and would report as CHANGED on
 *   every run forever.
 */
export function isUpgradeTarget(entry: VintageManifestEntry): boolean {
  if (entry.main === undefined) return false;
  if (!entry.main.startsWith("/")) return false;
  if (/\.test\.tsx?$/.test(entry.main)) return false;
  return !entry.identity.startsWith("keyless:");
}

/**
 * A stranded value, short enough to sit in a failure line.
 *
 * `JSON.stringify` on its own is not safe to call here even though both sides
 * have been through `comparableState`: `bigint` is a value a durable doc may
 * hold and stringifying one THROWS. A report that can take the run down is a
 * report that fails exactly when it is needed, so this can only ever return a
 * string.
 */
export function snippet(value: unknown): string {
  try {
    const text = JSON.stringify(
      value,
      (_key, item) => typeof item === "bigint" ? `${item}n` : item,
    );
    return (text ?? String(value)).slice(0, 80);
  } catch {
    return String(value).slice(0, 80);
  }
}

/** Which test's fixture records a pattern, and whether it can credit it. */
export interface VintageAttribution {
  testKey: string;

  /**
   * PINNED is the only tier coverage counts. It breaks TIES over which test to
   * name, and selects a remedy: `reportUncovered` scopes by whether the
   * recording fixture FAILED and then by tier, so an auto generation that
   * replayed cleanly is told to promote itself.
   */
  pinned: boolean;
}

/** What replaying ONE fixture found, kept per fixture rather than summed. */
export interface VintageOutcome {
  ref: VintageRef;

  /** Recorded instantiations that are legitimate upgrade targets. */
  targets: number;

  /** Of those, the ones whose source moved since this fixture was captured. */
  changed: number;

  /** Whether replaying this fixture produced any failure at all. */
  failed: boolean;
}

/**
 * Test keys whose newest generation no longer matches today's source.
 *
 * A fixture that replays with `changed === 0` IS the current generation: every
 * target it recorded still compiles to the identity it captured, so a fresh
 * capture would record the same world and cost a 3.5 MiB file to say so. Once
 * every fixture for a key reports something changed, the tree no longer holds
 * a generation of today, and the next one is due.
 *
 * Two shapes deliberately do NOT count as current, for opposite reasons:
 *
 *   - a fixture with no targets proved nothing, so it cannot be evidence that
 *     the world has not moved;
 *   - a fixture that FAILED is not a statement about currency at all — it is
 *     the gate's own red, and reading it either way would let a broken fixture
 *     decide whether to capture.
 *
 * The second is a SECOND LOCK, not the operative rule.
 * `captureChangedGenerations` returns `refused-red` on any failure before this
 * is ever called, so no production path reaches it today. It stays because
 * this function is exported and answers a question — "is a generation due" —
 * that a caller could reasonably ask without refusing on red first, and
 * because the honest answer to that question from a broken fixture is "this
 * fixture cannot tell you".
 *
 * A served-route-only fixture reports `changed === 0` and so reads as current,
 * which is right: its identity is not reproducible from the repo, so no
 * capture could ever move it off zero and a staleness rule that counted it
 * would capture a new generation on every single run, forever.
 *
 * An ADOPTED old-toolchain fixture (`tasks/vintage-adopt.ts`) is the same
 * hazard from the opposite side: it IS identity-compared, so it reports
 * `changed > 0` for as long as its recorded identity differs from today's —
 * which for a committed old-toolchain capture is every run in practice. It
 * reads as stale here by design — the rule holds because the key's NATIVE
 * fixtures are what satisfy currency. A test key whose only fixtures were
 * adopted would trigger a capture on every `--capture-changed` run; today
 * every adopted fixture shares its key with a native one.
 */
export function staleTestKeys(
  outcomes: readonly VintageOutcome[],
): string[] {
  const seen = new Set<string>();
  const current = new Set<string>();
  for (const outcome of outcomes) {
    seen.add(outcome.ref.testKey);
    if (outcome.failed || outcome.targets === 0) continue;
    if (outcome.changed === 0) current.add(outcome.ref.testKey);
  }
  return [...seen].filter((key) => !current.has(key)).sort();
}

/** What replaying one fixture found. */
export interface ReplayReport {
  /** Instantiations the fixture recorded. Zero means it proved nothing. */
  candidates: number;

  /** Recorded instantiations that are legitimate upgrade targets. */
  targets: number;

  /**
   * Recorded instantiations that cannot be mapped to a file to apply.
   *
   * Two shapes: no source path at all, and a path that is not repo-root-relative
   * (the evaluate loop records injected helper modules too). Each one also lands
   * in `failures`, so a fixture holding any is a RED run rather than a green one
   * with a caveat — the replay skips them, and a verdict that passes while
   * silently covering fewer roots than the fixture holds is this tier's worst
   * failure mode. Kept as a count for the tests that pin that behavior.
   */
  unmappable: number;

  /** Targets whose source CHANGED since capture — the actual migrations. */
  changed: number;

  /** Changed targets that applied cleanly. */
  updated: number;

  /** Keys an applied update stopped being able to read back. */
  stranded: number;

  /**
   * Targets recorded under a SERVED route rather than a repo path.
   *
   * Their identity is not reproducible from the repo, so they are not
   * identity-compared. Counted so a fixture that is mostly served routes cannot
   * read as thorough coverage.
   */
  servedRoute: number;

  /**
   * Pattern keys this fixture actually replayed a target for.
   *
   * Coverage is judged from THIS, not from the fixture tree's shape. A fixture
   * is named after the TEST that produced it and routinely covers several
   * patterns, so "a directory exists for X" stopped being the same question as
   * "X was replayed" — and the second is the one that matters.
   */
  covered: Set<string>;

  /**
   * Pattern keys this fixture's manifest NAMES, whether or not each was
   * credited as coverage.
   *
   * Deliberately not a subset of `covered`, and that is the whole point.
   * `covered` answers "was this replayed and credited"; a pattern can be
   * recorded and then not credited — a root the fixture no longer holds, a
   * source that stopped resolving or compiling, a fixture that failed outright
   * before any target ran, or an auto-tier generation, which credits nothing
   * by design however cleanly it replays.
   * (NOT a served route: those are credited, `covered.add` running
   * unconditionally below the served-route branch.) Deriving attribution from
   * `covered` made the "recorded by X" branch unreachable by construction,
   * since `uncovered` is exactly the required keys ABSENT from `covered`.
   */
  recorded: Set<string>;

  /**
   * Accepted-drop entries that actually removed something from a vintage here.
   *
   * `tasks/pattern-vintage-accepted-drops.ts` can only shrink, and an entry
   * that forgives nothing is indistinguishable from one quietly doing nothing
   * unless the run counts where each was used. Keyed by the entry's pattern.
   */
  dropsApplied: Set<string>;

  /**
   * Derived-hoist targets held back from failing, each entry tagged with the
   * rule that held it. Two refusal shapes qualify: STORED ARGUMENTS today's
   * schema refused ("stored arguments superseded"), because a hoist's
   * arguments are the captures of a derivation the updated source re-runs
   * and re-supplies wholesale; and a recorded hoist today's source no longer
   * emits ("hoist no longer emitted"), because hoist ids are builder node
   * ids an ordinary edit renumbers — the same supersession wearing its
   * second face. The real update channel (`setPattern`) validates only the
   * root contract, so failing on either held vintages to a stricter rule
   * than any deployed piece experiences. Nothing else is held back: any
   * other error on a hoist still fails, and so does the readback comparison
   * for every hoist that applies — which is what keeps a row-allocated
   * cell's cause-stability (the moved-`.for()` class) gated.
   */
  capturesSuperseded: string[];

  failures: ReplayFailure[];
}

/**
 * Replay one fixture: apply today's source to every RECORDED instantiation
 * whose pattern has changed since the capture.
 *
 * Only the changed ones are applied, because an unchanged identity has no
 * migration to exercise — the same condition the auto-updater itself fires on.
 * So the recorded set is the CANDIDATE set, not the work list.
 */
export async function replayVintage(
  roots: GateRoots,
  vintage: VintageRef,
  options: ReplayOptions = {},
): Promise<ReplayReport> {
  const where = {
    testKey: vintage.testKey,
    path: relativeToRepo(vintage.path, roots.repoRoot),
  };
  // A fixture-level failure still ATTRIBUTES what its manifest names, when the
  // manifest could be read. Returning an empty `recorded` routed those patterns
  // into "no fixture records this, capture one" — false, since the fixture is
  // sitting in the tree, and the suggested capture then prints "Already pinned"
  // and exits 0. That is the dead end this whole change removes, one layer down.
  const fail = (
    detail: string,
    recorded: Set<string> = new Set<string>(),
  ): ReplayReport => ({
    candidates: 0,
    targets: 0,
    unmappable: 0,
    changed: 0,
    updated: 0,
    stranded: 0,
    servedRoute: 0,
    covered: new Set<string>(),
    recorded,
    dropsApplied: new Set<string>(),
    capturesSuperseded: [],
    failures: [{ ...where, detail }],
  });

  /** Every pattern key a manifest names, for attributing a failed fixture. */
  const recordedFrom = (entries: readonly VintageManifestEntry[]) =>
    new Set(
      entries
        .map((e) => patternKeyFromMain(e.main, patternsPrefix(roots)))
        .filter((key): key is string => key !== undefined),
    );

  // Stated once, because every "this fixture is not usable" message needs it and
  // the obvious remedy is WRONG: `--update` skips a key that already has a
  // pinned vintage and the capture refuses to overwrite one, so "recapture it"
  // on its own prints "already pinned" and changes nothing. The path is
  // ABSOLUTE, not the repo-relative one the report prints for identification —
  // an instruction to delete a file has to name it the same way from whatever
  // directory the reader is standing in — and it names the companion directory
  // too, which is part of the fixture and would otherwise be left behind to
  // collide with the recapture.
  const remedy =
    `Delete ${vintage.path} and ${
      vintageCompanionDir(vintage.path)
    }/ deliberately, then \`deno task pattern-vintage --update ` +
    `${vintage.testKey}\``;

  const corrections = await derivedCorrectionsFor(vintage, roots.repoRoot);
  return await withRuntime(roots, vintage.path, async (runtimeVintage) => {
    // The control, before anything is applied. A fixture that did not restore
    // presents as a fresh empty space, and today's source materializes onto a
    // fresh empty space just fine — so without this, "green" and "the fixture
    // was never there" are the same reading.
    if (!await vintageRootHasState(runtimeVintage)) {
      return fail(
        "this fixture holds no captured root — it did not restore, so " +
          `replaying it would prove nothing. ${remedy}`,
      );
    }
    const manifest = await readVintageManifest(runtimeVintage);
    if (manifest === undefined || manifest.entries.length === 0) {
      return fail(
        "this fixture records no pattern instantiations, so there is nothing " +
          `to update and a green run would assert nothing. ${remedy}`,
      );
    }
    // The filename's identity is PROVENANCE — which version wrote this state —
    // and provenance nothing reads is decoration that drifts. The manifest names
    // every identity the run materialized, so checking that the filename's is
    // among them costs one comparison and keeps the name answerable: a fixture
    // renamed, or restored from the wrong file, says so here rather than
    // replaying under a version it never came from.
    if (!manifest.entries.some((e) => e.identity === vintage.identity)) {
      return fail(
        `this fixture's name records identity ${vintage.identity}, which it ` +
          `does not contain (it holds ${
            [...new Set(manifest.entries.map((e) => e.identity))].join(", ")
          }) — so it is not the state its name claims. Renaming the file to ` +
          `one of the identities it does hold keeps the vintage, which a ` +
          `recapture would replace with today's state; a deep vintage cannot ` +
          `be recaptured at all, since the version that wrote it no longer ` +
          `exists in runnable form. Only if the file is genuinely junk: ` +
          `${remedy}`,
        recordedFrom(manifest.entries),
      );
    }

    const targets = manifest.entries.filter(isUpgradeTarget);
    // Unaddressable, not merely un-targeted. Both shapes belong here: no source
    // path at all, and a path that is not repo-root-relative — the evaluate loop
    // records injected helper modules (`cfc.ts`) whose names carry no leading
    // slash, and `${repoRoot}cfc.ts` is not a file. Counting only the first would
    // let the second be skipped in silence while the verdict says "all mappable".
    //
    // Computed BEFORE the zero-target check below, which would otherwise return
    // while claiming a reason it had not looked at: an unmappable entry is not a
    // test pattern, and its per-entry diagnosis is the actionable half.
    // Keyless excluded on the SAME terms as the capture's guard. A keyless
    // pattern is session-only by construction and can never be an update
    // target, so "recorded but NOT validated" is the wrong verdict for one —
    // there is nothing to validate. The two checks have to agree, or a capture
    // the gate accepts is a replay it refuses.
    const unmappable = manifest.entries.filter(
      (e) =>
        !e.identity.startsWith("keyless:") &&
        (e.main === undefined || !e.main.startsWith("/")),
    );
    // Zero targets is a FIXTURE-level failure, not a quiet contribution of
    // nothing to the run's total. `isClean` floors the SUM of targets, which one
    // fixture covering nothing slips under the moment another covers five — and
    // this fixture would then have applied today's source to nothing at all
    // while the run read green.
    //
    // Reachable, and by design: `isUpgradeTarget` has grown four exclusions,
    // two of them added after fixtures already existed. Fixtures are
    // append-only and never recaptured, so a new exclusion silently zeroes an
    // old fixture's coverage — exactly the kind of drift this tier keeps
    // mistaking for a pass.
    if (targets.length === 0) {
      return fail(
        `this fixture records ${manifest.entries.length} instantiation(s), ` +
          `but not one is something today's source can be applied to — ` +
          `${unmappable.length} cannot be mapped to a file at all, and the ` +
          `rest are test patterns or keyless session pointers. Replaying it ` +
          `asserts nothing. ${remedy}`,
        recordedFrom(manifest.entries),
      );
    }
    // The per-entry control, and the one the whole gate leans on: does this
    // fixture actually HOLD the root it is about to validate? A root that is not
    // there reads CLEAN — the cell is absent, today's source materializes onto
    // it, the root then holds today's defaults, and the entry counts as updated
    // cleanly over state that was never captured. `vintageRootHasState` above
    // cannot answer this: it is one check on the well-known capture root and
    // says nothing about the nested cell each entry names.
    //
    // Measured, three ways to be absent and all of them read green without this:
    // a root recorded in a space the fixture does not carry (a cross-space child
    // — `Factory.inSpace(...)` is how a profile is created), a companion store
    // that restored but is empty, and a recorded cell id that names nothing.
    const carried = new Set(runtimeVintage.restoredSpaces);
    const missing = new Set<VintageManifestEntry>();
    for (const entry of targets) {
      const held = await vintageHoldsRoot(
        runtimeVintage,
        entry.space,
        entry.cellId,
      );
      if (!held) missing.add(entry);
    }
    const report: ReplayReport = {
      candidates: manifest.entries.length,
      targets: targets.length,
      unmappable: unmappable.length,
      changed: 0,
      updated: 0,
      stranded: 0,
      servedRoute: 0,
      // Empty here, and filled as each target is actually REPLAYED. Seeding it
      // from `targets` up front was the same silent-narrowing shape this file
      // keeps hitting from the other side: a target skipped as a served route,
      // or one the presence control already reported, still counted as covered,
      // so a required pattern reachable ONLY that way satisfied the coverage
      // gate without ever being materialized or compared. The docstring says
      // coverage means "X was replayed"; now it does.
      covered: new Set<string>(),
      recorded: new Set<string>(),
      dropsApplied: new Set<string>(),
      capturesSuperseded: [],
      failures: [],
    };
    // A recorded root nothing can address is a FAILURE, not a note. The replay
    // skips it, so a green verdict would be a claim about fewer roots than the
    // fixture holds — coverage silently narrowed, which is this tier's worst
    // failure mode and the one it has hit three separate times. Every
    // instantiation carries its own authored file today, so a sourceless entry
    // means that propagation regressed and the gate should say so loudly.
    for (const entry of unmappable) {
      report.failures.push({
        ...where,
        detail: `recorded instantiation ${entry.identity}#${entry.symbol} ` +
          `cannot be mapped to a file to apply (${
            entry.main === undefined
              ? "no source path"
              : `"${entry.main}" is not repo-root-relative`
          }) — it was recorded but NOT validated`,
      });
    }
    // Same rule for a root the fixture does not hold, and for the same reason:
    // the replay cannot reach it, so a green verdict would be a claim about
    // fewer roots than the fixture records. A missing SPACE is called out by
    // name because it is both the likeliest cause and the one with an obvious
    // remedy; otherwise the message names the EVIDENCE the control looked for,
    // so a doc that is present but unstamped — the one shape a false red could
    // take — is distinguishable from a doc that is not there at all.
    //
    for (const entry of missing) {
      report.failures.push({
        ...where,
        detail: `recorded instantiation ${entry.identity}#${entry.symbol} ` +
          (carried.has(entry.space)
            ? `carries neither a pattern identity nor a setup marker at ` +
              `${entry.cellId} in ${entry.space}, so this fixture does not ` +
              `hold that root`
            : `was materialized in ${entry.space}, which this fixture does ` +
              `not carry (it holds ${[...carried].sort().join(", ")})`) +
          ` — it was recorded but NOT validated. If the space is one the ` +
          `fixture should carry, its companion store is missing: restore it ` +
          `rather than recapturing, which would replace the vintage with ` +
          `today's state. Only if the fixture is genuinely wrong: ${remedy}`,
      });
    }

    // Every target's before-state, captured BEFORE the first materialize.
    //
    // Not an optimization — a correctness fix. A fixture holds a parent and its
    // nested sub-patterns, and they share one runtime. Materializing the parent
    // runs its reactive graph, which can write through to a nested root before
    // that entry's own turn comes. A before-snapshot taken lazily inside the
    // loop would then be the ALREADY-UPDATED state, and the nested target would
    // compare it against itself and pass — a storage-key move in a sub-pattern
    // silently uncaught, which is the exact class this comparison exists for.
    // Keyed by SPACE and id, not id alone. An entity id is content-derived and
    // carries no space, so the same id can name different roots in different
    // spaces — keying on it alone would hand one root's prior state to another
    // root's comparison.
    const beforeByCell = new Map<
      string,
      Record<string, unknown> | undefined
    >();
    // Whether the root carried a stored result schema AT CAPTURE, taken in the
    // same pass and for the same reason. The failure below distinguishes "no
    // schema stored" from "a schema that reads back nothing", and asking after
    // the materialize reads the schema THE REPLAY JUST WROTE — so the fixture
    // defect it exists to name would always report as the second one.
    const hadSchemaByCell = new Map<string, boolean>();
    for (const entry of targets) {
      // Skip what the presence check already reported. Reading it would only
      // re-derive "absent" and risk reporting the same root twice.
      if (missing.has(entry)) continue;
      const key = `${entry.space}/${entry.cellId}`;
      if (beforeByCell.has(key)) continue;
      beforeByCell.set(
        key,
        await readVintageState(runtimeVintage, entry.space, entry.cellId),
      );
      hadSchemaByCell.set(
        key,
        await readStoredResultSchema(
          runtimeVintage,
          entry.space,
          entry.cellId,
        ) !== undefined,
      );
    }

    for (const entry of targets) {
      // A recorded `main` is either a repo path or the ROUTE the toolshed
      // serves the pattern at; both name a file under `packages/patterns/`.
      const key = patternKeyFromMain(entry.main, patternsPrefix(roots));
      // RECORDED before any skip, including the presence control below. The
      // manifest names this pattern whatever happens next, and that is what
      // makes the fixture worth pointing a reader at. Ordering this after the
      // `missing` skip left the "fixture no longer holds the root" case — the
      // one this attribution most needs to explain — reported as though no
      // fixture recorded the pattern at all, which is the dead end the seam
      // removal exists to close, one layer down.
      if (key !== undefined) report.recorded.add(key);
      // Already reported above. Materializing it anyway would apply today's
      // source to an empty cell and count the result as a clean update.
      if (missing.has(entry)) continue;
      if (key === undefined) {
        report.failures.push({
          ...where,
          detail: `recorded instantiation ${entry.identity}#${entry.symbol} ` +
            `names "${entry.main}", which is neither a repo path nor a served ` +
            `pattern route, so today's source for it cannot be found. The ` +
            `capture guard refuses this shape now, so a fixture holding one ` +
            `predates it: ${remedy}`,
        });
        continue;
      }
      const source = `${roots.patternsRoot}/${key}`;
      let program;
      try {
        program = await resolveLocalProgram(
          (r) => runtimeVintage.runtime.harness.resolve(r),
          { main: source, root: roots.repoRoot },
        );
      } catch (error) {
        report.failures.push({
          ...where,
          detail:
            `${entry.main} no longer resolves: ${
              describeError(error)
            }. If it moved deliberately, the fixture records a path that is no ` +
            `longer there: ${remedy}`,
        });
        continue;
      }
      // Guarded for the same reason `resolve` above is: this loop compiles EVERY
      // recorded target's file, including nested sub-pattern modules, so one that
      // no longer compiles — or exports no `default` — must be a reported finding
      // for that entry, not an exception that aborts the remaining entries and
      // every later fixture with them.
      let pattern;
      try {
        pattern = await runtimeVintage.runtime.patternManager
          // Compiled in the space the ROOT lives in, because that is what
          // production does: `pattern-updater.ts` compiles with the piece's own
          // space, and the space selects what a `cf:` fabric import resolves
          // against and where `compileViaCellCache` persists the closure.
          //
          // Stated as fidelity, not as a bug this catches — no test separates
          // the two, and none can with fixtures as captured: the pattern-test
          // runner cannot replicate a source closure into a child space
          // (`closure-replication-failed` on every cross-space capture), so a
          // companion store carries the child's DATA and no closure for this to
          // resolve differently against. Separating them needs a fixture whose
          // cross-space child has a `cf:` import, which is a capture-side gap
          // rather than a reason to compile in the wrong space meanwhile.
          .compilePattern(program as never, {
            space: entry.space as never,
          });
      } catch (error) {
        report.failures.push({
          ...where,
          detail: `${entry.main} no longer compiles: ${
            describeError(error)
          }. Fix the source; if it was removed deliberately, ${remedy}`,
        });
        continue;
      }
      // A pattern loaded BY URL compiles to a different identity than the same
      // file compiled locally — measured, `system/profile-create.tsx` records
      // `T-01iegivM23Be` when served and `B_VWt7zYJWHbCS` from the repo. So an
      // identity comparison would call it changed on every run forever, and
      // "changed" would stop meaning anything for it. Counted and reported
      // rather than silently skipped: the pattern is still covered wherever a
      // fixture imports it locally.
      // ...but only the IDENTITY comparison is skipped. The target is still
      // materialized and its state still compared, which is the whole of what
      // the gate is for. Skipping it outright meant a recorded root got no
      // check at ALL — no materialize, no state comparison — and the committed
      // lunch-poll fixture holds exactly this shape for `profile-create`, so a
      // breaking change to that pattern left the run green. There is no
      // "changed since capture" answer to give for one, so it is materialized
      // UNCONDITIONALLY and counted apart from `changed`.
      const servedRoute = entry.main !== undefined &&
        entry.main.startsWith("/api/");
      if (servedRoute) report.servedRoute++;
      // Covered from HERE: today's source for this target resolved, compiled,
      // and was not skipped. An UNCHANGED identity below still counts — the
      // fixture exercised the pattern and found no migration to run, which is
      // the common case and a real answer. What must not count is a target
      // that never got this far.
      //
      // PINNED only. An auto capture is regenerable and pruned by count, so
      // letting one satisfy the coverage gate means retention can delete the
      // gate's only evidence for a pattern and the run still reads green. That
      // guarantee used to live in `coveredPatternKeys`, which coverage stopped
      // going through when it moved to what the replay actually replayed; it is
      // restored here, and `--capture-changed` now writes auto generations, so
      // it is load-bearing rather than anticipatory.
      if (vintage.tier === PINNED) report.covered.add(key);
      const today = runtimeVintage.runtime.patternManager
        .getArtifactEntryRef(pattern)?.identity;
      // Unchanged identity, no migration to exercise. This is the common case
      // and a legitimate no-op, NOT a skipped check.
      //
      // A served route has no such answer — the same file compiles to a
      // different identity served than from the repo, so `today` never equals
      // what was recorded — so it falls through and is materialized every run.
      // It is NOT counted in `changed`, which would otherwise report the same
      // fixed number forever and stop meaning "something moved".
      if (!servedRoute) {
        if (today === entry.identity) continue;
        report.changed++;
      }

      const before = beforeByCell.get(`${entry.space}/${entry.cellId}`);

      const outcome = await materializeOnCell(
        runtimeVintage,
        program as never,
        // The RECORDED space, not the fixture's primary one. An entity id is
        // content-derived and so carries no space, which makes reading it under
        // the wrong DID a lookup that SUCCEEDS at finding nothing: the cell comes
        // back absent, today's source materializes onto it, and the entry counts
        // as updated cleanly. Every root a cross-space child owns would replay
        // that way.
        (v, resultSchema) =>
          v.runtime.getCellFromEntityId(
            entry.space as never,
            entry.cellId as never,
            [],
            resultSchema as never,
          ),
        {
          // The RECORDED symbol, not the module's entry export. A module
          // contributes several instantiable patterns (its default plus each
          // transformer hoist), and the manifest already says which one this
          // cell holds — applying the entry pattern instead would validate a
          // different artifact than the one stored here.
          symbol: entry.symbol,
          // ...and the recorded space, for the compile inside, for the same
          // reason as the `compilePattern` above.
          space: entry.space,
        },
      );
      if (outcome.error !== undefined) {
        // A derived hoist whose stored arguments no longer satisfy today's
        // schema is not a stranded piece: see `capturesSuperseded` on the
        // report. Held back and reported WITH the rule that fired, never
        // silently dropped. Any other refusal of a hoist — compile, commit,
        // storage — still fails.
        const supersession = hoistSupersessionReason(
          entry.symbol,
          outcome.error,
          outcome.missingArtifact === true,
        );
        if (supersession !== undefined) {
          report.capturesSuperseded.push(
            `${entry.main} ${entry.symbol} (${supersession})`,
          );
          continue;
        }
        report.failures.push({
          ...where,
          detail:
            `updating ${entry.main} (${entry.symbol}) over this vintage ` +
            `was REFUSED:\n      ${outcome.error}`,
        });
        continue;
      }

      // The update APPLIED. That is not the same as the data surviving, and
      // until this comparison existed the gate could not tell the two apart:
      // a moved `.for()` key materializes perfectly and silently reads back
      // empty. Compare what the old version could see against what today's
      // source can.
      // A recorded target whose prior state cannot be read is a FAILURE, not a
      // skip. The manifest says a pattern WAS materialized at this cell, so a
      // root with no stored schema means the fixture does not hold what it
      // claims — and skipping the comparison there would report "updated
      // cleanly" for a target whose data was never examined. That is the
      // silent-non-coverage shape this tier has hit repeatedly.
      //
      // UNREADABLE is the finding, not EMPTY. A prior state of `{}` compares
      // clean against anything and so asserts nothing — but a pattern's result
      // can legitimately BE `{}`, so treating that as loss would red a valid
      // root. Telling "held nothing" from "was never here" is a question about
      // the ROOT rather than about its value, and belongs to the presence
      // control that runs before any of this, not to the comparison.
      if (before === undefined) {
        // Say WHICH of the two happened. They have different causes and
        // different fixes, and one message for both sent a reader looking for
        // a missing schema when the schema was present, readable, and the read
        // THROUGH it was what came back empty — see `schemaRelaxedForComparison`
        // for the collapse that produced. Read from the pre-materialize pass,
        // never re-derived here: this line runs AFTER the update, so asking the
        // root now would see the schema the replay just wrote.
        //
        // UNTESTED, deliberately and with the reason recorded. The no-schema
        // half needs a root the presence control ACCEPTS that carries no
        // result schema. A NATIVE capture cannot make one — `runner.ts` stamps
        // `patternSetupIdentity` and the schema in the same setup — and an
        // attempt to construct one by hand did not reach this branch at all.
        // Since the presence control also accepts the older `patternIdentity`
        // marker (an adopted fixture's roots carry only that), the shape is
        // REACHABLE in principle from an old store whose setup never wrote a
        // schema; none observed — every runner back to the oldest adopted
        // vintage stamps the schema in the same transaction as the identity —
        // so the case stays defensive. What the pre-materialize read buys is
        // that the OTHER half, which IS reachable, cannot be misreported as
        // this one.
        report.failures.push({
          ...where,
          detail: `recorded instantiation ${entry.identity}#${entry.symbol} ` +
            (hadSchemaByCell.get(`${entry.space}/${entry.cellId}`) === false
              ? `carries a presence marker but no readable stored schema, so `
              : `stores a result schema that reads back nothing, so `) +
            `applying ${entry.main} over it could not be checked for stranded ` +
            `state. The fixture does not hold what it claims: ${remedy}`,
        });
        continue;
      }
      // Re-read rather than reuse `outcome.value`, and through the SAME
      // helper the before state came from. `outcome.value` is the root under
      // the candidate's compiled schema verbatim, and that schema stops at
      // its `unknown` positions exactly as the stored one does — so every key
      // the before side newly resolves would come back `undefined` here and
      // report as stranded. The two sides have to be read the same way or the
      // comparison measures the reading. `outcome.resultSchema` is handed
      // back for precisely this: the schema of the pattern that was actually
      // materialized, rather than a second compile trusted to agree.
      const after = await readStateUnder(
        runtimeVintage,
        entry.space,
        entry.cellId,
        outcome.resultSchema,
      );
      {
        // A field the pattern REMOVED on purpose is not state this comparison
        // holds it to — see `pattern-vintage-accepted-drops.ts`, and the Tier 1
        // acceptance it is downstream of. Taken off both sides so the two are
        // read the same way, for the same reason `after` is re-read through the
        // schema `before` came from: an asymmetric strip would measure the
        // stripping. `applied` is counted from the vintage's side only, since
        // that is where "the vintage held it" is a fact.
        const drops = acceptedDropsFor(
          entry.main ?? "",
          vintage.stamp,
          options.acceptedDrops,
        );
        const paths = drops?.paths ?? new Set<string>();
        const keptBefore = withoutAcceptedDrops(before, paths, isReduction);
        const keptAfter = withoutAcceptedDrops(after, paths, isReduction);
        if (drops !== undefined) {
          for (const path of keptBefore.applied) {
            report.dropsApplied.add(acceptedDropKey(drops.pattern, path));
          }
        }
        const rawFindings = strandedKeys(
          keptBefore.value as Record<string, unknown>,
          keptAfter.value,
        );
        const findings = corrections?.grade(entry, rawFindings) ?? rawFindings;
        const describe = (finding: typeof findings[number]) =>
          `${finding.key} (was ${snippet(finding.before)}, now ${
            snippet(finding.after)
          })`;
        // A value that merely CHANGED is reported and not failed on. A replay
        // recomputes as well as reads, and a derived value the vintage never
        // pulled on legitimately resolves to something better this time — see
        // `StateFinding`. Warned rather than dropped, because the noise is
        // what tells us whether the grading is right.
        const changed = findings.filter((finding) => !finding.lost);
        if (changed.length > 0) {
          console.warn(
            `  ! ${where.testKey}: updating ${entry.main} (${entry.symbol}) ` +
              `changed state the vintage held: ${
                changed.map(describe).join("; ")
              }`,
          );
        }
        const lost = findings.filter((finding) => finding.lost);
        if (lost.length > 0) {
          report.stranded += lost.length;
          report.failures.push({
            ...where,
            detail:
              `updating ${entry.main} (${entry.symbol}) APPLIED CLEANLY ` +
              `but stranded state the vintage held: ${
                lost.map(describe).join("; ")
              }`,
          });
          continue;
        }
      }
      // A migration can apply without being refused and still leave the root
      // reading as nothing — the state gone rather than rejected. "Not refused"
      // and "the root still reads" are two claims, and the gate's own header
      // promises both, so both are checked. Per TARGET, not once per fixture:
      // `vintageRootHasState` above is a pre-check on the well-known capture
      // root, which says nothing about the nested cell each entry names.
      //
      // Asked of the RELAXED re-read, for the same reason the comparison is:
      // `outcome.value` is the candidate's schema applied verbatim, so a
      // required property that does not resolve — a session-local draft, in
      // every measured case — collapses the whole root to `undefined` and this
      // reports state as GONE that the very next line can still read. Two ways
      // of asking "does the root read" is how the two ends of one run come to
      // disagree, which is what `isPresentRootValue` exists to prevent.
      if (!isPresentRootValue(after)) {
        report.failures.push({
          ...where,
          detail: `updating ${entry.main} (${entry.symbol}) was not refused, ` +
            `but the root now reads as nothing — the vintage's state is gone`,
        });
        continue;
      }
      // `updated` counts CHANGED targets that came through cleanly, so a served
      // route — which has no changed answer — is not one of them. It was still
      // materialized and compared; any finding above has already been reported.
      if (!servedRoute) report.updated++;
    }
    for (const cellId of corrections?.unused() ?? []) {
      report.failures.push({
        ...where,
        detail: `approved derived-state correction for ${cellId} was unused; ` +
          "remove or re-evaluate its decision",
      });
    }
    return report;
  });
}

/** How `replayAll` reports what it walked. */
export interface ReplayAllOptions extends ReplayOptions {
  /**
   * Spool one gate record per fixture replayed.
   *
   * The task's entry point sets this: the fixtures under the repository's
   * vintage root are the gate's tests. A caller inside another test leaves
   * it unset, because the fixtures it points the roots at are that test's
   * own, and a fixture is data rather than a test of this repository.
   */
  recordResults?: boolean;

  /**
   * The fixtures to replay, as terms matched against each fixture's
   * repository-relative path. When absent or empty, every fixture replays.
   *
   * Each fixture's replay restores its own store, drives its own roots, and
   * compares against its own manifest, so its result is the same whether or not
   * other fixtures replay. A caller that filters the fixtures cannot make the
   * checks that need every fixture replayed.
   */
  only?: readonly string[];
}

/**
 * Replay every fixture under `vintagesRoot`.
 *
 * Returns the fixtures it walked, so the caller can decide coverage against the
 * SAME list it replayed. Two walks would be two answers to one question, and the
 * pair "replayed nothing" / "everything is covered" is exactly the disagreement
 * that reads as a pass.
 */
export async function replayAll(
  roots: GateRoots,
  options: ReplayAllOptions = {},
): Promise<
  {
    vintages: VintageRef[];
    replayed: number;
    candidates: number;
    targets: number;
    unmappable: number;
    changed: number;
    updated: number;
    stranded: number;
    servedRoute: number;
    covered: Set<string>;

    /**
     * Which TEST's fixture RECORDS each pattern, and whether that fixture is
     * the tier that credits coverage.
     *
     * Derived from the run rather than kept by hand: a manifest records the
     * authored file of every instantiation, so the fixture tree already knows
     * which test names which pattern. Built from `recorded`, NOT `covered` —
     * a pattern that was credited never reaches an uncovered report, so the
     * only ones worth attributing are those a fixture records and the run then
     * declines to credit.
     *
     * `pinned` breaks a TIE, and now also selects a remedy. When two fixtures
     * record one pattern, the pinned one is the more useful to name, and
     * `collectVintages` sorts `auto` before `pinned` so plain first-wins picks
     * the wrong one. `reportUncovered` additionally branches on it: an
     * auto-recorded pattern that replayed cleanly is one `--pin` away from
     * being covered, which is a different instruction from anything a pinned
     * fixture can need.
     */
    coveredBy: Map<string, VintageAttribution>;

    /**
     * What each fixture individually found, in walk order.
     *
     * The aggregate counts above cannot answer whether any ONE generation is
     * current, because `changed` sums across fixtures: a tree holding a
     * current generation and three older ones reports a positive `changed`
     * that says nothing about whether the newest still matches today. Deciding
     * when the next generation is due needs the per-fixture answer, so it is
     * returned rather than recomputed by a second walk that could disagree
     * with the one that produced the verdict.
     */
    perVintage: VintageOutcome[];

    /** Accepted-drop entries that forgave something somewhere in this run. */
    dropsApplied: Set<string>;

    /**
     * Derived-hoist targets held back, each tagged with the rule that held
     * it — a superseded stored argument, or a hoist no longer emitted.
     */
    capturesSuperseded: string[];

    failures: ReplayFailure[];
  }
> {
  const vintages = (await collectVintages(roots.vintagesRoot))
    .filter((vintage) =>
      replayFilterTakes(vintage.path, roots.repoRoot, options.only ?? [])
    );
  const perVintage: VintageOutcome[] = [];
  const covered = new Set<string>();
  const coveredBy = new Map<string, VintageAttribution>();
  const dropsApplied = new Set<string>();
  const capturesSuperseded: string[] = [];
  let servedRoute = 0;
  let candidates = 0,
    targets = 0,
    changed = 0,
    updated = 0,
    unmappable = 0,
    stranded = 0;
  const failures: ReplayFailure[] = [];
  // One gate-kind record per fixture, the replay's natural unit: a fixture
  // covers several patterns, and anything finer would be a redesign. The
  // stamp is part of the name because each captured generation is its own
  // test; a new capture is a new test, not a rename.
  const recordsFragment = options.recordResults === true
    ? FragmentWriter.openForRun()
    : undefined;
  for (const vintage of vintages) {
    const replayStarted = performance.now();
    const report = await replayVintage(roots, vintage, options);
    recordsFragment?.append({
      line: "record",
      test: {
        k: "gate",
        s: "repo",
        n: vintageRecordName(vintage),
      },
      outcome: report.failures.length > 0 ? "fail" : "pass",
      durationMs: Math.round(performance.now() - replayStarted),
    });
    perVintage.push({
      ref: vintage,
      targets: report.targets,
      changed: report.changed,
      failed: report.failures.length > 0,
    });
    candidates += report.candidates;
    targets += report.targets;
    unmappable += report.unmappable;
    changed += report.changed;
    updated += report.updated;
    stranded += report.stranded;
    servedRoute += report.servedRoute;
    for (const key of report.covered) covered.add(key);
    for (const key of report.dropsApplied) dropsApplied.add(key);
    capturesSuperseded.push(...report.capturesSuperseded);
    for (const key of report.recorded) {
      // From `recorded`, NOT `covered`: a pattern that was credited needs no
      // attribution, because it never reaches an uncovered report. The one
      // worth naming is the pattern a fixture records and the run then does
      // not credit. First fixture wins, and the walk is path-sorted, so the
      // name a failure prints does not change run to run.
      // A PINNED attribution always WINS, and first-wins only breaks ties
      // within a tier. `collectVintages` sorts by path and `auto` sorts before
      // `pinned`, so plain first-wins named the AUTO fixture when both record
      // one pattern — and the pinned one is the useful name, being the fixture
      // whose failure the reader is about to read.
      const existing = coveredBy.get(key);
      const pinned = vintage.tier === PINNED;
      if (existing === undefined || (pinned && !existing.pinned)) {
        coveredBy.set(key, { testKey: vintage.testKey, pinned });
      }
    }
    failures.push(...report.failures);
  }
  recordsFragment?.close();
  return {
    vintages,
    replayed: vintages.length,
    candidates,
    targets,
    unmappable,
    changed,
    updated,
    stranded,
    servedRoute,
    covered,
    coveredBy,
    perVintage,
    dropsApplied,
    capturesSuperseded,
    failures,
  };
}

/** Absolute path of the test file a fixture key names. */
export function testPathFor(roots: GateRoots, testKey: string): string {
  return `${roots.patternsRoot}/${testKey}`;
}

/**
 * Capture a vintage by running a TEST against a file-backed store, then
 * snapshotting.
 *
 * Keyed by the TEST, not by a pattern. The earlier shape went the other way —
 * take a pattern key and derive `<pattern>.test.tsx` — which only works where a
 * test is named after the single pattern it drives. Measured, that holds for 91
 * of 120 tests in `packages/patterns` and not for the interesting ones:
 * `topics/main.tsx` is tested by `topics/topics.test.tsx`, and
 * `lunch-poll/multi-user.test.tsx` drives several patterns and is named after
 * none of them.
 *
 * Running the test and recording what it instantiates needs no naming
 * convention at all, and covers every pattern the test touches rather than the
 * one whose name matched.
 *
 * The tests are what put DATA in the fixture. A vintage captured straight off
 * setup holds a freshly materialized root and nothing else, so no change can
 * strand anything in it. Pattern tests are themselves patterns —
 * `home.test.tsx` instantiates `Home({})` and drives it with
 * `action()`/`assert()` — so what they leave behind is real pattern state
 * written through real handlers.
 *
 * Each capture gets a FRESH store. Vintages are independent snapshots of one
 * version's world, never one database migrated forward: a carried-forward
 * lineage would already be shaped by every migration since, and would no longer
 * be state written by a version that knew nothing about today's.
 */
export async function captureVintage(
  roots: GateRoots,
  testKey: string,
  now: Date,
  tier: string = PINNED,
): Promise<string> {
  const testPath = testPathFor(roots, testKey);
  const dir = await Deno.makeTempDir({ prefix: "pattern-vintage-capture-" });
  const vintage = await openFileBackedRuntime(roots.signer, dir);
  try {
    // What the run instantiates and where. There is no way to enumerate this
    // from the store afterwards, so it is observed as it happens.
    const seen = new Map<string, VintageManifestEntry>();
    const result = await runTestPattern(testPath, {
      root: roots.repoRoot,
      storageHost: {
        identity: roots.signer,
        storageManager: vintage.storageManager as never,
        // Pin the test's root so the replay can find it; the runner otherwise
        // causes it with Date.now().
        resultCause: vintageRootCause(),
        onPatternInstantiated: (instantiation) => {
          const cellId = String(instantiation.cell.id);
          // Dedupe: a pattern re-materialized during a run is one target.
          seen.set(`${instantiation.identity}/${cellId}`, {
            identity: instantiation.identity,
            symbol: instantiation.symbol,
            main: instantiation.main,
            cellId,
            space: String(instantiation.cell.space),
          });
        },
      },
    });
    // A run that did not complete reached no state to pin, and its cause is
    // its own — a file the runner refused to run this way says so, and reading
    // that as a test failure would blame the pattern for it.
    if (result.error !== undefined) {
      throw new Error(
        `cannot capture ${testKey}: the run did not complete, so it reached ` +
          `no state to record: ${result.error}`,
      );
    }
    // A failed test run would record a state the pattern never legitimately
    // reaches, so refuse rather than pin it.
    const failed = result.results.filter((r) => !r.passed && !r.skipped);
    if (failed.length > 0) {
      throw new Error(
        `cannot capture ${testKey}: its own tests did not pass, so the ` +
          `fixture would record a state the pattern never reaches: ${
            failed.map((r) => `${r.name}: ${r.error}`).join("; ")
          }`,
      );
    }
    if (result.results.length === 0) {
      throw new Error(
        `cannot capture ${testKey}: ${testPath} ran no assertions, so the ` +
          `fixture would hold no test-written state`,
      );
    }
    // The identity that names the fixture is the TEST's, because the test is
    // what was run. That is provenance for the capture as a whole; which
    // PATTERNS it covers is the manifest's job, and a fixture routinely covers
    // several. Deriving the name from one of them would have to pick a
    // privileged one, and there is no principled choice — a test that drives
    // two patterns equally has no primary.
    const program = await resolveLocalProgram(
      (r) => vintage.runtime.harness.resolve(r),
      localProgramOptions(roots, testKey),
    );
    const pattern = await vintage.runtime.patternManager.compilePattern(
      program as never,
      { space: vintage.space as never },
    );
    const ref = vintage.runtime.patternManager.getArtifactEntryRef(pattern);
    if (ref === undefined) {
      throw new Error(
        `cannot capture ${testKey}: compiled test has no identity`,
      );
    }

    // Every instantiation carries its own authored file: the runtime stamps it
    // at module-index time and resolves it through the derivation chain, so a
    // nested sub-pattern names its own source rather than the entry's. Nothing
    // to fill in here.
    const entries = [...seen.values()];
    // Refuse to PIN a fixture holding a root nothing can address, rather than
    // waiting for the replay to fail on it. The replay does fail closed, but it
    // would do so on whoever's PR next ran the gate; catching it here blames the
    // capture that created it, when the cause is still in hand.
    // Keyless instantiations are excluded, not counted as unaddressable. A
    // keyless pattern has no content identity and so no durable pointer — it is
    // session-only by construction and can never be an update target, which is
    // exactly why `isUpgradeTarget` already rejects it. Refusing a whole
    // capture because one appeared would block any test that builds a pattern
    // in hand; `topics/topics.test.tsx` has six.
    // Asked with the SAME question the replay asks — `patternKeyFromMain` —
    // rather than the weaker "starts with a slash". The two disagreeing is the
    // defect this capture guard exists to prevent, and it had drifted back in
    // on a new axis: a pattern instantiated from outside `packages/patterns/`
    // (a `/packages/home-schemas/...` path) satisfied the slash test, captured
    // fine, and then hard-failed EVERY replay with "neither a repo path nor a
    // served pattern route". A capture the gate accepts must be a replay it
    // accepts.
    const unaddressable = entries.filter(
      (e) =>
        !e.identity.startsWith("keyless:") &&
        patternKeyFromMain(e.main, patternsPrefix(roots)) === undefined,
    );
    if (unaddressable.length > 0) {
      throw new Error(
        `cannot capture ${testKey}: ${unaddressable.length} of ` +
          `${entries.length} instantiation(s) cannot be mapped to a file (${
            unaddressable.map((e) => `${e.identity}#${e.symbol}`).join(", ")
          }), so the fixture would record roots the replay cannot map to a file`,
      );
    }
    if (!entries.some(isUpgradeTarget)) {
      throw new Error(
        `cannot capture ${testKey}: the run instantiated no upgradable ` +
          `pattern (${entries.length} instantiation(s), all test patterns), ` +
          `so the fixture would have nothing to replay`,
      );
    }
    await writeVintageManifest(vintage, entries);
    const outDir = `${roots.vintagesRoot}/${testKey}/${tier}`;
    await Deno.mkdir(outDir, { recursive: true });
    const path = `${outDir}/${vintageFileName(stampFor(now), ref.identity)}`;
    // Never write over an existing fixture, in EITHER tier. `captureMissing`
    // already skips a covered key, so reaching this with the file present
    // means something else did — and the cleanup below deletes files on the
    // way out, which must never be somebody else's state. A fixture is deleted
    // deliberately and visibly in a diff, never by an error path.
    //
    // This still holds for the auto tier, whose whole job is to ADD a
    // generation beside the existing ones: the name carries a millisecond
    // stamp AND the identity, so a collision means the same test compiled to
    // the same identity within one millisecond — which is a second capture of
    // a generation already on disk, not a new one.
    //
    // The companion directory is deliberately NOT part of this guard, so the
    // cleanup can remove a LEFTOVER one. A companion directory whose primary
    // file does not exist is not a fixture — nothing enumerates it — and
    // restoring an extra space harms nothing: `restoredSpaces` only feeds a
    // diagnosis, and what gets validated comes from the manifest.
    if (await exists(path)) {
      throw new Error(
        `cannot capture ${testKey}: ${path} already exists, and a capture ` +
          `never overwrites a vintage — delete it deliberately first`,
      );
    }
    try {
      await vintage.snapshot(path);
    } catch (error) {
      // A fixture is written in pieces — the primary file, then one companion
      // store per other space — so a failure part way through leaves a fixture
      // that is missing spaces. That is worse than none at all: `--update` only
      // ever ADDS, so it would skip the key as already covered and the partial
      // would sit there being replayed. Publishing is therefore all-or-nothing.
      await Deno.remove(path).catch(() => {});
      await Deno.remove(vintageCompanionDir(path), { recursive: true })
        .catch(() => {});
      throw error;
    }
    return path;
  } finally {
    await vintage.dispose().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Capture a vintage for every required TEST that has none. */
export async function captureMissing(
  roots: GateRoots,
  testKeys: readonly string[],
  now: Date,
): Promise<{ captured: string[]; problems: string[] }> {
  // PINNED only, because PINNED is what coverage credits. An auto capture is
  // regenerable and pruned by count, so counting one as "already have it"
  // suppresses the pinned capture the gate is asking for and leaves a dead
  // end: the gate reports the pattern uncovered and its own remedy prints
  // "already has a pinned vintage" and changes nothing. That coupling used to
  // hold because this went through `coveredPatternKeys`, which filtered by
  // tier; the filter has to be restated now that it does not.
  const existing = new Set(
    (await collectVintages(roots.vintagesRoot))
      .filter((v) => v.tier === PINNED)
      .map((v) => v.testKey),
  );
  const captured: string[] = [];
  const problems: string[] = [];
  for (const key of testKeys) {
    // `--update` can only ADD: a key already pinned is skipped whichever way it
    // was asked for. Replacing a vintage could replace the very one that would
    // have caught a break.
    if (existing.has(key)) continue;
    // Recorded before the attempt, so a key named twice on one command line is
    // skipped the second time rather than failing the whole run with "already
    // exists, and a capture never overwrites a pinned vintage".
    existing.add(key);
    try {
      captured.push(await captureVintage(roots, key, now));
    } catch (error) {
      // Report every failure rather than dying on the first: a run that
      // captures 9 of 10 and then throws leaves the tree half-seeded with no
      // statement about which one is the problem.
      problems.push(`  ${key}: ${describeError(error)}`);
    }
  }
  return { captured, problems };
}

/**
 * What `--capture-changed` decided and did. The shell only prints it.
 *
 * A discriminated result rather than console output written where the decision
 * is made, so the decision is testable. The alternative was tried: the whole
 * sequence — replay, refuse on red, select, capture, prune — lived in the task
 * shell, where nothing imports it and every branch was uncovered. This module's
 * own header already said where the work belongs.
 */
export type CaptureChangedOutcome =
  | { kind: "refused-red"; failures: readonly ReplayFailure[] }
  | { kind: "all-current"; replayed: number }
  | {
    kind: "captured";
    captured: string[];
    pruned: string[];
    problems: string[];
  };

/**
 * Decide whether a generation is due, capture it, and prune what aged out.
 *
 * Takes the replay it should judge rather than running one, so a caller cannot
 * accidentally capture against a different run than the one it reported — and
 * so the decision can be driven from a fixed replay in a test.
 */
export async function captureChangedGenerations(
  roots: GateRoots,
  replay: {
    failures: readonly ReplayFailure[];
    perVintage: readonly VintageOutcome[];
  },
  now: Date,
): Promise<CaptureChangedOutcome> {
  // Capture from a GREEN tree only. A fixture that failed is not a statement
  // about which generation the world is on, and capturing beside it would mint
  // a generation from a run whose verdict is red — the one moment the
  // repository is least entitled to be recorded as a baseline. This is also
  // what keeps the release process honest without a mid-write rule: a release
  // promotes from a branch that already passed.
  if (replay.failures.length > 0) {
    return { kind: "refused-red", failures: replay.failures };
  }
  const stale = staleTestKeys(replay.perVintage);
  if (stale.length === 0) {
    return { kind: "all-current", replayed: replay.perVintage.length };
  }
  const { captured, problems } = await captureGenerations(roots, stale, now);
  // Prune AFTER capturing, against a RE-READ tree, so the new generations are
  // among the ones counted. Pruning first would keep `keep` old ones and then
  // add another, leaving the tree permanently one over the bound.
  //
  // A prune failure is REPORTED, never thrown. Files have already been written
  // by this point, and throwing here would lose the record of which — leaving
  // fixtures on disk that the command never told anyone about. Over-retention
  // is a disk cost someone can fix by running this again; an unreported
  // capture is a file nobody knows to look at.
  // Deletions are recorded AS THEY HAPPEN, one at a time, rather than assumed
  // all-or-nothing. `removeVintages` deletes in a loop, so a failure part way
  // through leaves the earlier deletions done — and reporting `pruned: []`
  // there loses the record of files this command removed, which is the same
  // loss the surrounding try/catch exists to prevent, in the other direction.
  // Milder, since an auto generation is regenerable, but for one captured
  // minutes ago and never committed nothing else records that it existed.
  const pruned: string[] = [];
  try {
    for (
      const path of autoGenerationsToPrune(
        await collectVintages(roots.vintagesRoot),
      )
    ) {
      await removeVintages([path], roots.vintagesRoot);
      pruned.push(path);
    }
  } catch (error) {
    return {
      kind: "captured",
      captured,
      pruned,
      problems: [...problems, `  retention: ${describeError(error)}`],
    };
  }
  return { kind: "captured", captured, pruned, problems };
}

/** What `--pin` decided and did. The shell only prints it. */
export type PinOutcome =
  | { kind: "needs-one-key"; given: number }
  | { kind: "nothing-to-pin"; testKey: string; vintages: readonly VintageRef[] }
  | { kind: "promoted"; from: string; to: string }
  | { kind: "failed"; from: string; detail: string };

/**
 * Promote a key's newest AUTO generation into the tier retention cannot reach.
 *
 * A failure is RETURNED rather than thrown. A promotion moves a companion
 * directory and then a primary file, so whoever ran it needs to know which of
 * the pair moved — and an uncaught throw buries that under a stack trace of
 * this module's own call frames.
 */
export async function pinNewestGeneration(
  roots: GateRoots,
  named: readonly string[],
): Promise<PinOutcome> {
  if (named.length !== 1) return { kind: "needs-one-key", given: named.length };
  const testKey = named[0];
  const vintages = await collectVintages(roots.vintagesRoot);
  const newest = newestAutoGeneration(vintages, testKey);
  if (newest === undefined) {
    return { kind: "nothing-to-pin", testKey, vintages };
  }
  try {
    return {
      kind: "promoted",
      from: newest.path,
      to: await promoteVintage(newest),
    };
  } catch (error) {
    return {
      kind: "failed",
      from: newest.path,
      detail: describeError(error),
    };
  }
}

/**
 * Capture a fresh AUTO generation for every key whose newest one has aged out.
 *
 * This is what makes the auto tier a real thing rather than a directory name.
 * The selection is automatic — derived from what the replay measured, not from
 * a list — which is the entire distinction from `pinned`: a pinned vintage is
 * one a human deliberately chose to keep, an auto one is whatever the tree
 * happened to need on the day someone ran this.
 *
 * It is a COMMAND, not a CI step. Nothing here pushes a commit; the capture
 * lands in the working tree and is committed like any other change, under the
 * same review-the-diff discipline every other fixture gets. A gate that
 * committed to the repository on its own would be writing the very evidence it
 * grades itself against.
 */
export async function captureGenerations(
  roots: GateRoots,
  testKeys: readonly string[],
  now: Date,
): Promise<{ captured: string[]; problems: string[] }> {
  const captured: string[] = [];
  const problems: string[] = [];
  for (const key of testKeys) {
    try {
      captured.push(await captureVintage(roots, key, now, AUTO));
    } catch (error) {
      problems.push(`  ${key}: ${describeError(error)}`);
    }
  }
  return { captured, problems };
}
