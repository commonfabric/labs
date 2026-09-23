/**
 * Whether each shipped binary still compiles.
 *
 * The binaries are built on every pull request today, so a compile that
 * breaks is caught before it lands. Under selection a pull request runs
 * its servers and its command line from source, and never compiles
 * anything — which would leave a broken compile to be found on `main`,
 * after the change that broke it has merged. These suites keep it a
 * pull-request signal by making the build a test like any other: it has
 * an identity, it accumulates a record of what it has caught, and the
 * packer can choose it.
 *
 * Nothing forces one to run. A binary the store has never seen is
 * unknown and therefore mandatory, so each is built once; after that it
 * sits at the value floor until it catches something. When a compile
 * does break, `main` catches it, and a `main` catch is weighted half
 * again for being exactly the escape this system exists to stop — one of
 * them lifts a build from the floor to several times it, which is enough
 * to be chosen against a corpus where almost nothing has ever failed.
 * That feedback loop is the mechanism. A hand-maintained map from
 * changed paths to binaries would be the kind of transcribed table this
 * design exists to delete, and it would go stale the first time an
 * import moved.
 *
 * What a compile catches that nothing else does is worth naming, because
 * every one of these builds passes `--no-check`. Type errors belong to
 * `deno task check`. What is left is everything else the compile does:
 * resolving the whole import graph from an entry point, bundling the
 * browser shell, and embedding each `--include`d asset from a path that
 * has to still exist.
 */

import { BINARY_NAMES, type BinaryName } from "../build-binaries.ts";
import { serverExecutionCiLane } from "../server-execution-ci.ts";
import {
  claimsIdentity,
  type Invocation,
  type Location,
  type Suite,
  type Unit,
} from "./suite.ts";

/** What a unit's record is named for. */
const PREFIX = "build-binary";

/** The one record surface these suites share. */
const SURFACE = [{ kind: "gate", scope: "repo" }] as const;

/** One suite over a set of binaries, in one configuration. */
function binarySuite(
  id: string,
  binaries: readonly BinaryName[],
  options: { variant?: string; env?: Record<string, string> } = {},
): Suite {
  const known = new Set<Unit>(binaries);
  const surfaces = {
    recordSurfaces: SURFACE,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  };
  return {
    id,
    recordSurfaces: SURFACE,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
    needs: ["deno"],
    units: [...binaries],
    unavailable: [],
    // One build is one identity, so asking for less than a unit is
    // asking not to build it.
    whole: [...binaries],

    locate(record): Location | undefined {
      if (!claimsIdentity(surfaces, record.test)) return undefined;
      if (!record.test.n.startsWith(`${PREFIX} `)) return undefined;
      const binary = record.test.n.slice(PREFIX.length + 1);
      return known.has(binary) ? { level: "unit", unit: binary } : undefined;
    },

    command(requests, context): Promise<Invocation[]> {
      return Promise.resolve(
        requests
          .filter((request) => known.has(request.unit))
          .map((request) => ({
            // One invocation per binary rather than one for all of them:
            // a build that fails takes its own identity down and leaves
            // the others to report for themselves.
            command: [
              Deno.execPath(),
              "task",
              "run-recorded",
              "gate",
              "repo",
              `${PREFIX} ${request.unit}`,
              "--",
              Deno.execPath(),
              "task",
              "build-binaries",
              request.unit,
            ],
            cwd: context.root,
            ...(options.env === undefined ? {} : { env: options.env }),
          })),
      );
    },
  };
}

/**
 * The binary suites. The server-execution shell is the same build under
 * a different compile-time define, which is what a variant is: one test,
 * two configurations, two histories that never stand in for each other.
 */
export function loadBinarySuites(): Suite[] {
  const opposite = serverExecutionCiLane("opposite");
  return [
    binarySuite("binaries", BINARY_NAMES),
    binarySuite("binaries-opposite", ["toolshed"], {
      variant: opposite.recordVariant,
      env: { EXPERIMENTAL_SERVER_EXECUTION: String(opposite.enabled) },
    }),
  ];
}
