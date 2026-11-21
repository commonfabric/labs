import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

// A state machine keeps a record, and each step reads the record and sets it
// again. These cases run that shape as a compiled pattern: one handler,
// `move`, is the record's writer, a lift projects it, and a rule releases the
// projection only where every confidential location the lift read was
// written by `move`. A publish into a room that admits only public values is
// where the rule gets its chance, so a room that takes the value shows the
// witness held, and one left untouched shows it did not.

const signer = await Identity.fromPassphrase(
  "runner-cfc-input-witness-state",
);
const space = signer.did();

const UNTOUCHED = "untouched";

// The machine. `STATE` is the stored state's type and default, `MOVE` what a
// move sets the state to, and `EXTRA` further handlers and their streams.
const machine = (
  options: { state: string; move: string; extra?: string; streams?: string },
): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import {
  type Confidential,
  type Default,
  handler,
  lift,
  type MaxConfidentiality,
  pattern,
  type Writable,
} from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

export const releaseProjection = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [{
      type: "https://commonfabric.org/cfc/atom/TransformedBy",
      identity: {
        kind: "verified",
        moduleIdentity: THIS_POLICY.moduleIdentity,
        symbol: "project",
      },
      inputWitness: {
        type: "https://commonfabric.org/cfc/atom/TransformedBy",
        identity: {
          kind: "verified",
          moduleIdentity: THIS_POLICY.moduleIdentity,
          symbol: "move",
        },
      },
    }],
  },
  post: { dropClause: true },
});

export const machineRules = exchangeRules([releaseProjection]);

type Sealed<T> = Confidential<T, readonly [PolicyOf<typeof machineRules>]>;

type Room = MaxConfidentiality<string, readonly []>;

interface Machine {
  count: number;
  kept: string;
  log: string[];
}

${options.state}

const machineOf = (stored: Partial<Machine> | null | undefined): Machine => ({
  count: stored?.count ?? 0,
  kept: stored?.kept ?? "",
  log: [...(stored?.log ?? [])],
});

export const move = handler<void, { state: Writable<Stored> }>(
  (_, { state }) => {
    const before = machineOf(state.get());
    ${options.move}
  },
);

interface Projection {
  count: string;
  kept: string;
}

export const project = lift((
  { state }: { state: Machine | null | undefined },
): Projection => {
  const machine = machineOf(state);
  return {
    count: String(machine.count) + "/" + machine.log.join(""),
    kept: "kept:" + machine.kept,
  };
});

const publish = handler<void, { from: string; to: Writable<Room> }>(
  (_, { from, to }) => {
    to.set(from);
  },
);
${options.extra ?? ""}
interface Input {
  state: Writable<StoredInput>;
  roomCount: Writable<Default<Room, "${UNTOUCHED}">>;
  roomKept: Writable<Default<Room, "${UNTOUCHED}">>;
}

export default pattern<Input>(({ state, roomCount, roomKept }) => {
  const projection = project({ state });
  return {
    roomCount,
    roomKept,
    move: move({ state }),
    publishCount: publish({ from: projection.count, to: roomCount }),
    publishKept: publish({ from: projection.kept, to: roomKept }),
    ${options.streams ?? ""}
  };
});
`,
  }],
});

// A state that starts as `null`, so nothing of its default outlives the
// first move.
const FROM_NULL = `type Stored = Sealed<Machine | null>;
type StoredInput = Default<Stored, null>;`;

// A state that starts as a record whose \`kept\` no move changes.
const FROM_RECORD = `type Stored = Sealed<Machine>;
type StoredInput = Default<Stored, { count: 0; kept: "default"; log: [] }>;`;

// A move that changes one field of the record it read, and adds to its list.
const STEP = `state.set({
      ...before,
      count: before.count + 1,
      log: [...before.log, "m"],
    });`;

type Rooms = { roomCount: string; roomKept: string };

const run = async (
  source: RuntimeProgram,
  cause: string,
  body: (
    send: (stream: string) => Promise<void>,
    read: () => Promise<Rooms>,
  ) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
  });
  try {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(source, {
      space,
      tx,
    });
    const result = runtime.getCell<Rooms>(space, cause, undefined, tx);
    runtime.run(tx, pattern, {}, result);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.idle();

    const send = async (stream: string) => {
      const sendTx = runtime.edit();
      // deno-lint-ignore no-explicit-any
      (result.withTx(sendTx) as any).key(stream).send(undefined);
      expect((await sendTx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      await storageManager.synced();
      await result.pull();
    };
    const read = async () => {
      await runtime.idle();
      return (await result.pull()) as Rooms;
    };
    await body(send, read);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("cfc-transformed-by-input-witness-state", () => {
  describe("a record its writer reads and sets", () => {
    it("releases a projection after the writer's first move", async () => {
      await run(
        machine({ state: FROM_NULL, move: STEP }),
        "state first move",
        async (send, read) => {
          await send("move");
          await send("publishCount");
          expect((await read()).roomCount).toBe("1/m");
        },
      );
    });

    it("releases a projection after a move that changed part of the record", async () => {
      await run(
        machine({ state: FROM_NULL, move: STEP }),
        "state later moves",
        async (send, read) => {
          await send("move");
          await send("move");
          await send("move");
          await send("publishCount");
          expect((await read()).roomCount).toBe("3/mmm");
        },
      );
    });

    it("refuses a projection of a record that keeps a field of its default", async () => {
      // The default is nobody's: no move wrote `kept`, and each move sets it
      // back as it found it.

      await run(
        machine({ state: FROM_RECORD, move: STEP }),
        "state default kept",
        async (send, read) => {
          await send("move");
          await send("move");
          await send("publishCount");
          await send("publishKept");
          expect(await read()).toMatchObject({
            roomCount: UNTOUCHED,
            roomKept: UNTOUCHED,
          });
        },
      );
    });

    it("releases a projection once a move has replaced every field of the default", async () => {
      await run(
        machine({
          state: FROM_RECORD,
          move: `state.set({
      count: before.count + 1,
      kept: before.count === 0 ? "moved" : before.kept,
      log: [...before.log, "m"],
    });`,
        }),
        "state default replaced",
        async (send, read) => {
          await send("move");
          await send("move");
          await send("publishCount");
          await send("publishKept");
          expect(await read()).toMatchObject({
            roomCount: "2/mm",
            roomKept: "kept:moved",
          });
        },
      );
    });

    it("refuses a projection of a record another handler wrote a field of", async () => {
      // `meddle` is not the endorsed writer. The move after it reads what
      // `meddle` wrote and sets it back unchanged, which does not make it
      // the move's own.

      await run(
        machine({
          state: FROM_NULL,
          move: STEP,
          extra: `
export const meddle = handler<void, { state: Writable<Stored> }>(
  (_, { state }) => {
    state.key("kept").set("meddled");
  },
);
`,
          streams: "meddle: meddle({ state }),",
        }),
        "state meddled",
        async (send, read) => {
          await send("move");
          await send("meddle");
          await send("move");
          await send("publishCount");
          await send("publishKept");
          expect(await read()).toMatchObject({
            roomCount: UNTOUCHED,
            roomKept: UNTOUCHED,
          });
        },
      );
    });
  });

  describe("a projection computed before the writer's first move", () => {
    it("releases a field of it that the first move left unchanged", async () => {
      // `kept` reads the same before the first move and after it. The lift's
      // run after the move wrote the projection, so the field carries that
      // run's witness, and not the stamp of the run before the move.

      await run(
        machine({ state: FROM_NULL, move: STEP }),
        "projection unchanged field",
        async (send, read) => {
          await send("publishKept");
          expect((await read()).roomKept).toBe(UNTOUCHED);
          await send("move");
          await send("publishKept");
          expect((await read()).roomKept).toBe("kept:");
        },
      );
    });
  });
});
