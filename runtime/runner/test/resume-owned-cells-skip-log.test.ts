import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { getLogger } from "@commonfabric/utils/logger";
import type { Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { trustExecutable } from "./support/trusted-builder.ts";

// The resume owned-cell walk (collectResumeOwnedCells) has TWO exits that skip
// the same work — a sub-pattern node's owned-cell pre-sync AND the recursion
// that would reach that child's own derivedInternalCells manifest. One is the
// catch around binding/resolution; the other is the resolution simply coming
// back undefined, which happens when a node's outputs hold no write redirect
// the scan can resolve. Both hide a skipped subtree that is otherwise only
// discoverable by console probing, so both emit under the `resume-owned-cells`
// key with the same identity payload.
//
// Their LEVELS differ, and that difference is what these tests pin:
//
//   - the catch exit WARNS. Outputs that cannot even be bound are a genuine
//     failure of an expectation.
//   - the undefined exit DEBUGS. Instantiation refuses the same node, having
//     nothing to anchor the child's identity on, so the start that follows
//     reports the failure itself; a warning here would only double it.
//
// A healthy run takes NEITHER exit: the walk derives every sub-pattern node's
// identity as instantiation derives it, so a pattern instantiation accepts is
// a pattern the walk covers in full. The positive cases prove each line still
// carries what a stranded-piece investigation needs; the healthy-home case
// proves the walk over the real home pattern skips nothing at all. A walk that
// fell out of step with instantiation — binding a nested implementation one
// `defer` short of the bind that precedes its start, say — shows up there as
// a skip of every child whose outputs are still deferred.
//
// resume-output-redirect-partialcause.test.ts asserts the scan's return value;
// this asserts the consequence at the call site.

const signer = await Identity.fromPassphrase("resume owned cells skip log");
const space = signer.did();

type Emission = { level: "debug" | "warn"; key: string; parts: unknown[] };

/**
 * Record every `debug`/`warn` the runner's logger emits while `fn` runs,
 * resolving each call's lazy message thunk the way the logger itself does.
 *
 * This captures at the logger rather than at the console on purpose: the LEVEL
 * of the call is what is under test, and reading the console would conflate it
 * with the runner logger's own configured level (`warn`, so its debug calls
 * never reach the console at all) and with `LOG_TO_STDERR`.
 */
const captureRunnerLog = async (
  fn: () => Promise<void>,
): Promise<Emission[]> => {
  const logger = getLogger("runner") as unknown as Record<
    "debug" | "warn",
    (key: string, ...messages: unknown[]) => void
  >;
  const emissions: Emission[] = [];
  const originals = { debug: logger.debug, warn: logger.warn };
  const record =
    (level: "debug" | "warn") => (key: string, ...messages: unknown[]) => {
      emissions.push({
        level,
        key,
        parts: messages.flatMap((message) => {
          const resolved = typeof message === "function" ? message() : message;
          return Array.isArray(resolved) ? resolved : [resolved];
        }),
      });
      // Delegate, so the run under test logs exactly as it would in production
      // (and the logger's own counters stay honest).
      originals[level].call(logger, key, ...messages);
    };
  logger.debug = record("debug");
  logger.warn = record("warn");
  try {
    await fn();
  } finally {
    logger.debug = originals.debug;
    logger.warn = originals.warn;
  }
  return emissions;
};

const skipEmissions = (emissions: Emission[]): Emission[] =>
  emissions.filter((emission) => emission.key === "resume-owned-cells");

/** The identity payload is the trailing record argument of the log call. */
const payloadOf = (emission: Emission): unknown =>
  emission.parts[emission.parts.length - 1];

const childPattern: Pattern = {
  argumentSchema: {},
  resultSchema: {},
  result: {},
  nodes: [],
};

// A sub-pattern node whose whole outputs record holds only a DEFERRED
// partialCause alias. Such an alias denotes a derived internal cell of the
// level it was deferred to, never this node's reserved result spot, so
// firstResolvedOutputRedirect returns undefined for the node as a whole and the
// walk skips it without an error.
const unresolvableOutputsPattern = {
  argumentSchema: {},
  resultSchema: {},
  result: {},
  nodes: [
    {
      description: "sub-pattern node with no resolvable output spot",
      module: { type: "pattern", implementation: childPattern },
      inputs: {},
      outputs: {
        generated: {
          $alias: { partialCause: { "$generated": 0 }, path: [], defer: 1 },
        },
      },
    },
  ],
} as unknown as Pattern;

// A sub-pattern node whose outputs alias the ARGUMENT doc. On a first run the
// result cell has no argument meta link yet, so binding the outputs throws and
// the walk takes its catch exit.
const unbindableOutputsPattern = {
  argumentSchema: {},
  resultSchema: {},
  result: {},
  nodes: [
    {
      description: "sub-pattern node whose outputs alias the argument doc",
      module: { type: "pattern", implementation: childPattern },
      inputs: {},
      outputs: { $alias: { cell: "argument", path: ["child"] } },
    },
  ],
} as unknown as Pattern;

type SkipCase = {
  name: string;
  pattern: Pattern;

  /**
   * Seed the result cell with a prior run, so the run under test resumes a
   * stored root whose argument meta link is already written.
   */
  seedFirst: boolean;

  level: "debug" | "warn";
  message: string;
  node: string;

  /** Parts the call carries ahead of the identity payload. */
  leadingParts: number;

  /** How the run under test is expected to end. */
  rejectsWith?: RegExp;
};

const cases: SkipCase[] = [
  {
    name: "outputs resolve to no write redirect",
    pattern: unresolvableOutputsPattern,
    seedFirst: true,
    level: "debug",
    message:
      "skipping a sub-pattern node whose outputs resolved to no write redirect",
    node: "sub-pattern node with no resolvable output spot",
    leadingParts: 1,
    // The same outputs that gave the walk nothing to resolve also give
    // instantiation nothing to anchor the child's identity on, so the run
    // rejects. Pinned rather than swallowed, so this fixture cannot go green
    // for some later, unrelated reason.
    rejectsWith: /requires a write-redirect output binding/,
  },
  {
    name: "outputs cannot be bound",
    pattern: unbindableOutputsPattern,
    seedFirst: false,
    level: "warn",
    message:
      "skipping a sub-pattern node whose outputs did not bind or resolve",
    node: "sub-pattern node whose outputs alias the argument doc",
    // message, error, payload.
    leadingParts: 2,
  },
];

describe("resume owned-cell walk skip logging", () => {
  for (const testCase of cases) {
    it(`logs at ${testCase.level} when a sub-pattern node's ${testCase.name}`, async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const cause = `owned-cells-skip-log-${testCase.level}`;
      try {
        if (testCase.seedFirst) {
          // A trivial pattern whose setup writes the result cell's argument
          // meta link, so the run under test is a real resume.
          const seedPattern: Pattern = {
            argumentSchema: {},
            resultSchema: {},
            result: {},
            nodes: [],
          };
          const seedRuntime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager,
          });
          const seedCell = seedRuntime.getCell(space, cause);
          await seedRuntime.runSynced(
            seedCell,
            trustExecutable(seedRuntime, seedPattern),
            {},
          );
          await seedCell.pull();
          // The manager outlives the seed runtime: the resume below reuses
          // it, so the seed's work settles and lands before the handoff.
          await seedRuntime.settled();
          await storageManager.synced();
          await seedRuntime.dispose({ closeStorage: false });
        }

        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        const resultCell = runtime.getCell(space, cause);
        const resultCellId = resultCell.getAsNormalizedFullLink().id;
        const emissions = await captureRunnerLog(async () => {
          const run = runtime.runSynced(
            resultCell,
            trustExecutable(runtime, testCase.pattern),
            {},
          );
          if (testCase.rejectsWith !== undefined) {
            await expect(run).rejects.toThrow(testCase.rejectsWith);
          } else {
            await run;
          }
        });
        await runtime.settled();
        await storageManager.synced();
        await runtime.dispose({ closeStorage: false });

        const skips = skipEmissions(emissions);
        const emission = skips.find((candidate) =>
          candidate.parts[0] === testCase.message
        );
        expect(emission).toBeDefined();
        // The level is the finding: the by-design exit must not warn, and the
        // genuine binding failure must.
        expect(emission!.level).toBe(testCase.level);
        expect(emission!.parts.length).toBe(testCase.leadingParts + 1);
        // Asserted as a whole object, so a field that silently stops being
        // populated — `space` and `childPattern` are advertised but only ever
        // read from a production trace — fails here.
        expect(payloadOf(emission!)).toEqual({
          resultCell: resultCellId,
          space,
          nodeIndex: 0,
          node: testCase.node,
          childPattern: "pattern:nodes=0",
        });
        // No emission of the OTHER kind slipped in alongside it.
        expect(skips.every((candidate) => candidate.level === testCase.level))
          .toBe(true);
      } finally {
        await storageManager.close();
      }
    });
  }

  it("skips nothing through a healthy home pattern run", async () => {
    // The negative half: a healthy run of the REAL home pattern takes neither
    // exit. Every sub-pattern node instantiation accepts resolves for the walk
    // too, at every nesting level — the home pattern nests pieces several
    // levels deep, with deferred outputs at each — so a single skip here is a
    // level the walk binds differently from its instantiation.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const patternsRoot = join(
        import.meta.dirname!,
        "..",
        "..",
        "..",
        "patterns",
      );
      const program = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        {
          main: join(patternsRoot, "system", "home", "home.tsx"),
          root: patternsRoot,
        },
      );
      const homePattern = await runtime.patternManager.compilePattern(program, {
        space,
      });

      const resultCell = runtime.getCell(space, "healthy-home-instance");
      const emissions = await captureRunnerLog(async () => {
        const home = await runtime.runSynced(resultCell, homePattern, {});
        await home.pull();
        await runtime.idle();
      });

      expect(skipEmissions(emissions)).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
