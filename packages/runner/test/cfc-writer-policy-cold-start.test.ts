import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { runtimePresets } from "../src/runtime-presets.ts";

// A writer policy says which handler may modify a path, from any runtime. A
// runtime that starts a piece it did not create replays the piece's setup,
// and the replay re-stages the argument document with the bytes it already
// holds: the writer-policied inputs among them, with whatever their named
// handler has put there since. That re-stage modifies nothing, and refusing
// it refuses the piece-start commit, which tears the started graph down, so
// every member but the creator ran a piece that could not recompute. The
// replay must be admitted without admitting anything else: a write from
// another handler is still refused, in either runtime.

const signer = await Identity.fromPassphrase("cfc-writer-policy-cold-start");
const space = signer.did();

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import {
  type Confidential,
  Default,
  handler,
  pattern,
  Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

export const neverRelease = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: ["never-present-atom"] },
  post: { dropClause: true },
});
export const rules = exchangeRules([neverRelease]);
type Sealed<T> = Confidential<T, readonly [PolicyOf<typeof rules>]>;

interface Entry {
  seat: number;
  digest: string;
}

const submit = handler<{ seat: number }, { entries: Writable<Sealed<Entry>[]> }>(
  ({ seat }, { entries }) => {
    entries.push({ seat, digest: "d" + seat });
  },
);
const freeze = handler<{ digest: string }, { frozen: Writable<Sealed<Entry>> }>(
  ({ digest }, { frozen }) => {
    frozen.set({ seat: 0, digest });
  },
);

interface Input {
  entries?: Default<WriteAuthorizedBy<Sealed<Entry>[], typeof submit>, []>;
  frozen?: Default<
    WriteAuthorizedBy<Sealed<Entry>, typeof freeze>,
    { seat: -1; digest: "" }
  >;
  // Room state no writer policy guards.
  topic?: Default<string, "">;
}

interface Output {
  topic: string;
  entries: Sealed<Entry>[];
  frozen: Sealed<Entry>;
  submit: Stream<{ seat: number }>;
  freeze: Stream<{ digest: string }>;
}

const Room = pattern<Input, Output>(({ entries, frozen, topic }) => ({
  topic,
  entries,
  frozen,
  submit: submit({ entries }),
  freeze: freeze({ frozen }),
}));

// The room is a sub-piece, as it is wherever a pattern composes one: starting
// the parent replays the room's setup.
export default pattern<Record<string, never>, { room: Output }>(() => ({
  room: Room({}),
}));
`,
  }],
};

type Room = {
  entries: { seat: number; digest: string }[];
  frozen: { seat: number; digest: string };
  topic: string;
};
type Piece = { room: Room };

describe("writer-policied inputs of a sub-piece", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  // The posture a pattern runs under everywhere a member runs one: labels
  // persist, and a member's own slots materialize per user.
  const newRuntime = () =>
    new Runtime(runtimePresets.patternTest({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: {},
    }));

  // `start()` resolves before its piece-start commit settles, so a refused
  // commit reaches a test only through the observer seam.
  const observeStartFailures = (runtime: Runtime): string[] => {
    const failures: string[] = [];
    runtime.pieceStartCommitFailureObserver = ({ error }) => {
      failures.push(String((error as Error)?.message ?? error));
    };
    return failures;
  };

  const send = async (
    runtime: Runtime,
    cell: ReturnType<Runtime["getCell"]>,
    stream: string,
    event: unknown,
  ) => {
    (cell.key("room").key(stream) as unknown as {
      send: (e: unknown) => void;
    }).send(event);
    await runtime.idle();
    await cell.pull();
    await runtime.idle();
  };

  // Create the piece and give each writer-policied input content from its
  // named handler, so the replay re-stages non-default bytes.
  const storePiece = async (runtime: Runtime, name: string) => {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const cell = runtime.getCell<Piece>(space, name, undefined, tx);
    const running = runtime.run(tx, pattern, {}, cell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await running.pull();
    await runtime.idle();
    await send(runtime, running, "submit", { seat: 1 });
    await send(runtime, running, "freeze", { digest: "first" });
    expect(running.get().room.entries.map((entry) => entry.seat)).toEqual([1]);
    expect(running.get().room.frozen.digest).toBe("first");
    await runtime.storageManager.synced();
  };

  const startCold = async (runtime: Runtime, name: string) => {
    const cell = runtime.getCell<Piece>(space, name);
    await cell.sync();
    expect(await runtime.start(cell)).toBe(true);
    await cell.pull();
    await runtime.idle();
    return cell;
  };

  it("starts it, and the named handlers write from there", async () => {
    const creator = newRuntime();
    const cold = newRuntime();
    const failures = observeStartFailures(cold);
    try {
      await storePiece(creator, "writer-policy-cold-start");
      const cell = await startCold(cold, "writer-policy-cold-start");
      expect(
        failures,
        "the piece-start commit was refused, so the started graph was torn " +
          "down",
      ).toEqual([]);

      await send(cold, cell, "submit", { seat: 2 });
      await send(cold, cell, "freeze", { digest: "second" });
      expect(cell.get().room.entries.map((entry) => entry.seat)).toEqual([
        1,
        2,
      ]);
      expect(cell.get().room.frozen.digest).toBe("second");
    } finally {
      await cold.dispose();
      await creator.dispose();
    }
  });

  it("still refuses a write from anything but the named handler", async () => {
    const creator = newRuntime();
    const cold = newRuntime();
    const failures = observeStartFailures(cold);
    try {
      await storePiece(creator, "writer-policy-cold-forge");
      const cell = await startCold(cold, "writer-policy-cold-forge");
      // A refusal below is only evidence if the graph is up to refuse it.
      expect(failures).toEqual([]);

      const argument = cell.key("room").resolveAsCell().getArgumentCell<
        Room
      >()!;
      for (
        const [runtime, source] of [[cold, argument], [
          creator,
          creator.getCellFromLink(argument.getAsNormalizedFullLink()),
        ]] as const
      ) {
        const append = runtime.edit();
        source.withTx(append).key("entries").push({ seat: 9, digest: "x" });
        expect((await append.commit()).error?.message).toContain(
          "writeAuthorizedBy",
        );
        const overwrite = runtime.edit();
        source.withTx(overwrite).key("frozen").set({ seat: 9, digest: "x" });
        expect((await overwrite.commit()).error?.message).toContain(
          "writeAuthorizedBy",
        );
      }
      await cell.pull();
      expect(cell.get().room.entries.map((entry) => entry.seat)).toEqual([1]);
      expect(cell.get().room.frozen.digest).toBe("first");
    } finally {
      await cold.dispose();
      await creator.dispose();
    }
  });

  it("admits a whole-document write that leaves the guarded fields as they are", async () => {
    // Setting a whole document is how pattern code writes several fields at
    // once. The writer policies guard two of them; a write that leaves both
    // byte for byte as they were modifies nothing they guard, whatever it
    // does beside them. Reading the sealed entries first puts a derived
    // label on the field it does change, so the document's labels change
    // too, just not at the guarded paths.
    const creator = newRuntime();
    try {
      await storePiece(creator, "writer-policy-whole-document");
      const cell = creator.getCell<Piece>(
        space,
        "writer-policy-whole-document",
      );
      await cell.sync();
      const argument = cell.key("room").resolveAsCell().getArgumentCell<
        Room
      >()!;
      const rewrite = creator.edit();
      const current = argument.withTx(rewrite).get();
      argument.withTx(rewrite).set({ ...current, topic: "lunch" });
      expect((await rewrite.commit()).error).toBeUndefined();

      const forge = creator.edit();
      argument.withTx(forge).set({
        ...argument.withTx(forge).get(),
        frozen: { seat: 9, digest: "x" },
      });
      expect((await forge.commit()).error?.message).toContain(
        "writeAuthorizedBy",
      );

      await creator.idle();
      expect(argument.get().topic).toBe("lunch");
      expect(argument.get().entries.map((entry) => entry.seat)).toEqual([1]);
      expect(argument.get().frozen.digest).toBe("first");
    } finally {
      await creator.dispose();
    }
  });
});
