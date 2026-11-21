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

const PROGRAM = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: MAIN },
    {
      name: "/sealed-state-machine.tsx",
      contents: `/// <cts-enable />\n${SOURCE}`,
    },
  ],
};

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

Deno.test("display fit of the sealed state machine", async (t) => {
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
    const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
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

    await t.step("releases every field after the first move", async () => {
      // The first write of the state: `move` read only the state's default.

      await send("move", { kind: "sit" });
      expect(cell("view", "version").get()).toBe(1);
      expect(refusedFields("view")).toEqual([]);
    });

    await t.step("releases every field after the deal", async () => {
      await send("move", { kind: "setup", pairs: 2 });
      expect(cell("view", "board").get()).toBe("????");
      expect(refusedFields("view")).toEqual([]);
    });

    await t.step("releases every field after a move changes one", async () => {
      // `phase`, `owners`, `players`, `scores` and `turn` keep the value, and
      // so the stamp, the deal gave them.

      await send("move", { kind: "reveal", slot: 1 });
      expect(cell("view", "faceUpCount").get()).toBe(1);
      expect(refusedFields("view")).toEqual([]);
    });

    await t.step("refuses one read of the whole view, a known gap", () => {
      // Each field fits on its own, and a read that covers the record of
      // them does not (SEALED-STATE-MACHINE-FINDINGS.md, "View shape"). A
      // release of the whole record would flip this.

      expect(refusal(cell("view"))).toBeDefined();
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
      // input witness (SEALED-STATE-MACHINE-FINDINGS.md, "Lending the
      // state").

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
});
