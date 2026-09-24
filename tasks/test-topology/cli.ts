/**
 * The command-line integration suites.
 *
 * All three record under one surface, kind `integration` and scope `cli`,
 * and what tells them apart is the name a record carries. The dispatch
 * script's steps belong to `cli-core`, the FUSE script's to `cli-fuse`,
 * and the Deno-based tests to `cli-deno`, which is an ordinary `deno
 * test` file suite.
 *
 * The two shell suites share a shape rather than a script. Each is one
 * script with a `case "$SECTION" in` table, dispatched by an environment
 * variable, whose arms run work that records itself. What differs is how
 * far an arm sits from the records it causes — `integration.sh` names
 * each step where it begins it, and `fuse-exec.sh` names a phase whose
 * function announces the sentence the record carries — and which arms a
 * lane may be pointed at. So the table is read once, the attribution and
 * the command are written once, and each suite supplies the two answers
 * that are its own.
 */

import * as path from "@std/path";
import type { CapabilityId } from "../ci-capabilities.ts";
import {
  claimsIdentity,
  fileSuite,
  type Invocation,
  type Location,
  type Suite,
  type UnitRequest,
} from "./suite.ts";

/** Where the scripts live, repository-relative. */
const CLI_DIR = "packages/cli/integration";

/** The one record surface all three suites share. */
const SURFACE = [{ kind: "integration", scope: "cli" }] as const;

/** Where a script's dispatch runs, repository-relative. */
const PACKAGE_DIR = "packages/cli";

/**
 * The arms of a script's `case "$SECTION" in` table, against whatever the
 * reader finds in each arm's body, in the order the table writes them.
 *
 * The unknown-section arm reports rather than naming work, and an arm the
 * reader finds nothing in names none, so neither becomes a unit that
 * would then run whatever the script does with it.
 */
export function dispatchArms(
  script: string,
  read: (body: string) => readonly string[],
): Map<string, string[]> {
  const arms = new Map<string, string[]>();
  const open = script.indexOf('case "$SECTION" in');
  if (open < 0) return arms;
  const table = script.slice(open, script.indexOf("\nesac", open));
  for (
    const [, arm, body] of table.matchAll(/^ {2}(\S+)\)\n(.*?)^ {4};;$/gms)
  ) {
    if (arm === "*") continue;
    const found = read(body!);
    if (found.length > 0) arms.set(arm!, [...found]);
  }
  return arms;
}

/** The steps an arm of the dispatch script begins itself. */
function stepsIn(body: string): string[] {
  return [...body.matchAll(/^ {4}cf_test_step_begin (\S+)$/gm)]
    .map((found) => found[1]!);
}

/** What a suite over one sectioned script is built from. */
interface SectionSuiteOptions {
  id: string;
  needs: readonly CapabilityId[];

  /** The script, which is also what its records are named for. */
  script: string;

  /** The variable its dispatch reads, which the command sets. */
  variable: string;

  /** Each arm of its table, against the records that arm runs. */
  arms: ReadonlyMap<string, readonly string[]>;

  /**
   * What to call the unit an arm becomes, or nothing for an arm no lane
   * may be pointed at. A group arm exists for people running the script
   * by hand, and making one a unit would run work another unit already
   * holds.
   */
  unitOf(arm: string, records: readonly string[]): string | undefined;

  /** Scripts beside it that record one identity each and run as themselves. */
  standalone?: readonly string[];

  /** Tree paths the suite accounts for. */
  sources: readonly string[];
}

/**
 * A suite whose runner is one shell script that takes a section.
 *
 * Which arms are units is the suite's own answer, and everything after it
 * follows from that answer alone. A record exactly one unit runs belongs
 * to that unit. A record several units run belongs to none of them: it is
 * setup they share — a mount, a piece, the files a phase puts in place —
 * and charging it to one of them would count it against work the others
 * pay for too, so it measures the suite. A record no unit runs is claimed
 * by nothing, which is the drift guard's business to report: a step the
 * script begins that no arm runs alone is a step nothing can be asked to
 * run.
 */
function sectionSuite(options: SectionSuiteOptions): Suite {
  const armOf = new Map<string, string>();
  const units: string[] = [];
  /** Every unit that runs each record, by the record's own name. */
  const running = new Map<string, string[]>();
  for (const [arm, records] of options.arms) {
    const unit = options.unitOf(arm, records);
    if (unit === undefined) continue;
    units.push(unit);
    armOf.set(unit, arm);
    for (const record of records) {
      const name = `${options.script} ${record}`;
      running.set(name, [...running.get(name) ?? [], unit]);
    }
  }
  // A script beside the dispatch one, which takes no section and records
  // under its own name. It is its own unit and its own record.
  for (const name of options.standalone ?? []) {
    units.push(name);
    armOf.set(name, "");
    running.set(name, [name]);
  }
  units.sort();

  return {
    id: options.id,
    recordSurfaces: SURFACE,
    needs: options.needs,
    units,
    unavailable: [],
    // A unit here is an arm of a script, and the script runs a whole section at
    // a time. An arm with one step is one identity. An arm with several steps
    // brings one environment up and runs all of them in it.
    whole: units,
    sources: [...options.sources].sort(),
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces: SURFACE }, record.test)) {
        return undefined;
      }
      const name = record.test.n;
      // The script's own whole-invocation record. It measures the
      // invocation rather than any one unit, and the same identity
      // appears whichever arm dispatched it, so summing it with the
      // records inside it would count that work twice.
      if (name === options.script) return { level: "suite" };
      const holders = running.get(name);
      if (holders === undefined) return undefined;
      return holders.length === 1
        ? { level: "unit", unit: holders[0]! }
        : { level: "suite" };
    },
    command(requests: readonly UnitRequest[], context): Promise<Invocation[]> {
      const cwd = path.join(context.root, PACKAGE_DIR);
      const invocations: Invocation[] = [];
      for (const request of requests) {
        const arm = armOf.get(request.unit);
        if (arm === undefined) continue;
        invocations.push(
          arm === "" ? { command: [`./integration/${request.unit}`], cwd } : {
            command: [`./integration/${options.script}`],
            cwd,
            env: { [options.variable]: arm },
          },
        );
      }
      return Promise.resolve(invocations);
    },
  };
}

/** The script whose arms are this package's integration steps. */
const DISPATCH_SCRIPT = "integration.sh";

/** The FUSE script, whose arms are groups of phases over one mount. */
const FUSE_SCRIPT = "fuse-exec.sh";

/** The arm that runs everything, which exists for hand runs. */
const WHOLE_SCRIPT_ARM = "all";

/** The scripts beside the dispatch one that record one identity each. */
const STANDALONE_SCRIPTS = ["acl.sh"];

/**
 * The dispatch suite. A unit is one arm of `integration.sh` that runs one
 * step, or one of the standalone scripts beside it.
 *
 * The step is what the unit is named for, because a unit holding one
 * record is that record as far as the store is concerned, and the store
 * is what the manifest keys on. The arm that runs it is what the command
 * reaches for.
 */
async function cliCoreSuite(root: string): Promise<Suite> {
  const script = await Deno.readTextFile(
    path.join(root, CLI_DIR, DISPATCH_SCRIPT),
  );
  // The scripts this suite runs: the dispatch script, the standalone
  // scripts beside it, and whichever scripts its steps call. Read from
  // the script rather than listed, so a step that starts calling another
  // one accounts for it without anybody remembering to say so. A script
  // nothing calls is left unclaimed on purpose — that is a test surface
  // running nowhere, and the drift guard exists to say so.
  const sources = new Set<string>([`${CLI_DIR}/${DISPATCH_SCRIPT}`]);
  for (const name of STANDALONE_SCRIPTS) sources.add(`${CLI_DIR}/${name}`);
  for (const [called] of script.matchAll(/(?:^|[\s"'/])([\w.-]+\.sh)\b/g)) {
    const name = called.replace(/^[\s"'/]/, "");
    if (name === FUSE_SCRIPT) continue;
    try {
      await Deno.stat(path.join(root, CLI_DIR, name));
      sources.add(`${CLI_DIR}/${name}`);
    } catch {
      // A name that is not a script beside this one, such as a path the
      // script builds for something it writes.
    }
  }
  return sectionSuite({
    id: "cli-core",
    needs: ["deno", "toolshed", "cf", "jq"],
    script: DISPATCH_SCRIPT,
    variable: "CF_CLI_INTEGRATION_SECTION",
    arms: dispatchArms(script, stepsIn),
    // An arm that runs one step is that step's unit; an arm that runs
    // several is a group, and the steps in it have arms of their own.
    unitOf: (_arm, records) =>
      records.length === 1 ? `${DISPATCH_SCRIPT} ${records[0]}` : undefined,
    standalone: STANDALONE_SCRIPTS,
    sources: [...sources],
  });
}

/** How a FUSE phase records: the sentences its function announces. */
export type PhaseAnnouncements = Map<string, string[]>;

/**
 * The sentences each phase of the FUSE script announces itself with,
 * which are the names its records carry.
 *
 * More than one where a phase announces conditionally, and every one of
 * them names that phase. Read from the phase functions rather than from
 * the dispatch table, because the two name a phase differently: the table
 * names it by identifier, and the record carries the sentence.
 */
export function phaseAnnouncements(script: string): PhaseAnnouncements {
  const announcements: PhaseAnnouncements = new Map();
  const functions = script.split(/^run_([a-z0-9_]+)\(\) \{$/m);
  for (let i = 1; i < functions.length; i += 2) {
    announcements.set(
      functions[i]!.replaceAll("_", "-"),
      [...functions[i + 1]!.matchAll(/^\s*phase "([^"]*)"/gm)]
        .map((found) => found[1]!),
    );
  }
  return announcements;
}

/** The phases an arm of the FUSE script selects. */
function phasesIn(body: string): string[] {
  const listed = body.match(/PHASES=\(([^)]*)\)/s)?.[1];
  return listed === undefined
    ? []
    : listed.split(/\s+/).filter((word) => word.length > 0);
}

/** The phases the FUSE script runs whichever arm was asked for. */
function preludeOf(script: string): string[] {
  return script.match(/^PRELUDE=\(([^)]*)\)/m)?.[1]
    ?.split(/\s+/).filter((word) => word.length > 0) ?? [];
}

/**
 * The FUSE script, whose units are the sections of it that stand alone.
 *
 * A section is a group of phases over one mount rather than a phase on
 * its own: the mount, the daemon and the piece cost more than every phase
 * together, and each section needs all three. So a phase is an identity
 * and a section is what a lane can be pointed at, and there is nothing
 * finer for the topology to reach.
 *
 * The prelude belongs to every arm, because every arm runs it. Saying so
 * here rather than treating it as a case of its own is what puts its
 * phases under several units, and the shared rule then makes them the
 * suite's — which is the same answer, reached the same way, as for the
 * phase that puts the callable files in place ahead of three sections.
 */
function cliFuseSuite(script: string): Suite {
  const prelude = preludeOf(script);
  const announced = phaseAnnouncements(script);
  const arms = new Map<string, string[]>();
  for (const [arm, phases] of dispatchArms(script, phasesIn)) {
    arms.set(
      arm,
      [...prelude, ...phases].flatMap((phase) => announced.get(phase) ?? []),
    );
  }
  return sectionSuite({
    id: "cli-fuse",
    needs: ["deno", "toolshed", "cf", "fuse"],
    script: FUSE_SCRIPT,
    variable: "CF_FUSE_INTEGRATION_SECTION",
    arms,
    unitOf: (arm) =>
      arm === WHOLE_SCRIPT_ARM ? undefined : `${FUSE_SCRIPT} ${arm}`,
    sources: [`${CLI_DIR}/${FUSE_SCRIPT}`],
  });
}

/** The Deno-based command-line integration tests. */
function cliDenoSuite(): Suite {
  return fileSuite({
    id: "cli-deno",
    needs: ["deno", "toolshed", "cf"],
    parts: [{
      packageDir: "packages/cli",
      flags: ["--no-check", "-A"],
      junit: {
        kind: "integration",
        scope: "cli",
        filePrefix: "packages/cli",
      },
      files: ["packages/cli/test/piece-integration.test.ts"],
    }],
  });
}

/** Every command-line suite, read from the working tree. */
export async function loadCliSuites(root: string): Promise<Suite[]> {
  return [
    await cliCoreSuite(root),
    cliFuseSuite(
      await Deno.readTextFile(path.join(root, CLI_DIR, FUSE_SCRIPT)),
    ),
    cliDenoSuite(),
  ];
}
