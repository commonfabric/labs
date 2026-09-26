/**
 * What a test surface has to say about itself to join the topology, and
 * the parts every `deno test` suite says the same way.
 *
 * The interface is deliberately small. A suite lists what its runner can
 * be pointed at, recognizes its own records, and builds the command for a
 * chosen subset; everything else — scoring, packing, which lane runs what
 * — is somebody else's problem and stays that way.
 */

import * as path from "@std/path";
import {
  preloadArgument,
  serializeSkipList,
  SKIP_LIST_VARIABLE,
  type SkipList,
  spoolWriteArgument,
  type TestIdentity,
} from "@commonfabric/test-support/records";
import { shuffleFlag, shuffleSeed } from "@commonfabric/test-support/shuffle";
import type { CapabilityId } from "../ci-capabilities.ts";

/** A kind and scope a suite's records may carry. */
export interface RecordSurface {
  kind: string;
  scope: string;
}

/**
 * The smallest thing a suite's runner can be asked to run: a
 * repository-relative test file, a dispatch arm of a shell script, a
 * workspace member whose test task cannot be handed a subset. It holds
 * one identity or many.
 */
export type Unit = string;

/** A unit or exact leaf this configuration deliberately does not run. */
export interface Unavailable {
  unit: Unit;

  /** The one identity inside the unit, when the rest of it still runs. */
  leafName?: string;

  /** Which part of the work it is unavailable for. */
  phase?: string;

  /** Why, in words a person reads. */
  reason: string;
}

/** What walking the working tree found. */
export interface Enumeration {
  units: Unit[];
  unavailable: Unavailable[];
}

/** Whether a record belongs to one unit or to the suite as a whole. */
export type Location = { level: "unit"; unit: Unit } | { level: "suite" };

/** A record as the topology reads it: its identity and where it came from. */
export interface LocatableRecord {
  test: TestIdentity;

  /** The repository-relative source file, where the producer knew it. */
  file?: string;
}

/** One unit, and the identities inside it this invocation is not to run. */
export interface UnitRequest {
  unit: Unit;

  /**
   * Names inside the unit to register as ignored. Empty means run all of
   * them, which is what a unit selected whole asks for.
   */
  skip: readonly string[];
}

/** One JUnit report an invocation writes, and how to read it. */
export interface JUnitOutput {
  path: string;
  kind: string;
  scope: string;

  /** Prefixed onto a report's own file paths to reach the repository root. */
  filePrefix?: string;
}

/** One command a suite runs, and what it leaves behind. */
export interface Invocation {
  command: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  junit?: readonly JUnitOutput[];
}

/** What a suite is given when it builds its commands. */
export interface CommandContext {
  /** The repository root, absolute. */
  root: string;

  /**
   * A directory this batch owns. Reports and skip lists go here, and the
   * lane runner gives every execution of a batch a fresh one so a repeat
   * cannot read the previous run's report.
   */
  outputDir: string;

  /**
   * Where coverage profiles go. A suite whose runner is `deno test` over
   * files writes one directory under it per workspace member, named by
   * {@link coverageMemberDirectory}, so that what one member's tests
   * reached is converted on its own; a suite that builds its own command
   * line writes one directory named for itself.
   * Absent where this batch is not being measured, which is every batch
   * outside the coverage gate and the full run.
   */
  coverageDir?: string;

  /**
   * The workspace members to measure, where only some of them are. A
   * member outside the set runs unmeasured, because coverage costs time
   * and nothing reads a profile no measured set is scored from. Absent
   * means every member this batch runs, which is what the full run asks
   * for.
   */
  measuredMembers?: ReadonlySet<string>;

  /**
   * Where a producer that writes a coverage report of its own puts it.
   * The authored-pattern instrumentation writes LCOV rather than a V8
   * profile, so it has nowhere to put one under `coverageDir`, which
   * holds profiles and is converted from them.
   */
  patternCoverageDir?: string;

  /**
   * What this change is measured against, as a git revision. The gates
   * that hold a file to being appended to compare against it.
   */
  baseRef?: string;

  /**
   * The spool this batch's records go in, absolute. An invocation that
   * loads the registration preload is permitted to write here, which is
   * where the preload leaves the name map that gives each identity its
   * file.
   */
  spoolDir: string;
}

/** One test surface. */
export interface Suite {
  /** Stable identifier. Appears in manifests, logs, and timing records. */
  id: string;

  /** Every kind and scope this suite's records may carry. */
  recordSurfaces: readonly RecordSurface[];

  /** The non-default configuration every one of its units runs in. */
  variant?: string;

  /** Setup this suite needs before it can run. */
  needs: readonly CapabilityId[];

  /**
   * Every unit available in this working tree. Read when the topology is
   * loaded rather than on demand, because `locate` answers from the same
   * reading and has to answer without waiting.
   */
  units: readonly Unit[];

  /** Every unit or exact leaf this configuration deliberately does not run. */
  unavailable: readonly Unavailable[];

  /**
   * The units whose runner runs every identity in them, whatever a lane asks
   * for. Examples are a workspace member whose test task takes no file list, a
   * browser half, a section of a script that brings one environment up for
   * several phases, and a gate that is a single identity.
   *
   * A lane writes no skip list for one of these, because its runner reads none.
   * Every other unit is a file that `deno test` is pointed at, and the
   * registration preload reads the skip list under that file's
   * repository-relative path.
   *
   * `tasks/test-topology.test.ts` checks this list in both directions. A unit
   * left out of it has to be such a file. A unit named in it has to be one its
   * suite writes no skip list for.
   */
  whole: readonly Unit[];

  /**
   * Tree paths this suite accounts for beyond its units. A suite whose
   * units are files needs none; a suite whose units are dispatch arms
   * names the scripts those arms run, so the drift guard can tell that
   * the script is registered rather than missed.
   */
  sources?: readonly string[];

  /**
   * Which units a change makes mandatory. Absent where a unit is a path,
   * because the diff naming that path is the whole of the question. A
   * suite whose units are not paths — a type-check group, a repository
   * gate, a binary — answers it here, from a {@link ReachedBy} for each
   * of them, and a suite that answers it wrongly runs too much or too
   * little rather than reporting anything, so the answer errs toward
   * running.
   *
   * It is absent too where what a unit covers is a large part of the
   * repository, since a declaration for such a unit comes to most
   * changes and places it in most lanes by declaration rather than by
   * what it has caught. Such a unit reaches a lane on what it is worth,
   * or because nothing has a record of it.
   */
  unitsForChange?(changed: ReadonlySet<string>): readonly Unit[];

  /**
   * What this suite's coverage is gated on: one entry per workspace
   * member whose lines a subset of these units is scored over. Absent
   * where nothing here is measured, which is every suite whose runner
   * writes no coverage profile.
   */
  measured?: readonly MeasuredSet[];

  /** Whether a record belongs to one of this suite's units, or to it. */
  locate(record: LocatableRecord): Location | undefined;

  /** The commands that run exactly these units, and their reports. */
  command(
    units: readonly UnitRequest[],
    context: CommandContext,
  ): Promise<Invocation[]>;
}

/**
 * The paths a change reaches something by: a unit whose runner cannot be
 * pointed at a path, a repository gate, a package whose coverage is being
 * measured. Everything a change makes mandatory beyond the diff naming a
 * unit outright is decided from one of these, so that one vocabulary
 * answers the question wherever it comes up.
 *
 * An entry ending in a slash is a directory and covers everything under
 * it; every other entry is one file; `**\/` in the middle of either
 * stands for any run of directories. An entry opening with `!` takes what
 * it names back out.
 *
 * A declaration is bounded rather than exhaustive, and the bounds are
 * what keep this a fraction of what a lane runs rather than the bulk of
 * it: nothing may be reached by a significant share of the tree, and no
 * one file may reach a significant share of the things declaring. So what
 * reads a large part of the repository declares the small and specific
 * part of it, or declares nothing and is left to the score. Declaring too
 * little costs only that; declaring too much spends part of every lane's
 * budget forever.
 */
export type ReachedBy = readonly string[];

/**
 * One suite's units over one workspace member's lines, measured together
 * and gated together.
 *
 * The pair is the unit of the coverage gate because it is the one
 * measurement selection cannot skew: run every unit here and what those
 * tests reached in that member is complete, whatever was chosen anywhere
 * else in the run. Two sets over one member are two numbers and are never
 * added together, since a line one suite covers says nothing about
 * whether the other does.
 */
export interface MeasuredSet {
  /** The workspace member whose lines are counted, repository-relative. */
  member: string;

  /**
   * The paths a change reaches this set by. Reaching it makes every unit
   * below mandatory, which is the same declaration vocabulary that
   * reaches a unit no diff can name, so one mechanism answers "what did
   * this change touch" wherever the question comes up.
   */
  reachedBy: ReachedBy;

  /** Every unit that measures it. */
  units: readonly Unit[];
}

/**
 * The directory one member's coverage profiles go in, under whatever
 * directory a batch was given. Derived rather than declared, so that the
 * suite writing the profiles and the conversion reading them cannot
 * disagree about where they are.
 *
 * A member already holding the separator is refused rather than encoded,
 * because two members would then share one directory and their coverage
 * would be added together silently. No member in the tree has such a
 * name, and the refusal is what keeps that from becoming a measurement
 * nobody can explain.
 */
export function coverageMemberDirectory(member: string): string {
  const path = member.replace(/^\.\//, "");
  if (path.includes("__")) {
    throw new Error(
      `the workspace member ${path} cannot be measured: its name holds ` +
        `the separator that stands for a slash in a coverage directory, ` +
        `so it would share a directory with another member`,
    );
  }
  return path.replaceAll("/", "__");
}

/**
 * Where an invocation over `member` writes its coverage profiles, or
 * nothing where it writes none. A batch with no coverage directory
 * measures nothing, and one measuring only some members measures none of
 * the others.
 *
 * The directory rather than a yes or no, so that a caller cannot ask
 * whether it is measuring and then build the path from a directory the
 * answer said nothing about.
 */
export function measuringInto(
  context: Pick<CommandContext, "coverageDir" | "measuredMembers">,
  member: string,
): string | undefined {
  if (context.coverageDir === undefined) return undefined;
  const normalized = member.replace(/^\.\//, "");
  if (context.measuredMembers?.has(normalized) === false) return undefined;
  return path.join(context.coverageDir, coverageMemberDirectory(normalized));
}

/**
 * Whether one entry names a path. `**\/` stands for any run of
 * directories, so the segments on either side of it are matched against
 * the ends of the path rather than against the whole of it.
 */
export function entryNames(entry: string, at: string): boolean {
  const wildcard = entry.indexOf("**/");
  if (wildcard === -1) {
    return entry.endsWith("/") ? at.startsWith(entry) : at === entry;
  }
  const above = entry.slice(0, wildcard);
  if (!at.startsWith(above)) return false;
  const below = entry.slice(wildcard + "**/".length);
  const rest = `/${at.slice(above.length)}`;
  return below.endsWith("/")
    ? rest.includes(`/${below}`)
    : rest.endsWith(`/${below}`);
}

/** Whether a declaration comes to any of the changed paths. */
export function reachedByChange(
  reachedBy: ReachedBy,
  changed: ReadonlySet<string>,
): boolean {
  const taken = reachedBy.filter((entry) => !entry.startsWith("!"));
  const dropped = reachedBy
    .filter((entry) => entry.startsWith("!"))
    .map((entry) => entry.slice(1));
  for (const at of changed) {
    if (dropped.some((entry) => entryNames(entry, at))) continue;
    if (taken.some((entry) => entryNames(entry, at))) return true;
  }
  return false;
}

/**
 * Whether an identity is one this suite could have produced: its kind and
 * scope are among the declared surfaces, and its variant is exactly the
 * suite's. An unmarked record therefore reaches only a default suite, and
 * a marked one only the suite carrying that marker.
 */
export function claimsIdentity(
  suite: Pick<Suite, "recordSurfaces" | "variant">,
  test: TestIdentity,
): boolean {
  if (test.v !== suite.variant) return false;
  return suite.recordSurfaces.some(
    (surface) => surface.kind === test.k && surface.scope === test.s,
  );
}

/**
 * The units a configuration does not run at all. An entry naming a leaf
 * leaves its unit available, because every other identity in that unit
 * still runs; only an entry naming no leaf takes the unit out.
 */
export function unavailableUnits(
  suite: Pick<Suite, "unavailable">,
): Set<Unit> {
  return new Set(
    suite.unavailable
      .filter((entry) => entry.leafName === undefined)
      .map((entry) => entry.unit),
  );
}

/** The leaves a configuration does not run, by the unit holding them. */
export function unavailableLeaves(
  suite: Pick<Suite, "unavailable">,
): Map<Unit, string[]> {
  const leaves = new Map<Unit, string[]>();
  for (const entry of suite.unavailable) {
    if (entry.leafName === undefined) continue;
    leaves.set(entry.unit, [
      ...leaves.get(entry.unit) ?? [],
      entry.leafName,
    ]);
  }
  return leaves;
}

/** One entry of a configuration's skip registry, as the topology reads it. */
export interface ConfiguredSkip {
  /** The file, relative to the package the suite runs in. */
  file: string;

  /** The one leaf inside it that does not run, where only one does not. */
  step?: string;

  /** Which part of the work it is unavailable for. */
  phase?: string;

  /** Why, in words a person reads. */
  reason: string;
}

/**
 * What a configuration's skip registry says, as units and leaves.
 *
 * A whole-file entry leaves the file out of the variant suite's units. A
 * step-level entry leaves the file in and names the one leaf that does
 * not run, so that leaf is excluded from the unknown-identity rule while
 * every other identity in the file behaves normally.
 */
export function unavailableFrom(
  skips: readonly ConfiguredSkip[],
  packageDir: string,
): { excluded: Set<Unit>; unavailable: Unavailable[] } {
  const excluded = new Set<Unit>();
  const unavailable: Unavailable[] = [];
  for (const skip of skips) {
    const unit = `${packageDir}/${skip.file}`;
    if (skip.step === undefined) excluded.add(unit);
    unavailable.push({
      unit,
      ...(skip.step === undefined ? {} : { leafName: skip.step }),
      ...(skip.phase === undefined ? {} : { phase: skip.phase }),
      reason: skip.reason,
    });
  }
  return { excluded, unavailable };
}

/**
 * What an invocation takes to record: the preload, and the write
 * permission it needs to leave its name map in the batch's spool. The
 * permission is left out where the flags already grant one, since
 * appending a path list to a blanket grant either ends the run or cuts
 * the grant down to that list; `spoolWriteArgument` says which.
 */
export function recordingArguments(
  flags: readonly string[],
  context: CommandContext,
): string[] {
  const write = spoolWriteArgument(flags, context.spoolDir);
  return write === undefined ? [preloadArgument()] : [preloadArgument(), write];
}

/**
 * The flag every `deno test` a suite builds shuffles by. The seed is the
 * one the commit under test was committed on unless the environment names
 * another, and the runner that starts a run puts the seed it settled on
 * in the environment, so every invocation of that run takes the same one.
 */
export function shuffleArguments(): string[] {
  return [shuffleFlag(shuffleSeed())];
}

/** Writes a batch's skip list where its invocations will read it. */
export async function writeSkipList(
  skipListPath: string,
  skips: SkipList,
): Promise<void> {
  if (Object.keys(skips).length === 0) return;
  await Deno.mkdir(path.dirname(skipListPath), { recursive: true });
  await Deno.writeTextFile(skipListPath, serializeSkipList(skips));
}

/** The skip list a set of unit requests comes to. */
export function skipListOf(units: readonly UnitRequest[]): SkipList {
  const skips: SkipList = {};
  for (const request of units) {
    if (request.skip.length === 0) continue;
    skips[request.unit] = [...request.skip];
  }
  return skips;
}

/** One package's share of a `deno test` suite. */
export interface FilePart {
  /** Where `deno test` runs, repository-relative. */
  packageDir: string;

  /** Flags between `deno test` and the file list. */
  flags: readonly string[];

  env?: Record<string, string>;

  /** How the report this part writes is read back. */
  junit: Omit<JUnitOutput, "path">;

  /** Every available test file of this part, repository-relative. */
  files: readonly string[];

  /** Every file or leaf this configuration deliberately does not run. */
  unavailable?: readonly Unavailable[];

  /**
   * The unit a record belongs to, where that is not the `file` the
   * producer recorded. A pattern test's identity is its path, so its
   * suite answers from the name instead.
   */
  unitOf?: (record: LocatableRecord) => string | undefined;
}

/** What a suite of `deno test` files is built from. */
export interface FileSuiteOptions {
  id: string;
  variant?: string;
  needs: readonly CapabilityId[];

  /**
   * The packages it spans. One runner does not imply one scope: the
   * package integration command spans three packages, each with its own
   * directory and its own record scope.
   */
  parts: readonly FilePart[];

  /**
   * Whether this suite's runner instruments authored patterns, which
   * write a coverage report of their own rather than a V8 profile. A
   * suite that says so is handed `CF_PATTERN_COVERAGE_DIR` wherever the
   * batch is measured.
   */
  patternCoverage?: boolean;

  /** What this suite's coverage is gated on, where anything is. */
  measured?: readonly MeasuredSet[];
}

/**
 * A suite whose runner is `deno test` over a set of files. Most of the
 * topology is this shape, and what differs between them is the files, the
 * flags, and what their records are called.
 */
export function fileSuite(options: FileSuiteOptions): Suite {
  const units: string[] = [];
  const partOf = new Map<string, FilePart>();
  const recordSurfaces: RecordSurface[] = [];
  const unavailable: Unavailable[] = [];
  for (const part of options.parts) {
    recordSurfaces.push({ kind: part.junit.kind, scope: part.junit.scope });
    for (const file of part.files) {
      units.push(file);
      partOf.set(file, part);
    }
    unavailable.push(...part.unavailable ?? []);
  }
  const surfaces = {
    recordSurfaces,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  };
  return {
    id: options.id,
    recordSurfaces,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
    needs: options.needs,
    units,
    unavailable,
    // Every unit here is a file the command names. The preload reads the skip
    // list under the same path.
    whole: [],
    ...(options.measured === undefined ? {} : { measured: options.measured }),

    locate(record) {
      if (!claimsIdentity(surfaces, record.test)) return undefined;
      for (const part of options.parts) {
        if (part.junit.scope !== record.test.s) continue;
        if (part.junit.kind !== record.test.k) continue;
        const unit = (part.unitOf ?? ((r: LocatableRecord) => r.file))(record);
        if (unit !== undefined && partOf.get(unit) === part) {
          return { level: "unit", unit };
        }
      }
      return undefined;
    },

    async command(requests, context) {
      const byPart = new Map<FilePart, UnitRequest[]>();
      for (const request of requests) {
        const part = partOf.get(request.unit);
        if (part === undefined) continue;
        const group = byPart.get(part);
        if (group === undefined) byPart.set(part, [request]);
        else group.push(request);
      }
      const invocations: Invocation[] = [];
      for (const [part, group] of byPart) {
        const cwd = path.resolve(context.root, part.packageDir);
        const slug = `${options.id}-${part.junit.scope.replaceAll("/", "__")}`;
        const junitPath = path.join(context.outputDir, `${slug}.xml`);
        const skips = skipListOf(group);
        // A leaf this configuration declares unavailable does not run,
        // whether or not the packer chose the rest of its unit. Saying so
        // in the skip list is what makes the declaration the thing that
        // stops it, rather than the test file remembering to guard
        // itself.
        for (const [unit, leaves] of unavailableLeaves({ unavailable })) {
          if (!group.some((request) => request.unit === unit)) continue;
          skips[unit] = [...new Set([...skips[unit] ?? [], ...leaves])];
        }
        const env: Record<string, string> = { ...part.env };
        if (Object.keys(skips).length > 0) {
          const skipListPath = path.join(
            context.outputDir,
            `${slug}.skip.json`,
          );
          await writeSkipList(skipListPath, skips);
          env[SKIP_LIST_VARIABLE] = skipListPath;
        }
        const measuring = measuringInto(context, part.packageDir);
        if (measuring !== undefined) env.DENO_COVERAGE_DIR = measuring;
        if (
          options.patternCoverage === true &&
          context.patternCoverageDir !== undefined
        ) {
          env.CF_PATTERN_COVERAGE_DIR = context.patternCoverageDir;
        }
        invocations.push({
          command: [
            Deno.execPath(),
            "test",
            ...part.flags,
            ...shuffleArguments(),
            ...recordingArguments(part.flags, context),
            `--junit-path=${junitPath}`,
            ...group.map((request) =>
              path.relative(cwd, path.resolve(context.root, request.unit))
            ),
          ],
          cwd,
          env,
          junit: [{ path: junitPath, ...part.junit }],
        });
      }
      return invocations;
    },
  };
}
