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
 * `<at> <what>` of each. A scenario that is not named has none. None of
 * them is a commit the compiled path takes where today's refuses, nor a
 * claim the compiled path does not store.
 */
const OPEN: Record<string, string[]> = {
  // Today's path stores, for a member the named handler wrote, the atom
  // that names the handler as what transformed it, which the label
  // templates of the compiled path do not give (`flow`).
  "writer-policy/main": [
    "step 0 flow",
    "step 1 flow",
    "step 2 flow",
    "step 3 flow",
    "step 4 flow",
    "step 5 flow",
    "step 6 flow",
  ],
  // Today's path stores, for an output a `computed` derived, the atom that
  // names the code that transformed it, which the label templates of the
  // compiled path give as the compiled pattern instead (`flow`). The
  // confidentiality stored is the same on both paths.
  "fixtures/get-iterated": [
    "start 3 flow",
    "step 0 flow",
    "step 1 flow",
    "step 2 flow",
    "step 3 flow",
  ],
  "fixtures/get-iterated through a list": [
    "start 0 flow",
    "start 1 flow",
    "start 2 flow",
    "start 3 flow",
    "start 4 flow",
    "step 0 flow",
    "step 1 flow",
    "step 2 flow",
    "step 3 flow",
  ],
  // An item whose title holds its first value, the empty string, reads
  // with no `title` on the compiled path until a handler writes the title,
  // and so does each output that holds the item (`values`). The atom that
  // names what transformed a member differs by construction, as for
  // `fixtures/get-iterated` (`flow`). Every other output stores what
  // today's path stores: a link where the body returned an element it
  // read through a link unchanged (note 1122), and the members of the
  // element where the body spread it.
  "fixtures/returned-links": [
    "start 0 values",
    "start 1 values",
    "start 2 values",
    "start 2 flow",
    "step 0 values",
    "step 0 flow",
    "step 1 flow",
  ],
  // A body that spreads an element of the result of a `filter` over an
  // array of references (`ofFilter`) copies every member the element's
  // document holds on the compiled path, the stream `name` among them, and
  // on today's path the members the body's type declares (`values`, at
  // every checkpoint from the start of the pattern on). The other
  // differences are those of `fixtures/returned-links`: an item's title
  // that holds its first value, and the atom that names what transformed
  // a member.
  "fixtures/spread-element": [
    "start 0 values",
    "start 1 values",
    "start 2 values",
    "start 2 flow",
    "step 0 values",
    "step 0 flow",
    "step 1 values",
    "step 1 flow",
  ],
  // The compiled path is the stricter one: it holds a computed output to
  // the claims its result type declares, and a derivation is no writer a
  // claim admits. Today's path holds a computed output to no claim of the
  // result type, stores none, and commits.
  "fixtures/principal-derived": [
    "start 0 committed",
    "start 0 message",
    "start 0 values",
    "start 0 claims",
  ],
};

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
    const step = { values: {}, claims: {}, flow: {} };
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
    const step = { committed: true, values: {}, flow: {} };
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
    it(`differs in nothing but what is listed as open: ${scenario.name}`, async () => {
      const both = await runBothPaths(scenario, compiler);

      expect(both.today.failure).toBeUndefined();
      expect(both.compiled.fellBack).toEqual([]);
      expect(Object.values(both.compiled.compiled)).toEqual(
        scenario.pieces.map(() => true),
      );
      expect(both.differences.map(({ at, what }) => `${at} ${what}`)).toEqual(
        OPEN[scenario.name] ?? [],
      );
    });
  }
});
