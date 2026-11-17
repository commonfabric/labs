import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { runtimePresets } from "../src/runtime-presets.ts";

// A piece whose argument holds a value under another writer's lone claim
// takes a successor that adds an argument field, and declares a claim where
// the earlier program declared none, so that the document's envelope changes
// beside the claimed slot. The successor's setup replays the claimed slot with
// the bytes it holds and writes only what it adds, so the update commits. A
// successor whose setup writes another value at the claimed slot is refused.

const signer = await Identity.fromPassphrase("setup-replayed-argument-slots");
const space = signer.did();

/** The earlier program, and with `successor` the one that replaces it. */
const program = (successor: boolean): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import {
  Default,
  handler,
  pattern,
  Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

const add = handler<{ name: string }, { roster: Writable<string[]> }>(
  ({ name }, { roster }) => {
    roster.push(name);
  },
);
const setNote = handler<{ text: string }, { note: Writable<string> }>(
  ({ text }, { note }) => {
    note.set(text);
  },
);

interface Input {
  roster?: Default<WriteAuthorizedBy<string[], typeof add>, []>;
  note?: ${
      successor
        ? 'Default<WriteAuthorizedBy<string, typeof setNote>, "">'
        : 'Default<string, "">'
    };
  ${successor ? 'extra?: Default<string, "">;' : ""}
}

interface Output {
  roster: string[];
  note: string;
  add: Stream<{ name: string }>;
  setNote: Stream<{ text: string }>;
}

export default pattern<Input, Output>(({ roster, note }) => ({
  roster,
  note,
  add: add({ roster }),
  setNote: setNote({ note }),
}));
`,
  }],
});

type Piece = { roster: string[]; note: string };

describe("runner", () => {
  describe("a setup that replays an argument slot under a lone claim", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime(runtimePresets.patternTest({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: {},
      }));
    });
    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    /** A piece on the earlier program whose roster `add` has written. */
    const storePiece = async (name: string) => {
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(
        program(false),
        { space, tx },
      );
      const cell = runtime.getCell<Piece>(space, name, undefined, tx);
      const running = runtime.run(tx, pattern, {}, cell);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await running.pull();
      await runtime.idle();
      (running.key("add") as unknown as { send: (e: unknown) => void }).send({
        name: "Ada",
      });
      await runtime.idle();
      await running.pull();
      expect(running.get().roster).toEqual(["Ada"]);
      return cell;
    };

    /** Sets `cell` up from the successor, given `argument`; the commit's error. */
    const update = async (
      cell: ReturnType<typeof runtime.getCell<Piece>>,
      argument: unknown,
    ) => {
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(
        program(true),
        { space, tx },
      );
      runtime.run(tx, pattern, argument, cell.withTx(tx));
      runtime.prepareTxForCommit(tx);
      return (await tx.commit().settled).error?.message;
    };

    it("takes the successor, leaving the claimed slot as it was", async () => {
      const cell = await storePiece("replays");

      expect(await update(cell, undefined)).toBeUndefined();
      await runtime.idle();
      await cell.pull();
      expect(cell.get().roster).toEqual(["Ada"]);
      const argument = cell.getArgumentCell<Record<string, unknown>>()!;
      expect(argument.getRaw()?.extra).toBe("");
    });

    it("refuses a successor whose setup writes another value at the claimed slot", async () => {
      const cell = await storePiece("rewrites");

      expect(await update(cell, { roster: ["Mallory"] })).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity at /roster",
      );
      await cell.pull();
      expect(cell.get().roster).toEqual(["Ada"]);
    });
  });
});
