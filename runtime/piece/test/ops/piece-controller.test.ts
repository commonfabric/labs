import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  PIECE_SOURCE_MOVED,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import {
  cfcLabelViewForCell,
  readStoredCfcMetadata,
} from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../../runner/test/cfc-seed-envelope.ts";
import {
  type PieceController,
  PieceSourceChangedError,
  pinnedSourceMoved,
} from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece controller edit");

/** A counter document; `n` is what the overlapping edits contend for. */
function counterProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ n?: number }>(({ n }) => ({",
        "  [NAME]: 'Counter',",
        "  n,",
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

/**
 * A piece whose input holds a `tally`, typed `tallyType`, beside a `note` of
 * its own.
 */
function tallyProgram(tallyType: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern, Writable } from 'commonfabric';",
        "interface Counter { count?: number }",
        "interface LabeledCounter { count?: number; label: string }",
        `interface Args { tally?: ${tallyType}; note?: string }`,
        "export default pattern<Args>(() => ({ [NAME]: 'Tally' }));",
        "",
      ].join("\n"),
    }],
  };
}

/** The confidentiality atom naming `owner`'s personal space. */
const personalSpaceOf = (owner: string) => ({
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner,
});

describe("piece-controller", () => {
  describe("edit()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let piece: PieceController;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      pieces = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: await runtime.createSpace(),
        }),
        runtime,
      );
      await pieces.synced();
      piece = await pieces.create(counterProgram(), { input: { n: 0 } });
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    async function readN(): Promise<unknown> {
      const cell = await piece.input.getCell();
      await cell.pull();
      return (cell.getRaw({ lastNode: "value" }) as { n?: unknown }).n;
    }

    it("computes each overlapping edit from the then-current document", async () => {
      // Overlapping edits on one replica serialize rather than conflict
      // (an immediate transaction holds the local order), so the retry
      // path stays with editWithRetry's own contract for replica-behind
      // conflicts; what this proves is the property repair rests on —
      // every produce call answers for the document its commit sees, so
      // neither of two contending updates is lost.
      let runs = 0;
      const bump = () =>
        piece.input.edit((stored) => {
          runs += 1;
          const doc = stored as { n?: number };
          return { value: { n: (doc.n ?? 0) + 1 } };
        });
      await Promise.all([bump(), bump()]);
      expect(await readN()).toBe(2);
      expect(runs).toBe(2);
    });

    it("returns wrote: false and writes nothing for a no-write answer", async () => {
      const result = await piece.input.edit(() => undefined);
      expect(result).toEqual({ wrote: false });
      expect(await readN()).toBe(0);
    });

    it("hands produce the stored value and writes its answer", async () => {
      let seen: unknown;
      const result = await piece.input.edit((stored) => {
        seen = (stored as { n?: unknown }).n;
        return { value: { n: 7 } };
      });
      expect(result).toEqual({ wrote: true });
      expect(seen).toBe(0);
      expect(await readN()).toBe(7);
    });
  });

  describe("input.set() beside a stored link", () => {
    // A write to one input field validates the whole input it lands in. A
    // `Writable` slot holding a link is a handle, valid as a link whatever it
    // reaches, so the write neither judges nor reads what it reaches. Not
    // reading it keeps the linked document's labels off the field written.
    // A plain-typed slot's linked content is part of the input's value and is
    // still judged.

    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let space: string;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      space = await runtime.createSpace();
      pieces = new PiecesController(
        createSession({ identity: signer, spaceDid: space as never }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    /** A counter document holding `value`, with `count` labeled if asked. */
    async function counterHolding(
      name: string,
      value: Record<string, unknown>,
      labeled: boolean,
    ) {
      const counter = runtime.getCell<Record<string, unknown>>(
        space as never,
        name,
      );
      const id = counter.getAsNormalizedFullLink().id;
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space as never);
      seedStoredEnvelope(seed, {
        space: space as never,
        scope: "space",
        id,
        path: [],
      }, {
        value: value as never,
        ...(labeled
          ? {
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [{
                  path: ["count"],
                  label: { confidentiality: [personalSpaceOf(space)] },
                }],
              },
            },
          }
          : {}),
      });
      expect((await seed.commit().settled).error).toBeUndefined();
      return counter;
    }

    /** The confidentiality atoms stored for the input at `path`. */
    async function inputConfidentialityAt(
      piece: PieceController,
      path: string[],
    ): Promise<unknown[]> {
      const input = await piece.input.getCell();
      const link = input.getAsNormalizedFullLink();
      const entries = readStoredCfcMetadata(runtime.readTx(), link)?.labelMap
        .entries ?? [];
      return entries
        .filter((entry) =>
          entry.path.length === path.length &&
          entry.path.every((segment, index) => segment === path[index])
        )
        .flatMap((entry) => entry.label.confidentiality ?? []);
    }

    /**
     * The confidentiality atoms a read of the input at `path` reaches,
     * through whatever links the path lands on or crosses.
     */
    async function confidentialityReachedAt(
      piece: PieceController,
      path: string[],
    ): Promise<unknown[]> {
      const view = cfcLabelViewForCell(await piece.input.getCell(path));
      return (view?.entries ?? [])
        .filter((entry) => entry.path.length === 0)
        .flatMap((entry) => entry.label.confidentiality ?? []);
    }

    it("leaves the linked document's confidentiality off the field it writes", async () => {
      const counter = await counterHolding("labeled", { count: 3 }, true);
      const piece = await pieces.create(
        tallyProgram("Writable<Counter>"),
        { input: { tally: counter } },
      );

      await piece.input.set("hello", ["note"]);

      expect(await piece.input.get(["note"])).toBe("hello");
      expect(
        await inputConfidentialityAt(piece, ["note"]),
        "the write read the counter through the handle slot, and its " +
          "transaction carried the counter's label onto the written field",
      ).not.toContainEqual(personalSpaceOf(space));
      // The counter's label stays with the counter: the input document
      // stores none of it where it links the counter, and a read through
      // that link reaches it. So the atom the written field must not carry
      // is one a write that read through the handle slot would have carried.
      expect(await inputConfidentialityAt(piece, ["tally", "count"]))
        .toEqual([]);
      expect(await confidentialityReachedAt(piece, ["tally", "count"]))
        .toContainEqual(personalSpaceOf(space));
    });

    it("writes beside a link whose value the handle's schema refuses", async () => {
      const counter = await counterHolding(
        "wrong-type",
        { count: "seven" },
        false,
      );
      const piece = await pieces.create(
        tallyProgram("Writable<Counter>"),
        { input: { tally: counter } },
      );

      await piece.input.set("hello", ["note"]);

      expect(await piece.input.get(["note"])).toBe("hello");
    });

    it("still refuses a write beside a link that reaches a value of another type", async () => {
      const counter = runtime.getCell<unknown>(space as never, "other-type");
      const { error } = await runtime.editWithRetry((tx) => {
        counter.withTx(tx).set("seven");
      });
      expect(error).toBeUndefined();
      const piece = await pieces.create(
        tallyProgram("Writable<Counter>"),
        { input: { tally: counter } },
      );

      await expect(piece.input.set("hello", ["note"])).rejects.toThrow(
        "tally: value does not match type object",
      );
    });

    it("writes through a handle slot into the document its link reaches", async () => {
      // The write path's own positions stay materialized: what is written
      // there lands in the linked document, which is judged as written.
      // A piece's input is a destination with a durable contract, which a
      // write through a link requires. The required `label` beside the
      // written `count` is what the write's validation has to see.
      const owner = await pieces.create(tallyProgram("LabeledCounter"), {
        input: { tally: { label: "laps" } },
      });
      const counter = (await owner.input.getCell()).key("tally");
      const piece = await pieces.create(
        tallyProgram("Writable<LabeledCounter>"),
        { input: { tally: counter } },
      );

      await piece.input.set(5, ["tally", "count"]);

      expect(await owner.input.get(["tally"])).toEqual({
        label: "laps",
        count: 5,
      });
      await expect(piece.input.set("five", ["tally", "count"])).rejects
        .toThrow("count: value does not match type number");
    });

    it("still refuses a write beside a plain-typed link to that value", async () => {
      const counter = await counterHolding(
        "wrong-type-plain",
        { count: "seven" },
        false,
      );
      const piece = await pieces.create(
        tallyProgram("Counter"),
        { input: { tally: counter } },
      );

      await expect(piece.input.set("hello", ["note"])).rejects.toThrow(
        "count: value does not match type number",
      );
    });
  });

  describe("pinnedSourceMoved()", () => {
    const pinned = { identity: "idA", symbol: "Member" };

    it("translates the transition layer's stale-source failure for a pinned write", () => {
      // The window's second half: this guard fires inside the transaction
      // that commits, and throws the runtime's generic error. A pinned
      // caller has to read it as a row to refuse, not as an operational
      // failure of unknown state.
      const translated = pinnedSourceMoved(
        new Error(PIECE_SOURCE_MOVED),
        pinned,
      );
      expect(translated).toBeInstanceOf(PieceSourceChangedError);
      expect((translated as Error).message).toContain("moved off idA#Member");
    });

    it("leaves the same failure alone when the caller pinned nothing", () => {
      // Without a pin there is no proved reference to name, and the caller
      // asked for no such guarantee.
      const error = new Error(PIECE_SOURCE_MOVED);
      expect(pinnedSourceMoved(error, undefined)).toBe(error);
    });

    it("passes every other failure through untouched", () => {
      // Translating on anything but this message would turn real breakage
      // into a refusal and hide it.
      const error = new Error("the runtime would not shut down");
      expect(pinnedSourceMoved(error, pinned)).toBe(error);
    });
  });
});
