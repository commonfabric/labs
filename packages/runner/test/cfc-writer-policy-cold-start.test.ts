import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { runtimePresets } from "../src/runtime-presets.ts";
import { recordReplayedArgumentSlots } from "../src/cfc/reference-initialization.ts";
import { parseLink } from "../src/link-utils.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { recomposeSchema } from "../src/schema-decompose.ts";
import { lookupSchemaDocument } from "../src/schema-registry.ts";
import type { JSONSchema } from "../src/builder/types.ts";

// A writer policy says which handler may modify a path, from any runtime. A
// runtime that starts a piece it did not create replays the setup of the
// sub-pieces its pattern composes, and the replay re-stages each argument
// document with the bytes it already holds: the writer-policied inputs among
// them, with whatever their named handler has put there since. That
// re-stage modifies nothing. Refusing it would refuse the piece-start
// commit, which tears the started graph down in every runtime but the
// creator's. It is admitted without admitting anything else: a write from
// another handler that changes a guarded byte is refused, in either runtime.

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
        const empty = runtime.edit();
        source.withTx(empty).key("entries").set([]);
        expect((await empty.commit()).error?.message).toContain(
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

  it("refuses pattern code rewriting a guarded field with its own bytes", async () => {
    // What admits the replay is the runtime's record of the slots it carries
    // over, not the absence of a change: pattern code setting a whole
    // document, guarded fields included, still needs their writer, even
    // where it leaves them byte for byte as they were.
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
      expect((await rewrite.commit()).error?.message).toContain(
        "writeAuthorizedBy",
      );

      const forge = creator.edit();
      argument.withTx(forge).set({
        ...argument.withTx(forge).get(),
        frozen: { seat: 9, digest: "x" },
      });
      expect((await forge.commit()).error?.message).toContain(
        "writeAuthorizedBy",
      );

      await creator.idle();
      expect(argument.get().topic).toBe("");
      expect(argument.get().entries.map((entry) => entry.seat)).toEqual([1]);
      expect(argument.get().frozen.digest).toBe("first");
    } finally {
      await creator.dispose();
    }
  });

  describe("a transaction carrying the replay's record of its slots", () => {
    // The runtime's record of the slots a replay carries over is what makes a
    // refusal there a candidate for deferral, never what admits it: the
    // commit still proves the transaction leaves each guarded slot as it
    // found it. These tests carry that record into transactions that change
    // a guarded slot, write authoritatively or relabel, and each is refused;
    // one that changes only an unguarded slot is admitted.
    const replayingTx = async (runtime: Runtime, name: string) => {
      await storePiece(runtime, name);
      const cell = runtime.getCell<Piece>(space, name);
      await cell.sync();
      const argument = cell.key("room").resolveAsCell().getArgumentCell<
        Room
      >()!;
      const tx = runtime.edit();
      recordReplayedArgumentSlots(
        tx,
        argument.getAsNormalizedFullLink(),
        {},
        argument.withTx(tx).getRaw(),
      );
      return { argument, tx };
    };

    it("refuses one that changes a guarded byte", async () => {
      const runtime = newRuntime();
      try {
        const { argument, tx } = await replayingTx(
          runtime,
          "writer-policy-replay-changes",
        );
        argument.withTx(tx).key("frozen").set({ seat: 0, digest: "forged" });
        expect((await tx.commit()).error?.message).toContain(
          "writeAuthorizedBy",
        );
        await runtime.idle();
        expect(argument.get().frozen.digest).toBe("first");
      } finally {
        await runtime.dispose();
      }
    });

    it("admits a whole-document write that leaves each guarded slot as it was", async () => {
      // The replay writes the argument document whole, over slots a caller
      // names and slots it carries over. A slot no writer policy guards may
      // change; the guarded ones are compared inside the whole write.
      const runtime = newRuntime();
      try {
        const { argument, tx } = await replayingTx(
          runtime,
          "writer-policy-replay-whole",
        );
        argument.withTx(tx).set({
          ...argument.withTx(tx).get(),
          topic: "lunch",
        });
        expect((await tx.commit()).error).toBeUndefined();
        await runtime.idle();
        expect(argument.get().topic).toBe("lunch");
        expect(argument.get().frozen.digest).toBe("first");
      } finally {
        await runtime.dispose();
      }
    });

    it("refuses a whole-document write that changes a guarded slot inside it", async () => {
      const runtime = newRuntime();
      try {
        const { argument, tx } = await replayingTx(
          runtime,
          "writer-policy-replay-whole-forge",
        );
        argument.withTx(tx).set({
          ...argument.withTx(tx).get(),
          frozen: { seat: 0, digest: "forged" },
        });
        expect((await tx.commit()).error?.message).toContain(
          "writeAuthorizedBy",
        );
        await runtime.idle();
        expect(argument.get().frozen.digest).toBe("first");
      } finally {
        await runtime.dispose();
      }
    });

    it("refuses one that replaces the document above the guarded slots", async () => {
      // A write whose shape changes above a guarded slot records its detail
      // there, not at the slot, so the slot is compared inside it.
      const runtime = newRuntime();
      try {
        const { argument, tx } = await replayingTx(
          runtime,
          "writer-policy-replay-root",
        );
        (argument.withTx(tx) as unknown as { set(value: unknown): void }).set(
          "replaced",
        );
        expect((await tx.commit()).error?.message).toContain(
          "writeAuthorizedBy",
        );
        await runtime.idle();
        expect(argument.get().frozen.digest).toBe("first");
      } finally {
        await runtime.dispose();
      }
    });

    it("refuses an authoritative one, which commits the document whole", async () => {
      // An authoritative commit writes every document it touched over what
      // the store holds by then, so that it saw the bytes unchanged says
      // nothing about what it leaves behind.
      const runtime = newRuntime();
      try {
        const { argument, tx } = await replayingTx(
          runtime,
          "writer-policy-replay-authoritative",
        );
        // The extended transaction marks itself only where it serves a seal
        // destination; the mode itself lives on the transaction it wraps.
        expect(tx.tx.markAuthoritativeWrites).toBeDefined();
        tx.tx.markAuthoritativeWrites!();
        expect(tx.isAuthoritativeWrites?.()).toBe(true);
        const frozen = argument.withTx(tx).key("frozen");
        frozen.set({ ...frozen.get() });
        expect((await tx.commit()).error?.message).toContain(
          "writeAuthorizedBy",
        );
      } finally {
        await runtime.dispose();
      }
    });

    it("refuses one that would store another label at the slot", async () => {
      // Unchanged bytes are half of modifying nothing: a write that would
      // store a different policy at the guarded slot, byte for byte the
      // same value beneath it, still needs the slot's writer.
      const runtime = newRuntime();
      try {
        const { argument, tx } = await replayingTx(
          runtime,
          "writer-policy-replay-relabels",
        );
        // The schema the replay writes with: the one the piece's argument
        // link carries.
        const room = runtime.getCell<Piece>(
          space,
          "writer-policy-replay-relabels",
        ).key("room").resolveAsCell();
        const link = parseLink(room.getMetaRaw("argument"));
        const schema = recomposeSchema(
          (link?.schema as { $ref: string }).$ref,
          lookupSchemaDocument,
        ) as Record<string, unknown>;
        expect(schema.properties).toBeDefined();
        const storedEnvelope = () => {
          const read = runtime.edit();
          const { space, id, scope } = argument.getAsNormalizedFullLink();
          try {
            return readStoredCfcMetadata(read, { space, id, scope });
          } finally {
            read.abort();
          }
        };
        const before = storedEnvelope();
        expect(before).toBeDefined();
        const properties = schema.properties as Record<string, unknown>;
        const frozenIfc = (properties.frozen as {
          ifc: { confidentiality?: unknown[] };
        }).ifc;
        const relabeled = {
          ...schema,
          properties: {
            ...properties,
            frozen: {
              ...(properties.frozen as Record<string, unknown>),
              ifc: {
                ...frozenIfc,
                confidentiality: [
                  ...(frozenIfc.confidentiality ?? []),
                  "replay-secret",
                ],
              },
            },
          },
        };
        const frozen = argument.asSchema(relabeled as JSONSchema).withTx(tx)
          .key("frozen");
        frozen.set({ ...(frozen.get() as object) } as never);
        expect((await tx.commit()).error?.message).toContain(
          "writeAuthorizedBy",
        );
        await runtime.idle();
        expect(storedEnvelope()).toEqual(before);
      } finally {
        await runtime.dispose();
      }
    });
  });
});
