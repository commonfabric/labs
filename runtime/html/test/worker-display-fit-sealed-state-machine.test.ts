/**
 * What the display boundary decides about the sealed state machine example
 * (`patterns/examples/cfc-exchange-rules/sealed-state-machine.tsx`), run as a
 * compiled pattern. Its one exchange rule releases the observer view to a
 * reader of the table's space, on `HasRole` evidence the runtime mints only
 * at a display boundary, so a pattern test, which has no such boundary,
 * cannot show the rule firing. These cases fit the labels a read of the view
 * consumed against the ceiling a render gives a viewer, `User(viewer)`, as
 * the reconciler does.
 *
 * `Deno.test` rather than `describe`/`it`: this package installs its fake
 * clock in freeze-all mode, which hangs `settle()` off `Deno.TestContext`, and
 * a `@std/testing/bdd` `it()` callback never receives that context.
 */

import { expect } from "@std/expect";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import {
  ACLManager,
  type Cell,
  hostValueOf,
  readProjected,
  Runtime,
} from "@commonfabric/runner";
import {
  createRenderConfidentialityResolver,
  createRuntimeCfcModulePolicySource,
} from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { readRefusal } from "../src/worker/display-fit.ts";
import type { RenderPolicy } from "../src/worker/types.ts";

const SOURCE = await Deno.readTextFile(
  new URL(
    "../../../patterns/examples/cfc-exchange-rules/sealed-state-machine.tsx",
    import.meta.url,
  ),
);

// A table that holds its own state, and one whose state the pattern around
// it supplies, with what `peek`, a function of the table's module that no
// rule names, computes over that state.
const MAIN = `/// <cts-enable />
import { Default, pattern, Writable } from "commonfabric";
import Table, { peek, type StoredGame } from "./sealed-state-machine.tsx";

interface Input {
  state: Writable<Default<StoredGame, "">>;
}

export default pattern<Input>(({ state }) => {
  const own = Table({} as Parameters<typeof Table>[0]);
  const lent = Table({ state });
  return {
    view: own.view,
    move: own.move,
    lentView: lent.view,
    lentMove: lent.move,
    lentState: state,
    peeked: peek(state),
  };
});
`;

/** The program over the table as `table` gives its source. */
const programOf = (table: string) => ({
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: MAIN },
    {
      name: "/sealed-state-machine.tsx",
      contents: `/// <cts-enable />\n${table}`,
    },
  ],
});

// The table with its rule in two steps. The module's rule is guarded by the
// witnessed `TransformedBy` alone and adds the table's space as a reader of
// the clause, and the display boundary's own rule then admits a reader of
// that space. A rule guarded by evidence bound to the value alone runs at
// each location a read consumed; the table's rule as written also names
// `HasRole`, which is evidence of the access, so it runs once over the join
// of those locations.
const TWO_STEP_SOURCE = (() => {
  const guard =
    `      cfcPattern.hasRole(v("reader"), THIS_POLICY.subject, "reader"),\n`;
  const post = `post: { addAlternatives: [cfcPattern.user(v("reader"))] },`;
  expect(SOURCE).toContain(guard);
  expect(SOURCE).toContain(post);
  return SOURCE.replace(guard, "").replace(
    post,
    `post: {
    addAlternatives: [{
      type: "https://commonfabric.org/cfc/atom/Space",
      id: THIS_POLICY.subject,
    }],
  },`,
  ).replace("  cfcPattern,\n", "").replace(
    "  THIS_POLICY,\n  v,\n",
    "  THIS_POLICY,\n",
  );
})();

/** The fields of the observer view, each a scalar. */
const FIELDS = [
  "phase",
  "board",
  "owners",
  "players",
  "scores",
  "turn",
  "faceUpCount",
  "version",
] as const;

// The table with `observe` returning a view before the first move too. That
// first view is of the state's default, which `move` did not write.
const EAGER_SOURCE = (() => {
  const lazy = "=> stored ? project(parsed(stored)) : undefined);";
  expect(SOURCE).toContain(lazy);
  return SOURCE.replace(lazy, "=> project(parsed(stored)));");
})();

/** What a run of the table is expected to show. */
interface Expected {
  /** Whether one read of the whole view is released. */
  wholeView: "released" | "refused";

  /**
   * The fields refused after the first move, after the deal, and after the
   * reveal that follows it; none, unless given.
   */
  stale?: readonly [readonly string[], readonly string[], readonly string[]];
}

/** Runs the table from `source` and fits its view against a viewer's ceiling. */
const displayFit = async (
  t: Deno.TestContext,
  source: string,
  { wholeView, stale = [[], [], []] }: Expected,
): Promise<void> => {
  const signer = await Identity.fromPassphrase("display fit sealed table");
  const stranger = await Identity.fromPassphrase("display fit stranger");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
  });

  /** What keeps `viewer` from being shown `cell`, or undefined. */
  const refusal = (
    cell: Cell<unknown>,
    viewer: string = signer.did(),
    memberSpaces: readonly string[] = [space],
  ) => {
    const policy: RenderPolicy = {
      declassifyConfidentiality: [],
      maxConfidentiality: [cfcAtom.user(viewer)],
    };
    const resolveConfidentiality = createRenderConfidentialityResolver({
      actingPrincipal: viewer,
      memberSpaces,
      modulePolicyResolver: createRuntimeCfcModulePolicySource(runtime).resolve,
    });
    const read = readProjected(cell, hostValueOf);
    return readRefusal(cell, [read.consumed], policy, {
      resolveConfidentiality,
    });
  };

  try {
    // The access list `spaceAccess()` reads: the signer owns its home space.
    await new ACLManager(runtime, space).set(space, "OWNER");

    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(
      programOf(source),
      {
        space,
        tx,
      },
    );
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "sealed table",
      undefined,
      tx,
    );
    runtime.run(tx, pattern, {}, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.idle();

    const send = async (stream: string, event: unknown) => {
      const sendTx = runtime.edit();
      // deno-lint-ignore no-explicit-any
      (result.withTx(sendTx) as any).key(stream).send(event);
      expect((await sendTx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      await result.pull();
    };
    const cell = (...path: string[]) =>
      path.reduce(
        (at, key) => at.key(key as never) as Cell<unknown>,
        result as Cell<unknown>,
      );
    const refusedFields = (view: string) =>
      FIELDS.filter((field) => refusal(cell(view, field)) !== undefined);

    await t.step("releases the fields of the first move", async () => {
      // The first write of the state: `move` read only the state's default.

      await send("move", { kind: "sit" });
      expect(cell("view", "version").get()).toBe(1);
      expect(refusedFields("view")).toEqual(stale[0]);
    });

    await t.step("releases the fields of the deal", async () => {
      await send("move", { kind: "setup", pairs: 2 });
      expect(cell("view", "board").get()).toBe("????");
      expect(refusedFields("view")).toEqual(stale[1]);
    });

    await t.step("releases the fields of a move that changes one", async () => {
      // `phase`, `owners`, `players`, `scores` and `turn` keep the value, and
      // so the stamp, the deal gave them.

      await send("move", { kind: "reveal", slot: 1 });
      expect(cell("view", "faceUpCount").get()).toBe(1);
      expect(refusedFields("view")).toEqual(stale[2]);
    });

    await t.step(`has one read of the whole view ${wholeView}`, () => {
      // Under the table's own rule each field fits on its own, and a read
      // that covers the record of them does not, a known gap
      // (SEALED-STATE-MACHINE-FINDINGS.md, gap C).

      expect(refusal(cell("view")) === undefined).toBe(
        wholeView === "released",
      );
    });

    await t.step("refuses a field to a principal who reads no space", () => {
      expect(refusal(cell("view", "board"), stranger.did(), []))
        .toBeDefined();
    });

    await t.step("refuses a field to a reader of another space", () => {
      expect(
        refusal(cell("view", "board"), stranger.did(), [stranger.did()]),
      ).toBeDefined();
    });

    await t.step("refuses every field of a table lent its state", async () => {
      // The state is the outer pattern's, linked into the table's argument.
      // The link is a slot `move` did not write, so `observe` retains no
      // input witness (SEALED-STATE-MACHINE-FINDINGS.md, gap D).

      await send("lentMove", { kind: "sit" });
      expect(cell("lentView", "version").get()).toBe(1);
      expect(refusedFields("lentView")).toEqual([...FIELDS]);
    });

    await t.step("refuses the sealed state", () => {
      expect(String(cell("lentState").get())).toContain("players");
      expect(refusal(cell("lentState"))).toBeDefined();
    });

    await t.step("refuses what a function no rule names computed", () => {
      expect(refusal(cell("peeked"))).toBeDefined();
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

Deno.test("display fit of the sealed state machine", async (t) => {
  await displayFit(t, SOURCE, { wholeView: "refused" });
});

Deno.test(
  "display fit of the sealed state machine under a two-step rule",
  async (t) => {
    await displayFit(t, TWO_STEP_SOURCE, { wholeView: "released" });
  },
);

Deno.test(
  "display fit of the sealed state machine projecting before its first move",
  async (t) => {
    // A field keeps the stamp of the run that last changed it. The view of
    // the default state carries no input witness, so each field stays
    // refused until a move changes its value, a known gap
    // (SEALED-STATE-MACHINE-FINDINGS.md, gap B).

    await displayFit(t, EAGER_SOURCE, {
      wholeView: "refused",
      stale: [
        ["phase", "board", "owners", "turn", "faceUpCount"],
        ["faceUpCount"],
        [],
      ],
    });
  },
);
