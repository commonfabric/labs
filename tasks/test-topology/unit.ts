/**
 * The workspace's unit tests, which is where almost all of the
 * repository's identities live.
 *
 * The half read is a member's `deno-test` task where it declares one and
 * its `test` task otherwise, followed by that half's own dependencies,
 * taking the first that reads as a single `deno test` or as the sharded
 * runner's wrapper around one. A dependency of a dependency is not
 * reached. A member with one is
 * enumerated a file at a time, so a lane can be asked for a few files out
 * of a package holding hundreds. A member with none — a runner script of its
 * own, two commands joined by `&&`, its own import map — is one unit that runs
 * whole, and a member whose only test task announces it has no tests is left
 * out of the enumeration. A unit that runs whole runs every test of the member
 * whatever a lane asks for. It is listed in `whole`, because the skip list is
 * keyed by the file that registered a test, and a member's directory is not
 * such a file.
 *
 * `packages/runner` is a suite of its own rather than one more member.
 * Nothing about how it runs differs; what differs is what its
 * measurements mean. In the reference build the workspace members
 * recorded about one and a half seconds of measured tests for every
 * second of test step, and the runner package about seven tenths, so one
 * fitted correction cannot describe both.
 */

import * as path from "@std/path";
import { parse as parseJsonc } from "@std/jsonc";
import { SKIP_LIST_VARIABLE } from "@commonfabric/test-support/records";
import {
  memberTasks,
  memberTestFiles,
  type ParsedTestTask,
  testBatches,
  unmatchedGlobs,
} from "./deno-task.ts";
import {
  claimsIdentity,
  type CommandContext,
  type Invocation,
  type LocatableRecord,
  type Location,
  type MeasuredSet,
  measuringInto,
  recordingArguments,
  type RecordSurface,
  shuffleArguments,
  skipListOf,
  type Suite,
  type UnitRequest,
  writeSkipList,
} from "./suite.ts";
import type { CapabilityId } from "../ci-capabilities.ts";
import { EXCLUDED_FROM_COVERAGE_GATE } from "../test-selection/policy.ts";

/** The member the runner suite owns; every other member is the other one. */
const RUNNER_MEMBER = "./packages/runner";

/** How a browser half is named as a unit, so it cannot be read as a file. */
const BROWSER_SUFFIX = "#browser-test";

/** What one member contributes to a unit suite. */
interface Member {
  /** As the workspace lists it, leading `./` included. */
  memberPath: string;

  /** The record scope its tests carry. */
  scope: string;

  /** Repository-relative test files, when the member is read one at a time. */
  files: string[];

  /** The task taken apart, when its files are selectable. */
  run?: ParsedTestTask;

  /** The task that runs the Deno-only half, for a member that runs whole. */
  denoTestTask: string;

  /** Whether the member has a Deno-only half to run at all. */
  denoHalf: boolean;

  /** Whether the member also names a browser half. */
  browserTest: boolean;

  /**
   * The test files the Deno-only half declines, which is what the
   * browser half runs. The browser half is one unit whatever it holds,
   * so these are files the topology accounts for without enumerating.
   */
  browserFiles: string[];
}

/** The record scope of a member: its path with `packages/` taken off. */
export function memberScope(memberPath: string): string {
  return memberPath.replace(/^\.\//, "").replace(/^packages\//, "");
}

/** The members the workspace declares. */
async function workspaceMembers(root: string): Promise<string[]> {
  const manifest = parseJsonc(
    await Deno.readTextFile(path.join(root, "deno.jsonc")),
  ) as { workspace: string[] };
  return manifest.workspace;
}

/** Reads one member, or nothing where the member has no tests. */
async function readMember(
  root: string,
  memberPath: string,
): Promise<Member | undefined> {
  const memberDir = path.resolve(root, memberPath);
  const tasks = await memberTasks(memberDir);
  if (!tasks.present) return undefined;
  const member: Member = {
    memberPath,
    scope: memberScope(memberPath),
    files: [],
    denoTestTask: tasks.denoTestTask ?? "test",
    denoHalf: tasks.denoHalf,
    browserTest: tasks.browserTest,
    browserFiles: [],
  };
  if (tasks.denoTest === undefined) return member;
  // A glob giving files flags of their own that names no file would leave
  // a renamed file running under the flags of the rest.
  const unmatched = await unmatchedGlobs(memberDir, tasks.denoTest.paths, [
    ...tasks.denoTest.serial,
    ...tasks.denoTest.allAccess,
  ]);
  if (unmatched.length > 0) {
    throw new Error(
      `No test file in \`${memberPath}\` matches ${
        unmatched.map((glob) => `\`${glob}\``).join(", ")
      }.`,
    );
  }
  // Normalized against the repository root, because a member's task may
  // name a file outside its own directory and a unit is a path anyone
  // else can resolve.
  const relative = (file: string) =>
    path.relative(root, path.resolve(memberDir, file));
  member.files = (await memberTestFiles(memberDir, tasks.denoTest))
    .map(relative);
  member.run = tasks.denoTest;
  if (member.browserTest) {
    // What the Deno-only half ignores is what the browser half runs. A
    // member that splits its halves by a name — `*.browser.test.ts` — is
    // otherwise a member whose browser files no suite claims, because
    // the browser unit is one unit rather than one per file. The same
    // paths the task names, read without its ignores, so the difference
    // is what an ignore took out rather than what the task never looked
    // at.
    const everything = new Set(
      (await memberTestFiles(memberDir, { ...tasks.denoTest, ignores: [] }))
        .map(relative),
    );
    for (const file of member.files) everything.delete(file);
    member.browserFiles = [...everything].sort();
  }
  return member;
}

/** A member's own unit, which is the whole of it. */
function wholeUnit(member: Member): string {
  return member.memberPath.replace(/^\.\//, "");
}

/**
 * The measured set one member carries, or nothing where it carries none.
 *
 * A set holds the units of the member's Deno-only half and never its
 * browser unit, so that adding a test needing a browser costs a member
 * nothing here. The browser unit therefore writes no coverage into the
 * set's directory either: it is not one of the set's units, so counting
 * what it reached would make the set's number depend on whether a lane
 * selected it.
 *
 * The paths that reach the set are the member's own tree, less the trees
 * of any member nested inside it, which belong to that member's set
 * instead.
 */
function measuredSetOf(
  member: Member,
  members: readonly Member[],
): MeasuredSet | undefined {
  const memberPath = wholeUnit(member);
  // The gate is over `packages/`. `tasks` is one coverage group rather
  // than a tree of them, and `scripts` is outside coverage accounting.
  if (!memberPath.startsWith("packages/")) return undefined;
  if (EXCLUDED_FROM_COVERAGE_GATE.has(memberPath)) return undefined;
  const units = member.files.length > 0
    ? member.files
    : member.denoHalf
    ? [memberPath]
    : [];
  if (units.length === 0) return undefined;
  const nested = members
    .map(wholeUnit)
    .filter((other) => other.startsWith(`${memberPath}/`))
    .map((other) => `!${other}/`);
  return {
    member: memberPath,
    reachedBy: [`${memberPath}/`, ...nested],
    units,
  };
}

/**
 * Builds a suite over a set of members. The two unit suites differ only
 * in which members they hold and what they are called, so they are one
 * implementation with two callers.
 */
function unitSuite(
  id: string,
  needs: readonly CapabilityId[],
  members: readonly Member[],
): Suite {
  const byUnit = new Map<string, Member>();
  const byScope = new Map<string, Member>();
  const units: string[] = [];
  const whole: string[] = [];
  for (const member of members) {
    byScope.set(member.scope, member);
    if (member.files.length > 0) {
      for (const file of member.files) {
        units.push(file);
        byUnit.set(file, member);
      }
    } else if (member.denoHalf) {
      // A member with no Deno-only half has nothing for a `deno task
      // test` to run, so it contributes only its browser unit below.
      units.push(wholeUnit(member));
      byUnit.set(wholeUnit(member), member);
      whole.push(wholeUnit(member));
    }
    if (member.browserTest) {
      const unit = `${wholeUnit(member)}${BROWSER_SUFFIX}`;
      units.push(unit);
      byUnit.set(unit, member);
      whole.push(unit);
    }
  }

  const recordSurfaces: RecordSurface[] = [];
  for (const member of members) {
    recordSurfaces.push({ kind: "unit", scope: member.scope });
    recordSurfaces.push({ kind: "browser", scope: member.scope });
  }

  const sources = members.flatMap((member) => member.browserFiles);
  const measured = members
    .map((member) => measuredSetOf(member, members))
    .filter((set): set is MeasuredSet => set !== undefined);

  return {
    id,
    recordSurfaces,
    needs,
    units,
    unavailable: [],
    whole,
    ...(sources.length === 0 ? {} : { sources }),
    ...(measured.length === 0 ? {} : { measured }),

    locate(record: LocatableRecord): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      // Every surface this suite claims names a member's scope, so a
      // record it claims always has one.
      const member = byScope.get(record.test.s)!;
      // The browser half records under its own kind, and it is one unit
      // whether or not the Deno-only half is read a file at a time.
      if (record.test.k === "browser" && member.browserTest) {
        return { level: "unit", unit: `${wholeUnit(member)}${BROWSER_SUFFIX}` };
      }
      if (member.files.length === 0) {
        return member.denoHalf
          ? { level: "unit", unit: wholeUnit(member) }
          : undefined;
      }
      // A file the store carries but the tree no longer holds is a test
      // that moved. It is not this suite's to place, and the identity is
      // unknown, which is what makes it run.
      if (record.file !== undefined && byUnit.has(record.file)) {
        return { level: "unit", unit: record.file };
      }
      return undefined;
    },

    async command(
      requests: readonly UnitRequest[],
      context: CommandContext,
    ): Promise<Invocation[]> {
      const byMember = new Map<Member, UnitRequest[]>();
      for (const request of requests) {
        const member = byUnit.get(request.unit);
        if (member === undefined) continue;
        const group = byMember.get(member);
        if (group === undefined) byMember.set(member, [request]);
        else group.push(request);
      }
      const invocations: Invocation[] = [];
      for (const [member, group] of byMember) {
        const memberDir = path.resolve(context.root, member.memberPath);
        const slug = member.scope.replaceAll("/", "__");
        const whole = wholeUnit(member);
        const env: Record<string, string> = { ENV: "test", ...member.run?.env };
        // Only the Deno-only half writes into the member's measured-set
        // directory. The browser unit is not one of the set's units, so
        // its profiles would make the set's number depend on whether a
        // lane happened to select it, which is the one thing the set
        // exists to rule out.
        const measured = measuringInto(context, whole);
        const denoEnv = measured === undefined
          ? env
          : { ...env, DENO_COVERAGE_DIR: measured };
        const files: UnitRequest[] = [];
        let runsWhole = false;
        let runsBrowser = false;
        for (const request of group) {
          if (request.unit === whole) runsWhole = true;
          else if (request.unit === `${whole}${BROWSER_SUFFIX}`) {
            runsBrowser = true;
          } else files.push(request);
        }
        if (runsWhole) {
          // A member whose task cannot be handed a file list runs the task,
          // which runs every test of the member. This unit is the member's own
          // directory, so no skip list keyed by test file can name anything in
          // it.
          invocations.push({
            command: [Deno.execPath(), "task", member.denoTestTask],
            cwd: memberDir,
            env: denoEnv,
          });
        }
        if (files.length > 0 && member.run !== undefined) {
          // Keyed by the path the member's own task would name the file by,
          // which is what the batches are drawn up over.
          const byFile = new Map(files.map((request) => [
            path.relative(memberDir, path.resolve(context.root, request.unit)),
            request,
          ]));
          const batches = testBatches(member.run, [...byFile.keys()]);
          for (const [index, batch] of batches.entries()) {
            const name = index === 0 ? slug : `${slug}.${index}`;
            const junitPath = path.join(context.outputDir, `${name}.xml`);
            const requests = batch.files.map((file) => byFile.get(file)!);
            invocations.push({
              command: [
                Deno.execPath(),
                "test",
                ...batch.flags,
                ...shuffleArguments(),
                ...recordingArguments(batch.flags, context),
                `--junit-path=${junitPath}`,
                ...batch.files,
              ],
              cwd: memberDir,
              env: { ...denoEnv, ...await skipEnv(context, name, requests) },
              junit: [{
                path: junitPath,
                kind: "unit",
                scope: member.scope,
                filePrefix: member.memberPath.replace(/^\.\//, ""),
              }],
            });
          }
        }
        if (runsBrowser) {
          invocations.push({
            command: [Deno.execPath(), "task", "browser-test"],
            cwd: memberDir,
            env,
          });
        }
      }
      return invocations;
    },
  };
}

/**
 * Writes a batch's skip list and names it in the environment, or leaves
 * the environment alone where nothing is skipped.
 */
async function skipEnv(
  context: CommandContext,
  slug: string,
  requests: readonly UnitRequest[],
): Promise<Record<string, string>> {
  const skips = skipListOf(requests);
  if (Object.keys(skips).length === 0) return {};
  const skipListPath = path.join(context.outputDir, `${slug}.skip.json`);
  await writeSkipList(skipListPath, skips);
  return { [SKIP_LIST_VARIABLE]: skipListPath };
}

/** The two unit suites, read from the working tree. */
export async function loadUnitSuites(root: string): Promise<Suite[]> {
  const members: Member[] = [];
  let runner: Member | undefined;
  for (const memberPath of await workspaceMembers(root)) {
    const member = await readMember(root, memberPath);
    if (member === undefined) continue;
    if (memberPath === RUNNER_MEMBER) runner = member;
    else members.push(member);
  }
  const suites = [
    unitSuite("workspace-unit", ["deno", "fuse", "browser"], members),
  ];
  if (runner !== undefined) {
    suites.push(unitSuite("runner-unit", ["deno"], [runner]));
  }
  return suites;
}
