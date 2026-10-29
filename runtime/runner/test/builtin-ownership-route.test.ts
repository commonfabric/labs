// Which builtins may put their stores on the ownership route, checked against
// the source rather than against a reviewer's memory.
//
// A store on the route gives up whatever refusal its own ceiling was
// providing, so the test is what refuses that write instead. A builtin that
// stages its effect itself has nothing to move the refusal to, which is why
// `docs/specs/cfc-enforcement-matrix.md` §4 keeps those stores off the route.
// The rule is prose everywhere else; here it is the two sets being disjoint.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

const BUILTINS = new URL("../src/builtins/", import.meta.url);

/** The helpers that put a store on the route, however a builtin reaches it. */
const ROUTE = /\bownedCell[<(]|\brecordRuntimeOwnedStore\(/;
/** Staging an effect directly, with no sink request to carry a ceiling. */
const STAGES_EFFECT = /\benqueuePostCommitEffect\(/;

const sources = async () => {
  const found = new Map<string, string>();
  for await (const entry of Deno.readDir(BUILTINS)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    // The seam itself names both sides; it is the definition, not a caller.
    if (entry.name === "runtime-owned-store.ts") continue;
    found.set(
      entry.name,
      await Deno.readTextFile(new URL(entry.name, BUILTINS)),
    );
  }
  return found;
};

describe("the builtin ownership route", () => {
  it("puts no store of an effect-staging builtin on the route", async () => {
    const offenders = [...await sources()]
      .filter(([, text]) => STAGES_EFFECT.test(text) && ROUTE.test(text))
      .map(([name]) => name);

    // A builtin reaching both is a decision someone has to make rather than
    // a line to delete: either the effect gets a sink request whose ceiling
    // can carry the refusal, or the store stays off the route and keeps its
    // own, or the matrix records why this one is neither.
    expect(offenders).toEqual([]);
  });

  it("finds the route in use and effects staged, so the pairing means something", async () => {
    // Without this, deleting both helpers would leave the case above green.
    const found = await sources();
    const onRoute = [...found].filter(([, t]) => ROUTE.test(t));
    const staging = [...found].filter(([, t]) => STAGES_EFFECT.test(t));
    expect(onRoute.length).toBeGreaterThan(0);
    expect(staging.length).toBeGreaterThan(0);
  });
});
