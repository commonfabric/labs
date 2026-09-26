/**
 * The `case "$SECTION"` table at the end of integration/fuse-exec.sh chooses
 * which phases a run executes, and each phase records as its own test. A
 * lane dispatches the table through `CF_FUSE_INTEGRATION_SECTION`, one unit of
 * the test topology's `cli-fuse` suite per section, and a run with no section
 * dispatches `all`.
 *
 * The script brings up one FUSE mount and one daemon and then works through a
 * piece on it, so a phase that reached for what a phase in another section
 * left behind would pass under `all` and fail whenever a lane ran its section
 * alone. These hold the table to the properties that make a section
 * schedulable: every phase is reachable, from `all` and from what CI
 * dispatches; the prelude every section depends on runs whichever section was
 * asked for; and the orderings the script's phases depend on survive.
 *
 * What they read is the text of the table and of the phase functions, and the
 * topology's units. Whether a section really stands alone is settled by
 * running it, which only CI can do.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { loadCliSuites } from "../../../tasks/test-topology/cli.ts";

/** The FUSE integration script, whose tail holds the dispatch table. */
const SCRIPT = await Deno.readTextFile(
  new URL("../integration/fuse-exec.sh", import.meta.url),
);

/**
 * The sections a lane may be asked for: the units of the topology's
 * `cli-fuse` suite, each named for this script and one section of it.
 */
const CI_SECTIONS = (await loadCliSuites(
  new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""),
))
  .find((suite) => suite.id === "cli-fuse")?.units
  .filter((unit) => unit.startsWith("fuse-exec.sh "))
  .map((unit) => unit.slice("fuse-exec.sh ".length)) ?? [];

/** The shell function that runs a phase, by the script's naming rule. */
function phaseFunction(phase: string): string {
  return `run_${phase.replaceAll("-", "_")}`;
}

/**
 * The names inside a `NAME=( ... )` array literal. Missing is an error rather
 * than an empty list: the checks below read the prelude out of one, and an
 * empty list would leave them passing over nothing.
 */
function shellArray(script: string, name: string): string[] {
  const found = script.match(new RegExp(`^${name}=\\(([^)]*)\\)`, "m"));
  if (!found) throw new Error(`fuse-exec.sh has no ${name} array`);
  return found[1].split(/\s+/).filter((word) => word.length > 0);
}

/** One arm of the dispatch table and the phases it selects. */
interface Arm {
  /** The section name, as `CF_FUSE_INTEGRATION_SECTION` names it. */
  section: string;

  /** The phases the arm selects, in the order it lists them. */
  phases: string[];
}

/**
 * Reads the dispatch table. Each arm assigns `PHASES` a list of phase names
 * and does nothing else, which is what lets an unknown section be rejected
 * before the mount; an arm in any other shape is reported rather than read,
 * so a phase selected some other way cannot slip past the checks below.
 */
function parseDispatchTable(script: string): {
  arms: Arm[];
  malformed: string[];
} {
  const opened = script.indexOf('case "$SECTION" in');
  if (opened < 0) {
    throw new Error('fuse-exec.sh has no `case "$SECTION" in` table');
  }
  const table = script.slice(opened, script.indexOf("\nesac", opened));
  const arms: Arm[] = [];
  const malformed: string[] = [];
  // Each arm is `  <section>)` down to its `    ;;`. `*)` is the
  // unknown-section error rather than a list of phases.
  for (
    const [, section, body] of table.matchAll(/^ {2}(\S+)\)\n(.*?)^ {4};;$/gms)
  ) {
    if (section === "*") continue;
    const assigned = body.match(/^ {4}PHASES=\(([^)]*)\)\n$/s);
    if (!assigned) {
      malformed.push(`${section}: does not assign PHASES and nothing else`);
      continue;
    }
    arms.push({
      section,
      phases: assigned[1].split(/\s+/).filter((word) => word.length > 0),
    });
  }
  return { arms, malformed };
}

/** Every phase function the script defines, in the order it defines them. */
function definedPhases(script: string): string[] {
  return [...script.matchAll(/^(run_[a-z_]+)\(\) \{$/gm)].map((m) => m[1]);
}

/** The identities a phase function records. */
function recordedBy(script: string, fn: string): string[] {
  const lines = script.split("\n");
  const opened = lines.indexOf(`${fn}() {`);
  if (opened < 0) return [];
  const body = lines.slice(opened + 1, lines.indexOf("}", opened));
  return body.flatMap((line) => {
    const marker = line.match(/^\s+phase "([^"]*)"$/);
    return marker ? [marker[1]] : [];
  });
}

const { arms, malformed } = parseDispatchTable(SCRIPT);
const byArm = new Map(arms.map((arm) => [arm.section, arm.phases]));
const prelude = shellArray(SCRIPT, "PRELUDE");
const selectable = [...new Set(arms.flatMap((arm) => arm.phases))];
const defined = definedPhases(SCRIPT);
const order = new Map(defined.map((fn, index) => [fn, index]));

describe("fuse-sections", () => {
  it("gives every arm a list of phases and nothing else", () => {
    expect(malformed).toEqual([]);
  });

  it("names a phase function for every phase it selects", () => {
    // Deleting a function and leaving its name in an arm is valid shell that
    // `bash -n` accepts too; the script reaches `command not found` only once
    // CI has paid for a mount.
    const named = [...prelude, ...selectable].map(phaseFunction);
    expect(named.filter((fn) => !order.has(fn))).toEqual([]);
  });

  it("reaches every phase function the script defines", () => {
    // The other direction: a phase nobody selects runs nowhere, which is how
    // a test stays maintained and stops being reported on.
    const reached = new Set([...prelude, ...selectable].map(phaseFunction));
    expect(defined.filter((fn) => !reached.has(fn))).toEqual([]);
  });

  it("runs every selectable phase under `all`", () => {
    const all = new Set(byArm.get("all") ?? []);
    expect(selectable.filter((phase) => !all.has(phase))).toEqual([]);
  });

  it("runs every selectable phase under a section CI dispatches", () => {
    const sections = CI_SECTIONS;
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.filter((section) => !byArm.has(section))).toEqual([]);
    const covered = new Set(
      sections.flatMap((section) => byArm.get(section) ?? []),
    );
    expect(selectable.filter((phase) => !covered.has(phase))).toEqual([]);
  });

  it("gives every selectable phase a section besides `all`", () => {
    // `all` is the union, not a hiding place. A phase reachable only from it
    // cannot be selected as part of anything smaller, which is the whole
    // point of the table, and it would run nowhere the day CI dispatches
    // sections rather than `all`.
    const grouped = new Set(
      arms.filter((arm) => arm.section !== "all").flatMap((arm) => arm.phases),
    );
    expect(selectable.filter((phase) => !grouped.has(phase))).toEqual([]);
  });

  it("keeps the prelude out of the arms", () => {
    // A prelude phase runs whichever section was asked for. Selecting one as
    // well would run it twice in a single invocation, and a phase recorded
    // twice under one name is one identity carrying two outcomes.
    const both = prelude.filter((phase) => selectable.includes(phase));
    expect(both).toEqual([]);
  });

  it("lists each arm's phases once", () => {
    const repeated = arms.flatMap((arm) =>
      arm.phases.filter((phase, index) => arm.phases.indexOf(phase) !== index)
        .map((phase) => `${arm.section}: ${phase}`)
    );
    expect(repeated).toEqual([]);
  });

  it("lists every arm's phases in the order the script defines them", () => {
    // Two orderings are load-bearing rather than conventional. The handler
    // phases assert `messageCount` as an absolute count up from zero, so they
    // have to run in one order; and the source update ends by asserting the
    // empty string the truncate phase left, so it has to follow it. The order
    // the functions are written in is where both are recorded, which is why
    // it is the reference here rather than `all` — an arm compared against
    // `all` cannot catch `all` reordering itself.
    const misordered = arms.filter((arm) =>
      arm.phases.some((phase, index) =>
        index > 0 &&
        order.get(phaseFunction(phase))! <=
          order.get(phaseFunction(arm.phases[index - 1]!))!
      )
    ).map((arm) => arm.section);
    expect(misordered).toEqual([]);
  });

  it("runs the entity listing before anything that reads the piece", () => {
    // The listing's assertion is that no entity payload has crossed the
    // memory proxy, read from a trace that accumulates over the whole run.
    // Any read that hydrates the piece first would put the payload in the
    // trace, and the phase would fail without saying why.
    expect(prelude.indexOf("entity-listing")).toBeGreaterThanOrEqual(0);
    expect(prelude.indexOf("entity-listing")).toBeLessThan(
      prelude.indexOf("piece-paths"),
    );
  });

  it("records an identity from exactly one phase function", () => {
    // A recorded name is the test's identity, so two functions writing one
    // name would merge two tests into one that neither can be tracked
    // through.
    const owners = new Map<string, string[]>();
    for (const fn of defined) {
      for (const name of recordedBy(SCRIPT, fn)) {
        owners.set(name, [...(owners.get(name) ?? []), fn]);
      }
    }
    const shared = [...owners].filter(([, fns]) => fns.length > 1)
      .map(([name, fns]) => `${name}: ${fns.join(", ")}`);
    expect(shared).toEqual([]);
  });

  it("records at least one identity from every phase function", () => {
    // A phase that records nothing is a phase selection cannot see, so
    // nothing decides whether it is worth running.
    expect(defined.filter((fn) => recordedBy(SCRIPT, fn).length === 0))
      .toEqual([]);
  });
});
