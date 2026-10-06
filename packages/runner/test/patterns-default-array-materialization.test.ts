// Pattern-level invariant: a field typed as `T[] | Default<[]>` must
// materialize as an array (not an object with numeric keys) when consumed
// by a value-site expression like `rooms.map(...).join("\n")`.
//
// `Default<[]>` emits a schema with an anyOf split — `{type:"array",
// items:false}` (the empty-array branch) alongside `{type:"array",
// items:{$ref:T}}` (the populated branch). Both branches can match a
// populated array. Before the fix in `packages/runner/src/traverse.ts`,
// `mergeAnyOfMatches` ran `Object.assign({}, …branches)` for multi-match
// anyOf results because arrays satisfy `isObjectOrArray`; two array branches
// collapsed to `{ "0": …, "1": … }`, dropping `.map` and crashing the
// derive callback with `TypeError: rooms.map is not a function`. Fix
// preserves array-ness when all matches are arrays.
//
// This is the end-to-end test exercising the full
// PatternManager.compilePattern + runtime.run path. Unit-level
// regression tests for `mergeAnyOfMatches` and `canBranchMatch` live
// in `packages/runner/test/traverse.test.ts`. Tracks CT-1562.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Pattern Runner - Default<[]> array field materializes as array", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let errors: unknown[];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    errors = [];
    runtime.scheduler.onError((error) => {
      errors.push(error);
    });
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("rooms.map(...).join() returns the joined string when rooms has Default<[]>", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { Default, pattern, UI } from 'commonfabric';",
            "",
            "interface Room {",
            "  name: string;",
            "  messages: string[] | Default<[]>;",
            "}",
            "interface Conversation {",
            "  rooms: Room[] | Default<[]>;",
            "}",
            "interface Input { conversation: Conversation; }",
            "",
            "export default pattern<Input>(({ conversation }) => {",
            "  const rooms = conversation.rooms;",
            "  const roomSummaryText = rooms",
            "    .map((room) => `${room.name}: ${room.messages.length}`)",
            "    .join('\\n');",
            "  return { roomSummaryText };",
            "});",
          ].join("\n"),
        },
      ],
    };

    const loaded = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const resultCell = runtime.getCell<{ roomSummaryText: string }>(
      space,
      "ct1562-default-anyof-merge",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      loaded,
      {
        conversation: {
          rooms: [
            { name: "alpha", messages: ["one", "two"] },
            { name: "beta", messages: [] },
          ],
        },
      },
      resultCell,
    );
    await tx.commit().settled;
    tx = runtime.edit();
    await result.pull();

    // Pre-fix, this test failed with a scheduler error matching Berni's
    // ticket (`TypeError: rooms.map is not a function`). The assertion
    // below is the user-visible expectation.
    expect(errors).toEqual([]);
    const queryResult = result.getAsQueryResult();
    expect((queryResult as { roomSummaryText?: string })?.roomSummaryText)
      .toBe("alpha: 2\nbeta: 0");
  });
});
