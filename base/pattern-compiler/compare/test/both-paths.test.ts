import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { PatternCompiler } from "../../../../runtime/runner/src/compiled/compile.deno.ts";
import {
  differencesOf,
  type PathOutcome,
  policiesOf,
  runBothPaths,
} from "../both-paths.ts";
import { SCENARIOS } from "../both-paths-scenarios.ts";

/**
 * The differences between the paths that are known and open, by scenario:
 * `<at> <what>` of each. A scenario that is not named has none.
 */
const OPEN: Record<string, string[]> = {
  "cfc-trusted-write/main": [
    "step 1 message",
    "step 2 message",
    "step 3 message",
    "step 4 committed",
    "step 4 message",
  ],
  "cfc-trusted-write/frozen": [
    "step 1 message",
    "step 2 message",
    "step 3 message",
  ],
  "fixtures/write-policy-unnamed": ["step 2 message"],
  "fixtures/write-policy": ["step 1 message"],
};

/** The scenarios whose differences are not yet listed one by one. */
const NOT_YET = new Set([
  "writer-policy/main",
  "fixtures/principal-integrity",
  "fixtures/authored",
  "fixtures/principal-integrity started by no one",
  "fixtures/principal-derived",
]);

const outcome = (over: Partial<PathOutcome>): PathOutcome => ({
  compiled: {},
  fellBack: [],
  starts: [],
  steps: [],
  otherRefusals: [],
  ...over,
});

describe("the differences between what the two paths did", () => {
  it("names a step that one path committed and the other refused, and its message", () => {
    const step = { values: {}, claims: {} };
    const differences = differencesOf(
      outcome({ steps: [{ committed: false, message: "refused", ...step }] }),
      outcome({ steps: [{ committed: true, ...step }] }),
    );

    expect(differences.map(({ at, what }) => `${at} ${what}`)).toEqual([
      "step 0 committed",
      "step 0 message",
    ]);
  });

  it("names a claim that one path stored and the other did not", () => {
    const step = { committed: true, values: {} };
    const stored = { integrity: { "/": ["authored-by"] }, policies: {} };
    const none = { integrity: {}, policies: {} };
    const differences = differencesOf(
      outcome({ steps: [{ ...step, claims: { "piece.member": stored } }] }),
      outcome({ steps: [{ ...step, claims: { "piece.member": none } }] }),
    );

    expect(differences.map(({ at, what }) => `${at} ${what}`)).toEqual([
      "step 0 claims",
    ]);
  });
});

describe("the write policies a stored schema declares", () => {
  it("are given by the path of the node below the member read, with `*` for the members of an array", () => {
    const claim = {
      __ctWriterIdentityOf: { file: "/a.tsx", path: ["submit"] },
    };
    const schema = {
      type: "object",
      properties: {
        entries: {
          type: "array",
          ifc: { writeAuthorizedBy: claim },
          items: { $ref: "#/$defs/Entry" },
        },
      },
      $defs: {
        Entry: {
          type: "object",
          ifc: { addIntegrity: [{ kind: "authored-by" }] },
        },
      },
    };

    expect(policiesOf(schema, ["entries"])).toEqual({
      "": ["writeAuthorizedBy submit"],
      "/*": ['addIntegrity [{"kind":"authored-by"}]'],
    });
  });
});

// These cases run the release build of the crate, which
// `cargo build --release` in `base/pattern-compiler` makes.
describe("a pattern run on today's path and on the compiled path with the same events, gestures and principals", () => {
  const compiler = new PatternCompiler();

  for (const scenario of SCENARIOS) {
    if (NOT_YET.has(scenario.name)) continue;
    it(`differs in nothing but what is listed as open: ${scenario.name}`, async () => {
      const both = await runBothPaths(scenario, compiler);

      expect(both.today.failure).toBeUndefined();
      expect(Object.values(both.compiled.compiled)).toEqual(
        scenario.pieces.map(() => true),
      );
      expect(both.differences.map(({ at, what }) => `${at} ${what}`)).toEqual(
        OPEN[scenario.name] ?? [],
      );
    });
  }
});
